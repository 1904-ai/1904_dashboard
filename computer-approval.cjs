// Use My Computer: asking the person. One prompt at a time, in the order requests arrive. A request
// that is cancelled or runs out of time leaves the queue, and its prompt closes, without an answer.
// The prompt window itself is passed in (main.cjs, approval.html), so the queue, the wording and the
// answers are tested with plain Node.

const { TASK_ALLOWANCE_MINUTES, unusualCharacters, visibleLine, visibleText } = require('./computer-policy.cjs');

/** The most a prompt shows. A longer command is never asked about, so a prompt always shows all of what runs. */
const PROMPT_COMMAND_MAX = 3000;
const PROMPT_COMMAND_LINES = 60;
const TOO_LONG = '1904 Desktop did not ask: this command is too long to review in one prompt. Put it in a script file and run that, or split it.';
const FULL_ACCESS = 'This command runs without the sandbox, with access to all your files and keys.';
const NO_SANDBOX_HERE = '1904 Desktop has no sandbox on Windows yet, so every command here runs this way.';
const SANDBOXED = 'It runs in a sandbox: it can change files only in the app’s folder and can’t read your keys, your personal folders or 1904 Desktop’s data.';
/** "Allow for this task" starts at this many minutes unless the person picks another length. */
const TASK_ALLOWANCE_DEFAULT = 60;

/** Whether the whole command, as the prompt shows it, fits in one prompt. */
function promptFits(command) {
  const shown = visibleText(command);
  return shown.length <= PROMPT_COMMAND_MAX && shown.split('\n').length <= PROMPT_COMMAND_LINES;
}

function minutesText(minutes) {
  return minutes < 60 ? `${minutes} minutes` : minutes === 60 ? '1 hour' : `${minutes / 60} hours`;
}

/**
 * What the prompt shows for one request. `place` is where it would start (placeFor). `full`: the
 * command runs without the sandbox (it asked for full access, or this computer has no sandbox).
 * `away`: away mode can be offered. Every text from 1904 or the agent is spelled out (visibleText),
 * and the prompt lists the characters outside plain ASCII wherever they appear.
 *
 * What a "Run" can cover (`scopes`): only this command; the rest of this message; or everything this
 * task asks from messages sent from this computer, for a length the person picks. A command that
 * starts outside the app's folder, or that asks a Mac for full access, can only be run once.
 * Throws for a command that does not fit (promptFits): those are never asked about.
 */
function approvalView({ request, computerName, place, full = false, platform, away = false }) {
  if (!promptFits(request.command)) throw new Error(TOO_LONG);
  const unsandboxed = platform !== 'macos';
  const fields = [
    ['Task', request.task.title], ['App', request.app.name], ['Asked by', request.sender.name],
  ];
  const unusual = [
    ['the command', request.command], ['the folder', place.path], ...fields.map(([name, text]) => [`the ${name.toLowerCase()}`, text]),
    ['the agent’s reason', request.reason],
  ].flatMap(([where, text]) => {
    const found = unusualCharacters(text);
    return found.length ? [`In ${where}: ${found.join(', ')}`] : [];
  });
  const network = !full && request.network === true;
  const covers = !place.outside && (!full || unsandboxed);
  const scopes = [
    { id: 'once', label: 'Only this command' },
    ...(covers ? [
      { id: 'message', label: 'The rest of this message', hint: 'Later commands from the same message, in the same folder, run without asking. It ends when you send this task another message, or after 30 minutes.' },
      {
        id: 'task', label: 'Everything this task asks, for',
        hint: full
          ? 'Commands from messages you send this task from this computer run without asking, with full access, until the time is up. End it any time from the 1904 menu or Computer Activity.'
          : 'Sandboxed commands from messages you send this task from this computer run without asking until the time is up. Full access still asks. End it any time from the 1904 menu or Computer Activity.',
      },
    ] : []),
  ];
  return {
    title: 'Use My Computer',
    heading: `Run a command on ${visibleLine(computerName)}?`,
    fields: fields.map(([name, text]) => ({ name, text: visibleLine(text) })),
    command: visibleText(request.command),
    folder: place.outside
      ? { path: visibleLine(place.path), outside: true, root: visibleLine(place.root) }
      : { path: visibleLine(place.path), outside: false },
    reason: visibleLine(request.reason) || '',
    unusual,
    access: full ? 'full' : 'sandbox',
    notes: full
      ? [FULL_ACCESS, ...(unsandboxed ? [NO_SANDBOX_HERE] : [])]
      : [SANDBOXED, network ? 'The agent asks for internet access for this command.' : 'It has no internet access.'],
    network,
    scopes,
    minutes: TASK_ALLOWANCE_MINUTES.map(value => ({ value, label: minutesText(value) })),
    defaultMinutes: TASK_ALLOWANCE_DEFAULT,
    away: away && !full && !place.outside,
    run: full ? 'Run with full access' : 'Run',
  };
}

const SCOPE_CHOICE = { once: 'once', message: 'allow', task: 'task' };

/**
 * The prompt loop for one request, built on the prompt window.
 * - `showPrompt(view, signal)` resolves the person's answer: `{ action: 'run' | 'decline' | 'folder' | 'away',
 *   scope, minutes, network }`. Anything else counts as Decline.
 * - `closePrompt()` closes the window once this request is answered or gone.
 * - `chooseFolder(app)` lets the person pick that app's folder; the prompt then shows the new folder.
 * - `confirmFull(request)` confirms full access where the computer can (Touch ID); true elsewhere.
 * - `startAway(request)` (from the options) starts away mode for the request's task; true when it did.
 * Resolves `{ choice, network, minutes }`: choice 'once', 'allow', 'task', 'away' or 'decline'; network
 * when the person allowed internet access; minutes for 'task'.
 */
function createPromptAsk({ showPrompt, closePrompt = () => {}, chooseFolder, computerName, attention = () => {}, confirmFull = async () => true }) {
  return async function ask(request, { signal, describe, full = false, platform, startAway }) {
    const decline = { choice: 'decline', network: false };
    if (!promptFits(request.command)) return decline;
    attention(request);
    try {
      for (;;) {
        if (signal?.aborted) return decline;
        const view = approvalView({ request, computerName: computerName(), place: describe(request), full, platform, away: typeof startAway === 'function' });
        const answer = await showPrompt(view, signal);
        if (signal?.aborted) return decline;
        if (answer?.action === 'folder') {
          try { await chooseFolder(request.app); } catch { /* the prompt shows again either way */ }
          continue;
        }
        if (answer?.action === 'away' && view.away) {
          let started = false;
          try { started = await startAway(request); } catch { /* the prompt shows again */ }
          if (signal?.aborted) return decline;
          if (started) return { choice: 'away', network: false };
          continue;
        }
        if (answer?.action !== 'run') return decline;
        const scope = view.scopes.some(entry => entry.id === answer.scope) ? answer.scope : 'once';
        if (full) {
          let confirmed = false;
          try { confirmed = await confirmFull(request); } catch { confirmed = false; }
          if (signal?.aborted || !confirmed) return decline;
        }
        const minutes = view.minutes.some(entry => entry.value === answer.minutes) ? answer.minutes : view.defaultMinutes;
        return { choice: SCOPE_CHOICE[scope], network: view.network && answer.network === true, ...(scope === 'task' ? { minutes } : {}) };
      }
    } finally {
      try { closePrompt(); } catch { /* already closed */ }
    }
  };
}

const ANSWERS = ['once', 'allow', 'task', 'away', 'decline'];

/**
 * The queue of requests waiting for the person.
 * - `ask(request, { signal })` shows one prompt and resolves `{ choice, network, minutes }`.
 * - `onAnswer(request, answer)` runs as soon as the person answers, before any other request is
 *   looked at, so an allowance or away mode is in place for the requests behind it.
 * - `precheck(request)` returns a decision (`{ decision: 'covered' | 'task-covered' | 'away', network }`)
 *   when an earlier answer already covers the request; it then skips its prompt, wherever it is in the queue.
 * `enqueue` resolves with `{ decision, network }`: decision 'once', 'allow', 'task', 'away', 'decline',
 * 'covered', 'task-covered', 'expired', or the reason passed to `cancel`. Only one prompt is ever open:
 * the next waits until the open one has really closed.
 */
function createApprovalQueue({ ask, precheck = () => undefined, onAnswer = () => {}, clock, onChange = () => {} }) {
  const waiting = [];
  let open;

  function settle(item, result) {
    if (item.settled) return;
    item.settled = true;
    clock.clearTimeout(item.timer);
    const at = waiting.indexOf(item);
    if (at >= 0) waiting.splice(at, 1);
    if (open === item) item.controller.abort();
    item.resolve({ network: false, ...result });
    onChange();
  }

  function pump() {
    for (const item of [...waiting]) {
      const covered = precheck(item.request);
      if (covered) settle(item, covered);
    }
    if (open || !waiting.length) return;
    const item = waiting.shift();
    open = item;
    item.controller = new AbortController();
    onChange();
    Promise.resolve()
      .then(() => ask(item.request, { signal: item.controller.signal }))
      .then(answer => ANSWERS.includes(answer?.choice)
        ? { choice: answer.choice, network: answer.network === true, ...(answer.choice === 'task' ? { minutes: answer.minutes } : {}) }
        : { choice: 'decline', network: false },
      () => ({ choice: 'decline', network: false }))
      .then(answer => {
        if (!item.settled) {
          try { onAnswer(item.request, answer); } catch { /* the answer still stands */ }
          settle(item, { decision: answer.choice, network: answer.network });
        }
        if (open === item) open = undefined;
        onChange();
        pump();
      });
  }

  return {
    /** `deadline` is when the prompt closes on this computer's clock (the bridge corrects for clock skew). */
    enqueue(request, { deadline = request.expiresAt } = {}) {
      return new Promise(resolve => {
        const item = { request, resolve, settled: false };
        // Timers cannot wait longer than about 24 days; a later expiry is treated as that.
        item.timer = clock.setTimeout(() => settle(item, { decision: 'expired' }), Math.min(2_000_000_000, Math.max(0, deadline - clock.now())));
        waiting.push(item);
        onChange();
        pump();
      });
    },
    /** Drops a waiting request or closes its open prompt. Returns whether it was here. */
    cancel(id, reason = 'cancelled') {
      const item = open?.request.id === id && !open.settled ? open : waiting.find(entry => entry.request.id === id);
      if (!item) return false;
      settle(item, { decision: reason });
      return true;
    },
    cancelAll(reason = 'cancelled') {
      for (const item of [...waiting]) settle(item, { decision: reason });
      if (open && !open.settled) settle(open, { decision: reason });
    },
    /** Re-checks waiting requests, for when an answer or away mode may now cover them. */
    recheck() { pump(); },
    openId() { return open && !open.settled ? open.request.id : undefined; },
    waitingIds() { return waiting.map(item => item.request.id); },
  };
}

module.exports = {
  PROMPT_COMMAND_MAX, PROMPT_COMMAND_LINES, TOO_LONG, FULL_ACCESS, NO_SANDBOX_HERE, TASK_ALLOWANCE_DEFAULT,
  promptFits, approvalView, createPromptAsk, createApprovalQueue,
};
