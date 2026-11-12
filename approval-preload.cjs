const { ipcRenderer } = require('electron');

// The Use My Computer prompt: renders one request the main process sends, and sends back the
// person's answer for that request only (a nonce ties the two together). The page itself runs no
// script; this preload fills it with textContent only, so nothing 1904 or the agent wrote is ever
// parsed as HTML. Texts arrive already spelled out (computer-approval.cjs approvalView).
//
// Run stays disabled until the window has been in front for a moment, so a prompt that opens under
// a key press or click is never approved by it, and until the whole command has been in view. The
// main process applies the same delay to every answer but Decline.

const ARM_MS = 900;

let current;
let shownAt = 0;
let focusedAt = 0;
let armTimer;
let seenEnd = false;

const $ = id => document.getElementById(id);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function armed() {
  return Boolean(current) && document.hasFocus() && Date.now() - Math.max(shownAt, focusedAt) >= ARM_MS && seenEnd;
}

function refreshRun() {
  clearTimeout(armTimer);
  const run = $('run');
  run.disabled = !armed();
  $('scroll-hint').hidden = seenEnd;
  if (current && !run.disabled) return;
  if (current && document.hasFocus() && seenEnd) {
    armTimer = setTimeout(refreshRun, Math.max(50, ARM_MS - (Date.now() - Math.max(shownAt, focusedAt))));
  }
}

function checkScrolled() {
  const box = $('command');
  if (box.scrollHeight - box.clientHeight - box.scrollTop <= 2) seenEnd = true;
  refreshRun();
}

function answer(action) {
  if (!current) return;
  // Run, and away mode (which also runs this command), only once armed; Decline and Choose folder… any time.
  if ((action === 'run' || action === 'away') && !armed()) return;
  const scope = document.querySelector('input[name="scope"]:checked')?.value || 'once';
  const minutes = Number($('minutes')?.value);
  ipcRenderer.send('1904:approval-answer', {
    nonce: current.nonce, action, scope,
    ...(Number.isInteger(minutes) ? { minutes } : {}),
    network: !$('network-row').hidden && $('network').checked,
  });
  // The main process shows this request again (after Choose folder…) or closes the window.
  current = undefined;
  refreshRun();
}

function renderScopes(view) {
  const fieldset = $('scopes');
  fieldset.replaceChildren(node('legend', '', 'Allow'));
  fieldset.hidden = view.scopes.length < 2;
  for (const scope of view.scopes) {
    const row = node('label', 'scope');
    const input = node('input');
    input.type = 'radio';
    input.name = 'scope';
    input.value = scope.id;
    input.checked = scope.id === 'once';
    const title = node('span', 'scope-title', scope.label);
    if (scope.id === 'task') {
      const select = node('select');
      select.id = 'minutes';
      select.setAttribute('aria-label', 'How long');
      for (const option of view.minutes) {
        const item = node('option', '', option.label);
        item.value = String(option.value);
        item.selected = option.value === view.defaultMinutes;
        select.append(item);
      }
      select.addEventListener('change', () => { input.checked = true; });
      title.append(select);
    }
    row.append(input, title);
    if (scope.hint) row.append(node('span', 'scope-hint', scope.hint));
    fieldset.append(row);
  }
}

function render({ nonce, view, theme, platform, icon }) {
  current = { nonce };
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.platform = platform === 'macos' ? 'macos' : 'windows';
  if (typeof icon === 'string' && icon.startsWith('data:image/png;base64,')) $('logo').src = icon;
  document.title = view.title;
  $('heading').textContent = view.heading;
  $('fields').replaceChildren(...view.fields.flatMap(field => [node('dt', '', field.name), node('dd', 'them', field.text)]));

  const full = view.access === 'full';
  $('access').textContent = full ? 'Full access' : 'Sandboxed';
  $('access').dataset.access = view.access;
  $('command').replaceChildren(...view.command.split('\n').map(line => node('span', 'line', line)));
  $('command').scrollTop = 0;

  $('folder').hidden = view.folder.outside;
  $('outside').hidden = !view.folder.outside;
  if (view.folder.outside) {
    $('outside-path').textContent = view.folder.path;
    $('outside-root').textContent = view.folder.root;
  } else {
    $('folder-path').textContent = view.folder.path;
  }
  $('reason').hidden = !view.reason;
  $('reason').textContent = view.reason;
  $('unusual').hidden = view.unusual.length === 0;
  $('unusual-list').replaceChildren(...view.unusual.map(line => node('li', 'them', line)));
  $('notes').dataset.access = view.access;
  $('notes').replaceChildren(...view.notes.map(line => node('li', '', line)));
  $('network-row').hidden = !view.network;
  $('network').checked = false;
  renderScopes(view);
  $('away').hidden = !view.away;

  const run = $('run');
  run.textContent = view.run;
  run.dataset.access = view.access;
  shownAt = Date.now();
  seenEnd = false;
  // Decline has the focus: Enter or Space pressed by habit never runs anything.
  $('decline').focus();
  requestAnimationFrame(() => {
    checkScrolled();
    ipcRenderer.send('1904:approval-size', Math.ceil(document.querySelector('main').scrollHeight + 40 + 64));
  });
}

ipcRenderer.on('1904:approval-show', (_event, payload) => {
  if (payload && typeof payload.nonce === 'string' && payload.view) render(payload);
});

ipcRenderer.on('1904:approval-theme', (_event, theme) => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
});

window.addEventListener('focus', () => { focusedAt = Date.now(); refreshRun(); });
window.addEventListener('blur', () => refreshRun());

window.addEventListener('DOMContentLoaded', () => {
  $('run').addEventListener('click', () => answer('run'));
  $('decline').addEventListener('click', () => answer('decline'));
  $('choose-folder').addEventListener('click', () => answer('folder'));
  $('away').addEventListener('click', () => answer('away'));
  $('command').addEventListener('scroll', checkScrolled, { passive: true });
  window.addEventListener('resize', checkScrolled);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      answer('decline');
    }
  });
  ipcRenderer.send('1904:approval-ready');
});
