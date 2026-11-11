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

/** Whether the whole command, as the prompt shows it, fits in one prompt. */
function promptFits(command) {
  const shown = visibleText(command);
  return shown.length <= PROMPT_COMMAND_MAX && shown.split('\n').length <= PROMPT_COMMAND_LINES;
}

/**
 * The prompt for one request. `place` is where it would start (placeFor). The default and cancel
 * button is Decline. A request that starts outside the app's folder shows the full path and can
 * only be run once. Throws for a command that does not fit (promptFits): those are never asked about.
 */
function approvalView({ request, computerName, place }) {
  if (!promptFits(request.command)) throw new Error(TOO_LONG);
  const command = visibleText(request.command).split('\n').map(line => COMMAND_LINE_MARK + line);
  const unusual = [
    ...(unusualCharacters(request.command).length ? [`In the command: ${unusualCharacters(request.command).join(', ')}`] : []),
    ...(unusualCharacters(place.path).length ? [`In the folder: ${unusualCharacters(place.path).join(', ')}`] : []),
  ];
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
    'An approved command runs as you, with your permissions on this computer.',
  ].join('\n');
  const choices = place.outside ? ['decline', 'once'] : ['decline', 'once', 'allow', 'folder'];
  const names = { decline: 'Decline', once: 'Run once', allow: 'Allow for this message', folder: 'Choose folder…' };
  return {
    title: 'Use My Computer',
    message: `Run a command on ${visibleLine(computerName)}?`,
    detail,
    buttons: choices.map(choice => names[choice]),
    choices,
    defaultId: 0,
    cancelId: 0,
  };
}

/**
 * The prompt loop for one request, built on the platform dialog. `showMessageBox(view, signal)`
 * resolves with `{ response }`; `chooseFolder(app)` lets the person pick that app's folder, after
 * which the prompt is shown again with the new folder. Resolves 'once', 'allow' or 'decline'.
 */
function createDialogAsk({ showMessageBox, chooseFolder, computerName, attention = () => {} }) {
  return async function ask(request, { signal, describe }) {
    if (!promptFits(request.command)) return 'decline';
    attention(request);
    for (;;) {
      if (signal?.aborted) return 'decline';
      const view = approvalView({ request, computerName: computerName(), place: describe(request) });
      const { response } = await showMessageBox(view, signal);
      if (signal?.aborted) return 'decline';
      const choice = view.choices[response] ?? 'decline';
      if (choice !== 'folder') return choice;
      try { await chooseFolder(request.app); } catch { /* the prompt comes back either way */ }
    }
  };
}

/**
 * The queue of requests waiting for the person.
 * - `ask(request, { signal })` shows one prompt and resolves 'once', 'allow' or 'decline'.
 * - `onAnswer(request, choice)` runs as soon as the person answers, before any other request is
 *   looked at, so "Allow for this message" is in place for the requests behind it.
 * - `precheck(request)` returns 'covered' when an earlier answer already covers the request; it
 *   then skips its prompt, wherever it is in the queue.
 * `enqueue` resolves with 'once', 'allow', 'decline', 'covered', 'expired', or the reason passed to
 * `cancel`. Only one prompt is ever open: the next waits until the open one has really closed.
 */
function createApprovalQueue({ ask, precheck = () => undefined, onAnswer = () => {}, clock, onChange = () => {} }) {
  const waiting = [];
  let open;

  function settle(item, decision) {
    if (item.settled) return;
    item.settled = true;
    clock.clearTimeout(item.timer);
    const at = waiting.indexOf(item);
    if (at >= 0) waiting.splice(at, 1);
    if (open === item) item.controller.abort();
    item.resolve(decision);
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
      .then(choice => ['once', 'allow', 'decline'].includes(choice) ? choice : 'decline', () => 'decline')
      .then(choice => {
        if (!item.settled) {
          try { onAnswer(item.request, choice); } catch { /* the answer still stands */ }
          settle(item, choice);
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
        item.timer = clock.setTimeout(() => settle(item, 'expired'), Math.min(2_000_000_000, Math.max(0, deadline - clock.now())));
        waiting.push(item);
        onChange();
        pump();
      });
    },
    /** Drops a waiting request or closes its open prompt. Returns whether it was here. */
    cancel(id, reason = 'cancelled') {
      const item = open?.request.id === id && !open.settled ? open : waiting.find(entry => entry.request.id === id);
      if (!item) return false;
      settle(item, reason);
      return true;
    },
    cancelAll(reason = 'cancelled') {
      for (const item of [...waiting]) settle(item, reason);
      if (open && !open.settled) settle(open, reason);
    },
    /** Re-checks waiting requests, for when an answer may now cover them. */
    recheck() { pump(); },
    openId() { return open && !open.settled ? open.request.id : undefined; },
    waitingIds() { return waiting.map(item => item.request.id); },
  };
}

module.exports = {
  PROMPT_COMMAND_MAX, PROMPT_COMMAND_LINES, COMMAND_LINE_MARK, TOO_LONG,
  promptFits, approvalView, createDialogAsk, createApprovalQueue,
};
