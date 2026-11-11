// Use My Computer: asking the person. One native prompt at a time, in the order requests arrive.
// A request that is cancelled or runs out of time leaves the queue, and its prompt closes, without
// an answer. The dialog itself is passed in, so the queue and the wording are tested with plain Node.

const { unusualCharacters, visibleLine, visibleText } = require('./computer-policy.cjs');

/** The most a prompt shows. A longer command is never asked about, so a prompt always shows all of what runs. */
const PROMPT_COMMAND_MAX = 3000;
const PROMPT_COMMAND_LINES = 60;
/** Every line of the command starts with this, so no line of it can pass for one of the prompt's own. */
const COMMAND_LINE_MARK = '│ ';
const TOO_LONG = '1904 Desktop did not ask: this command is too long to review in one prompt. Put it in a script file and run that, or split it.';
const FULL_ACCESS = 'This command runs without the sandbox, with access to all your files and keys.';
const NO_SANDBOX_HERE = '1904 Desktop has no sandbox on Windows yet, so every command here runs this way.';
const SANDBOXED = 'It runs in a sandbox: it can change files only in the app’s folder and can’t read your keys, your personal folders or 1904 Desktop’s data.';

/** Whether the whole command, as the prompt shows it, fits in one prompt. */
function promptFits(command) {
  const shown = visibleText(command);
  return shown.length <= PROMPT_COMMAND_MAX && shown.split('\n').length <= PROMPT_COMMAND_LINES;
}

/**
 * The prompt for one request. `place` is where it would start (placeFor). The default and cancel
 * button is Decline. `full`: the command runs without the sandbox (it asked for full access, or the
 * computer has no sandbox); it can then only be run once, with a second confirmation. A request that
 * starts outside the app's folder shows the full path and can only be run once. `away`: away mode
 * can be offered. A sandboxed request that asks for the internet gets a checkbox, off by default.
 * Throws for a command that does not fit (promptFits): those are never asked about.
 */
function approvalView({ request, computerName, place, full = false, platform, away = false }) {
  if (!promptFits(request.command)) throw new Error(TOO_LONG);
  const command = visibleText(request.command).split('\n').map(line => COMMAND_LINE_MARK + line);
  const unusual = [
    ...(unusualCharacters(request.command).length ? [`In the command: ${unusualCharacters(request.command).join(', ')}`] : []),
    ...(unusualCharacters(place.path).length ? [`In the folder: ${unusualCharacters(place.path).join(', ')}`] : []),
  ];
  const network = !full && request.network === true;
  const detail = [
    `Task: ${visibleLine(request.task.title)}`,
    `App: ${visibleLine(request.app.name)}`,
    `Asked by: ${visibleLine(request.sender.name)}`,
    '',
    'Command:',
    ...command,
    '',
    ...(place.outside ? [
      'This command starts outside the app’s folder, in:',
      visibleLine(place.path),
      `The app’s folder is ${visibleLine(place.root)}.`,
    ] : [`Folder: ${visibleLine(place.path)}`]),
    ...(unusual.length ? ['', 'Check these characters. They are not plain ASCII, and some look like other letters:', ...unusual] : []),
    '',
    `The agent says: “${visibleLine(request.reason) || 'No reason given.'}”`,
    '',
    ...(full
      ? [FULL_ACCESS, ...(platform === 'windows' ? [NO_SANDBOX_HERE] : []), 'An approved command runs as you, with your permissions on this computer.']
      : [SANDBOXED, network ? 'The agent asks for internet access for this command. Tick the box below to allow it.' : 'It has no internet access.']),
  ].join('\n');
  const choices = ['decline', 'once'];
  if (!full && !place.outside) choices.push('allow');
  choices.push('folder');
  if (away && !full && !place.outside) choices.push('away');
  const names = {
    decline: 'Decline', once: full ? 'Run with full access…' : 'Run once', allow: 'Allow for this message',
    folder: 'Choose folder…', away: 'Allow while I’m away…',
  };
  return {
    title: 'Use My Computer',
    message: `Run a command on ${visibleLine(computerName)}?`,
    detail,
    buttons: choices.map(choice => names[choice]),
    choices,
    defaultId: 0,
    cancelId: 0,
    full,
    network,
    ...(network ? { checkboxLabel: 'Allow internet access for this command', checkboxChecked: false } : {}),
  };
}

/** The second question before full access, where there is no Touch ID. Cancel is the default. */
function fullAccessConfirmation(request) {
  return {
    type: 'warning', title: 'Use My Computer',
    message: 'Run this command with full access?',
    detail: `${FULL_ACCESS} It can read and change anything you can, use your keys and reach the network.\n\n` +
      visibleText(request.command).split('\n').map(line => COMMAND_LINE_MARK + line).join('\n'),
    buttons: ['Cancel', 'Run with full access'], defaultId: 0, cancelId: 0, noLink: true,
  };
}

/**
 * The prompt loop for one request, built on the platform dialog.
 * - `showMessageBox(view, signal)` resolves with `{ response, checkboxChecked }`.
 * - `chooseFolder(app)` lets the person pick that app's folder; the prompt is then shown again.
 * - `confirmFull(request)` is the second confirmation for full access (Touch ID or a second dialog).
 * - `startAway(request)` (from the options) starts away mode for the request's task; true when it did.
 * Resolves `{ choice, network }`: choice 'once', 'allow', 'away' or 'decline'; network when the person
 * ticked internet access.
 */
function createDialogAsk({ showMessageBox, chooseFolder, computerName, attention = () => {}, confirmFull = async () => false }) {
  return async function ask(request, { signal, describe, full = false, platform, startAway }) {
    const decline = { choice: 'decline', network: false };
    if (!promptFits(request.command)) return decline;
    attention(request);
    for (;;) {
      if (signal?.aborted) return decline;
      const view = approvalView({ request, computerName: computerName(), place: describe(request), full, platform, away: typeof startAway === 'function' });
      const { response, checkboxChecked } = await showMessageBox(view, signal);
      if (signal?.aborted) return decline;
      const choice = view.choices[response] ?? 'decline';
      if (choice === 'folder') {
        try { await chooseFolder(request.app); } catch { /* the prompt comes back either way */ }
        continue;
      }
      if (choice === 'away') {
        let started = false;
        try { started = await startAway(request); } catch { /* the prompt comes back */ }
        if (signal?.aborted) return decline;
        if (started) return { choice: 'away', network: false };
        continue;
      }
      if (choice === 'once' && full) {
        let confirmed = false;
        try { confirmed = await confirmFull(request); } catch { confirmed = false; }
        if (signal?.aborted || !confirmed) return decline;
      }
      return { choice, network: view.network && checkboxChecked === true };
    }
  };
}

const ANSWERS = ['once', 'allow', 'away', 'decline'];

/**
 * The queue of requests waiting for the person.
 * - `ask(request, { signal })` shows one prompt and resolves `{ choice, network }`.
 * - `onAnswer(request, answer)` runs as soon as the person answers, before any other request is
 *   looked at, so "Allow for this message" or away mode is in place for the requests behind it.
 * - `precheck(request)` returns a decision (`{ decision: 'covered' | 'away', network }`) when an
 *   earlier answer already covers the request; it then skips its prompt, wherever it is in the queue.
 * `enqueue` resolves with `{ decision, network }`: decision 'once', 'allow', 'away', 'decline',
 * 'covered', 'expired', or the reason passed to `cancel`. Only one prompt is ever open: the next
 * waits until the open one has really closed.
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
      .then(answer => ANSWERS.includes(answer?.choice) ? { choice: answer.choice, network: answer.network === true } : { choice: 'decline', network: false },
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
  PROMPT_COMMAND_MAX, PROMPT_COMMAND_LINES, COMMAND_LINE_MARK, TOO_LONG, FULL_ACCESS,
  promptFits, approvalView, fullAccessConfirmation, createDialogAsk, createApprovalQueue,
};
