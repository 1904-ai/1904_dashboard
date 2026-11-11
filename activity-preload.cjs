const { ipcRenderer } = require('electron');

// Computer Activity: renders what the main process reports. The page itself runs no script; this
// preload fills it with textContent only, so command text and output are never parsed as HTML.
// Commands, reasons and paths arrive already spelled out the way the prompt shows them.
// It can stop a running command, change an app's folder, end away mode and pause Use My Computer:
// each of those only takes power away. It cannot approve or start anything.

const OUTPUT_MAX = 64 * 1024;
const STATUS = {
  starting: 'Starting',
  running: 'Running',
  withdrawn: 'Withdrawn',
  done: 'Finished',
  declined: 'Declined',
  failed: 'Could not run',
  timeout: 'Timed out',
  cancelled: 'Stopped',
  expired: 'Expired',
};

let ready = false;
let snapshotSeq = -1;
const early = [];
const cards = new Map();

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function duration(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return 'under a second';
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

function resultLine(run) {
  const parts = [];
  if (run.status === 'done' || Number.isInteger(run.exitCode)) parts.push(Number.isInteger(run.exitCode) ? `Exit code ${run.exitCode}` : 'No exit code');
  const took = duration(run.durationMs);
  if (took && !['declined', 'expired', 'withdrawn'].includes(run.status)) parts.push(took);
  if (run.message) parts.push(run.message);
  return parts.join(' · ');
}

function approvalLine(run) {
  if (run.approval === 'once') return 'You allowed it once.';
  if (run.approval === 'allow') return 'You allowed it for this message.';
  if (run.approval === 'covered') return 'Allowed for this message, so it ran without asking again.';
  if (run.approval === 'away') return 'Ran in away mode, without asking.';
  return '';
}

function accessLine(run) {
  if (run.access === 'full') return 'Full access';
  return run.network ? 'Sandbox, with internet' : 'Sandbox';
}

function appendOutput(card, stream, text) {
  const pre = card.output;
  const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 4;
  const last = pre.lastElementChild;
  if (last && last.dataset.stream === stream) last.textContent += text;
  else {
    const span = node('span', stream === 'stderr' ? 'stderr' : '', text);
    span.dataset.stream = stream;
    pre.append(span);
  }
  card.outputLength += text.length;
  while (card.outputLength > OUTPUT_MAX && pre.firstElementChild) {
    const first = pre.firstElementChild;
    const excess = card.outputLength - OUTPUT_MAX;
    if (first.textContent.length <= excess) {
      card.outputLength -= first.textContent.length;
      first.remove();
    } else {
      first.textContent = first.textContent.slice(excess);
      card.outputLength -= excess;
    }
  }
  pre.hidden = false;
  if (atEnd) pre.scrollTop = pre.scrollHeight;
}

function createCard(run) {
  const element = node('li', 'run');
  const head = node('div', 'run-head');
  const badge = node('span', 'badge');
  const title = node('span', 'run-title');
  const meta = node('span', 'run-meta');
  const stop = node('button', '', 'Stop');
  stop.type = 'button';
  stop.addEventListener('click', () => {
    stop.disabled = true;
    ipcRenderer.send('1904:activity-stop', run.id);
  });
  const access = node('span', 'access');
  head.append(badge, title, meta, access, stop);
  const command = node('pre', 'command');
  const where = node('p', 'note');
  const reason = node('p', 'note');
  const approval = node('p', 'note');
  const output = node('pre', 'output');
  output.hidden = true;
  output.setAttribute('aria-label', 'Output');
  const result = node('p', 'result');
  element.append(head, command, where, reason, approval, output, result);
  const card = { element, badge, title, meta, access, stop, command, where, reason, approval, output, result, outputLength: 0 };
  for (const segment of run.output || []) appendOutput(card, segment.stream, segment.text);
  return card;
}

function updateCard(card, run) {
  card.element.dataset.status = run.status;
  card.badge.textContent = run.status === 'waiting' ? (run.asking ? 'Waiting for you' : 'Waiting in line') : STATUS[run.status] || run.status;
  card.title.textContent = run.task?.title || 'Task';
  card.meta.textContent = `${run.sender?.name || 'Someone'} · ${run.app?.name || 'App'}`;
  card.access.textContent = accessLine(run);
  card.access.toggleAttribute('data-full', run.access === 'full');
  card.stop.hidden = run.status !== 'running';
  if (run.status !== 'running') card.stop.disabled = false;
  card.command.textContent = run.command;
  card.where.textContent = run.outside ? `Starts outside the app’s folder, in ${run.cwd}` : `Folder: ${run.cwd}`;
  card.where.classList.toggle('outside', Boolean(run.outside));
  card.reason.textContent = run.reason ? `The agent says: “${run.reason}”` : '';
  card.reason.hidden = !run.reason;
  const approved = approvalLine(run);
  card.approval.textContent = approved;
  card.approval.hidden = !approved;
  const line = ['waiting', 'starting', 'running'].includes(run.status) ? '' : resultLine(run);
  card.result.textContent = line;
  card.result.hidden = !line;
}

function renderRuns(runs) {
  const list = document.getElementById('runs');
  const seen = new Set(runs.map(run => run.id));
  for (const [id, card] of cards) if (!seen.has(id)) { card.element.remove(); cards.delete(id); }
  // Cards that are already in place are left alone, so an output pane keeps its scroll position.
  let cursor = list.firstElementChild;
  for (const run of runs) {
    let card = cards.get(run.id);
    if (!card) {
      card = createCard(run);
      cards.set(run.id, card);
    }
    updateCard(card, run);
    if (card.element === cursor) cursor = cursor.nextElementSibling;
    else list.insertBefore(card.element, cursor);
  }
  document.getElementById('runs-empty').hidden = runs.length > 0;
}

let foldersShown;

function renderFolders(folders) {
  // Rebuilt only when something changed, so keyboard focus stays on its button.
  const key = JSON.stringify(folders);
  if (key === foldersShown) return;
  foldersShown = key;
  const list = document.getElementById('folders');
  list.replaceChildren(...folders.map(folder => {
    const item = node('li', 'folder');
    const change = node('button', '', 'Change…');
    change.type = 'button';
    change.addEventListener('click', () => { void ipcRenderer.invoke('1904:activity-folder', folder.appId, 'change'); });
    item.append(node('span', 'folder-name', folder.name), node('span', 'folder-path', folder.path),
      node('span', 'folder-kind', folder.chosen ? 'Chosen' : 'Default'), change);
    if (folder.chosen) {
      const reset = node('button', '', 'Reset');
      reset.type = 'button';
      reset.title = 'Go back to the default folder';
      reset.addEventListener('click', () => { void ipcRenderer.invoke('1904:activity-folder', folder.appId, 'reset'); });
      item.append(reset);
    }
    return item;
  }));
  document.getElementById('folders-empty').hidden = folders.length > 0;
}

let awayShown;

function renderAway(leases) {
  const key = JSON.stringify(leases);
  if (key === awayShown) return;
  awayShown = key;
  document.getElementById('away-section').hidden = leases.length === 0;
  document.getElementById('away').replaceChildren(...leases.map(lease => {
    const item = node('li', 'away');
    const until = new Date(lease.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const end = node('button', '', 'End away mode');
    end.type = 'button';
    end.addEventListener('click', () => {
      end.disabled = true;
      ipcRenderer.send('1904:activity-end-away', lease.id);
    });
    item.append(node('span', 'away-title', lease.taskTitle),
      node('span', 'away-detail', `Until ${until} · ${lease.commandsLeft} commands left · ${lease.network ? 'with internet' : 'no internet'}`), end);
    return item;
  }));
}

let historyShown;
// Older output arrives once, with the window's first full snapshot; later updates list the commands only.
const historyOutput = new Map();

// Earlier commands from this computer's own log. Rebuilt only when the list changed.
function renderHistory(history) {
  if (!history) return;
  for (const run of history) if (run.output) historyOutput.set(run.id, run.output);
  const key = JSON.stringify(history.map(run => [run.id, run.status]));
  if (key === historyShown) return;
  historyShown = key;
  document.getElementById('history-section').hidden = history.length === 0;
  document.getElementById('history').replaceChildren(...history.map(run => {
    const card = createCard({ ...run, output: [] });
    updateCard(card, run);
    card.stop.remove();
    card.output.remove();
    const output = historyOutput.get(run.id);
    if (output?.length) {
      const more = node('details');
      more.append(node('summary', '', 'Output'), card.output);
      for (const segment of output) appendOutput(card, segment.stream, segment.text);
      card.element.insertBefore(more, card.result);
    }
    return card.element;
  }));
}

function render(state) {
  if (!state) return;
  document.getElementById('connection').textContent = state.connection?.text || '';
  const pause = document.getElementById('pause');
  pause.hidden = !state.connection?.connected;
  pause.textContent = state.connection?.paused ? 'Resume' : 'Pause';
  pause.title = state.connection?.paused ? 'Take requests from 1904 again' : 'Stop taking requests from 1904 until you resume';
  pause.dataset.paused = state.connection?.paused ? 'true' : 'false';
  renderAway(state.away || []);
  renderRuns(state.runs || []);
  renderHistory(state.history);
  renderFolders(state.folders || []);
}

function applyOutput(batch) {
  if (batch.seq <= snapshotSeq) return;
  for (const chunk of batch.chunks) {
    const card = cards.get(chunk.id);
    if (card) appendOutput(card, chunk.stream, chunk.text);
  }
}

ipcRenderer.on('1904:activity-theme', (_event, theme) => {
  document.documentElement.dataset.theme = theme;
});

ipcRenderer.on('1904:activity-state', (_event, state) => {
  if (ready) render(state);
});

ipcRenderer.on('1904:activity-output', (_event, batch) => {
  if (ready) applyOutput(batch);
  else early.push(batch);
});

window.addEventListener('DOMContentLoaded', async () => {
  const pause = document.getElementById('pause');
  pause.addEventListener('click', () => ipcRenderer.send('1904:activity-pause', pause.dataset.paused !== 'true'));
  const state = await ipcRenderer.invoke('1904:activity-snapshot');
  snapshotSeq = Number.isInteger(state?.seq) ? state.seq : -1;
  ready = true;
  render(state);
  for (const batch of early.splice(0)) applyOutput(batch);
});
