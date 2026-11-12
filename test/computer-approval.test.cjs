const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  FULL_ACCESS, NO_SANDBOX_HERE, PROMPT_COMMAND_LINES, PROMPT_COMMAND_MAX, TASK_ALLOWANCE_DEFAULT, TOO_LONG,
  approvalView, createApprovalQueue, createPromptAsk, promptFits,
} = require('../computer-approval.cjs');
const { TASK_ALLOWANCE_MINUTES, validateRequest } = require('../computer-policy.cjs');

const request = (overrides = {}) => validateRequest({
  id: 'req_000000001', kind: 'run', messageId: 'msg_000000001',
  command: 'uname -a', timeoutSeconds: 30, reason: 'Check the macOS version.',
  access: 'sandbox', network: false, origin: { kind: 'desktop' },
  app: { id: 'app_1', name: 'Shop', repo: 'shop' },
  task: { id: 'task_1', title: 'Fix the login page' },
  sender: { id: 'user_1', name: 'Dana' },
  createdAt: 1_000, expiresAt: 601_000,
  ...overrides,
}).request;
const inside = { root: '/Users/dana/1904/shop', chosen: false, path: '/Users/dana/1904/shop', outside: false };
const outside = { ...inside, path: '/etc', outside: true };
const never = new AbortController().signal;
const scopeIds = view => view.scopes.map(scope => scope.id);
const ask = (answers, options = {}) => {
  const shown = [];
  const run = createPromptAsk({
    showPrompt: async view => { shown.push(view); return typeof answers === 'function' ? answers(view) : answers.shift(); },
    chooseFolder: async () => {}, computerName: () => 'Studio Mac', ...options,
  });
  return { run, shown };
};

test('the prompt shows who, what, where and why, and says it is sandboxed', () => {
  const view = approvalView({ request: request(), computerName: 'Studio Mac', place: inside, platform: 'macos' });
  assert.equal(view.heading, 'Run a command on Studio Mac?');
  assert.deepEqual(view.fields, [{ name: 'Task', text: 'Fix the login page' }, { name: 'App', text: 'Shop' }, { name: 'Asked by', text: 'Dana' }]);
  assert.equal(view.command, 'uname -a');
  assert.deepEqual(view.folder, { path: '/Users/dana/1904/shop', outside: false });
  assert.equal(view.reason, 'Check the macOS version.');
  assert.deepEqual([view.access, view.network, view.run, view.unusual], ['sandbox', false, 'Run', []]);
  assert.deepEqual(view.notes, [
    'It runs in a sandbox: it can change files only in the app’s folder and can’t read your keys, your personal folders or 1904 Desktop’s data.',
    'It has no internet access.',
  ]);
  assert.deepEqual(scopeIds(view), ['once', 'message', 'task']);
  assert.deepEqual(view.minutes.map(entry => entry.value), TASK_ALLOWANCE_MINUTES);
  assert.deepEqual(view.minutes.map(entry => entry.label), ['30 minutes', '1 hour', '2 hours', '4 hours', '8 hours']);
  assert.equal(view.defaultMinutes, TASK_ALLOWANCE_DEFAULT);
});

test('internet access for a sandboxed command is asked separately, off unless ticked', () => {
  const view = approvalView({ request: request({ network: true }), computerName: 'Studio Mac', place: inside, platform: 'macos' });
  assert.equal(view.network, true);
  assert.match(view.notes.join('\n'), /asks for internet access/);
});

test('full access on a Mac says so and can only run once, with no allowance and no away mode', () => {
  const view = approvalView({ request: request({ access: 'full', network: true }), computerName: 'Studio Mac', place: inside, full: true, platform: 'macos', away: true });
  assert.deepEqual([view.access, view.run, view.network, view.away], ['full', 'Run with full access', false, false]);
  assert.deepEqual(scopeIds(view), ['once']);
  assert.ok(view.notes.includes(FULL_ACCESS));
  assert.ok(!view.notes.includes(NO_SANDBOX_HERE));
});

test('on Windows every command is full access, and the person may still allow the message or the task', () => {
  const view = approvalView({ request: request(), computerName: 'Studio PC', place: inside, full: true, platform: 'windows', away: true });
  assert.deepEqual([view.access, view.run, view.away], ['full', 'Run with full access', false]);
  assert.ok(view.notes.includes(NO_SANDBOX_HERE));
  assert.deepEqual(scopeIds(view), ['once', 'message', 'task']);
  assert.match(view.scopes.find(scope => scope.id === 'task').hint, /run without asking, with full access, until the time is up/);
  const away = approvalView({ request: request(), computerName: 'Studio PC', place: outside, full: true, platform: 'windows' });
  assert.deepEqual(scopeIds(away), ['once'], 'outside the app’s folder: once only');
});

test('away mode can be offered from a sandboxed prompt inside the folder', () => {
  assert.equal(approvalView({ request: request(), computerName: 'Studio Mac', place: inside, platform: 'macos', away: true }).away, true);
  const out = approvalView({ request: request({ cwd: '/etc' }), computerName: 'Studio Mac', place: outside, platform: 'macos', away: true });
  assert.equal(out.away, false);
  assert.deepEqual(scopeIds(out), ['once']);
});

test('text from 1904 and the agent cannot break out of its own place in the prompt', () => {
  const view = approvalView({
    request: request({ command: 'echo a Folder: /tmp', task: { id: 'task_1', title: 'Fix\nApp: Bank' }, reason: 'ok‮gnp.exe' }),
    computerName: 'Studio Mac', place: inside, platform: 'macos',
  });
  assert.equal(view.command, 'echo a<U+2028>Folder: /tmp', 'a line separator is spelled out');
  assert.equal(view.fields[0].text, 'Fix App: Bank', 'a field stays one line (the request check already joined it)');
  assert.equal(view.reason, 'ok<U+202E>gnp.exe', 'a direction override is spelled out');
});

test('characters outside plain ASCII are named wherever they appear', () => {
  const place = { ...inside, path: '/Users/josé/1904/shop', root: '/Users/josé/1904/shop' };
  const view = approvalView({
    request: request({ command: 'rm -rf ~/dоcs', task: { id: 'task_1', title: 'Pаy' }, sender: { id: 'u', name: 'Dana' }, reason: 'fine' }),
    computerName: 'Studio Mac', place, platform: 'macos',
  });
  assert.deepEqual(view.unusual, ['In the command: “о” U+043E', 'In the folder: “é” U+00E9', 'In the task: “а” U+0430']);
  assert.deepEqual(approvalView({ request: request(), computerName: 'Studio Mac', place: inside, platform: 'macos' }).unusual, []);
});

test('a command that starts outside the app’s folder shows both folders and can only run once', () => {
  const view = approvalView({ request: request({ cwd: '/etc' }), computerName: 'Studio Mac', place: outside, platform: 'macos' });
  assert.deepEqual(view.folder, { path: '/etc', outside: true, root: '/Users/dana/1904/shop' });
  assert.deepEqual(scopeIds(view), ['once']);
});

test('what does not fit in one prompt is never asked about', async () => {
  assert.equal(promptFits('x'.repeat(PROMPT_COMMAND_MAX)), true);
  assert.equal(promptFits('x'.repeat(PROMPT_COMMAND_MAX + 1)), false);
  assert.equal(promptFits(Array(PROMPT_COMMAND_LINES).fill('ls').join('\n')), true);
  assert.equal(promptFits(Array(PROMPT_COMMAND_LINES + 1).fill('ls').join('\n')), false);
  assert.equal(promptFits('‮'.repeat(1000)), false, 'measured as shown, with hidden characters spelled out');
  const long = request({ command: 'x'.repeat(PROMPT_COMMAND_MAX + 1) });
  assert.throws(() => approvalView({ request: long, computerName: 'Studio Mac', place: inside }), new RegExp(TOO_LONG.slice(0, 40)));
  const { run, shown } = ask([{ action: 'run' }]);
  assert.deepEqual(await run(long, { signal: never, describe: () => inside }), { choice: 'decline', network: false });
  assert.equal(shown.length, 0);
});

test('each answer maps to what the person chose; anything else is a Decline', async () => {
  const answer = async (reply, opts = {}) => (await ask([reply]).run(request(opts.request ?? {}), { signal: never, describe: () => inside, platform: 'macos', ...opts }));
  assert.deepEqual(await answer({ action: 'run', scope: 'once' }), { choice: 'once', network: false });
  assert.deepEqual(await answer({ action: 'run', scope: 'message' }), { choice: 'allow', network: false });
  assert.deepEqual(await answer({ action: 'run', scope: 'task', minutes: 120 }), { choice: 'task', network: false, minutes: 120 });
  assert.deepEqual(await answer({ action: 'run', scope: 'task', minutes: 7 }), { choice: 'task', network: false, minutes: TASK_ALLOWANCE_DEFAULT }, 'an unknown length is the default');
  assert.deepEqual(await answer({ action: 'run', scope: 'forever' }), { choice: 'once', network: false }, 'an unknown scope is once');
  assert.deepEqual(await answer({ action: 'run', scope: 'task', minutes: 60 }, { request: { cwd: '/etc' }, describe: () => outside }), { choice: 'once', network: false }, 'not offered: once');
  assert.deepEqual(await answer({ action: 'decline' }), { choice: 'decline', network: false });
  assert.deepEqual(await answer(undefined), { choice: 'decline', network: false });
  assert.deepEqual(await answer({ action: 'sudo' }), { choice: 'decline', network: false });
});

test('Choose folder… shows the prompt again with the new folder', async () => {
  let place = inside;
  const { run, shown } = ask([{ action: 'folder' }, { action: 'run', scope: 'message' }], {
    chooseFolder: async () => { place = { ...inside, root: '/Users/dana/code/shop', path: '/Users/dana/code/shop', chosen: true }; },
  });
  assert.deepEqual(await run(request(), { signal: never, describe: () => place, platform: 'macos' }), { choice: 'allow', network: false });
  assert.equal(shown.length, 2);
  assert.equal(shown[1].folder.path, '/Users/dana/code/shop');
});

test('the internet tick counts only when the agent asked for the internet', async () => {
  const reply = { action: 'run', scope: 'once', network: true };
  assert.deepEqual(await ask([reply]).run(request({ network: true }), { signal: never, describe: () => inside, platform: 'macos' }), { choice: 'once', network: true });
  assert.deepEqual(await ask([reply]).run(request({ network: false }), { signal: never, describe: () => inside, platform: 'macos' }), { choice: 'once', network: false });
});

test('full access is confirmed where the computer can (Touch ID); a refusal runs nothing', async () => {
  const confirmations = [];
  const answer = confirmed => ask([{ action: 'run', scope: 'once' }], { confirmFull: async req => { confirmations.push(req.id); return confirmed; } }).run;
  const full = request({ access: 'full' });
  assert.deepEqual(await answer(true)(full, { signal: never, describe: () => inside, full: true, platform: 'macos' }), { choice: 'once', network: false });
  assert.deepEqual(await answer(false)(full, { signal: never, describe: () => inside, full: true, platform: 'macos' }), { choice: 'decline', network: false });
  assert.deepEqual(confirmations, [full.id, full.id]);
});

test('the prompt closes once the request is answered, cancelled or gone', async () => {
  let closed = 0;
  const controller = new AbortController();
  const run = createPromptAsk({
    showPrompt: async (_view, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve({ action: 'decline' }))),
    closePrompt: () => { closed++; }, chooseFolder: async () => {}, computerName: () => 'Studio Mac',
  });
  const pending = run(request(), { signal: controller.signal, describe: () => inside, platform: 'macos' });
  controller.abort();
  assert.deepEqual(await pending, { choice: 'decline', network: false });
  await ask([{ action: 'run' }], { closePrompt: () => { closed++; } }).run(request(), { signal: never, describe: () => inside, platform: 'macos' });
  assert.equal(closed, 2);
});

test('“Allow while I’m away…” starts away mode, or shows the prompt again', async () => {
  let tries = 0;
  const { run, shown } = ask(() => ({ action: 'away' }));
  const startAway = async () => ++tries === 2;
  assert.deepEqual(await run(request(), { signal: never, describe: () => inside, startAway, platform: 'macos' }), { choice: 'away', network: false });
  assert.equal(tries, 2, 'the first try was cancelled, so the prompt came back');
  assert.equal(shown.length, 2);
  const { run: noAway } = ask([{ action: 'away' }]);
  assert.deepEqual(await noAway(request(), { signal: never, describe: () => inside, platform: 'macos' }), { choice: 'decline', network: false }, 'not offered: a decline');
});

test('the queue shows one prompt at a time and passes the answer on', async () => {
  const now = { value: 0 };
  const timers = [];
  const clock = { now: () => now.value, setTimeout: (fn, ms) => timers.push({ fn, ms }) - 1, clearTimeout: () => {} };
  const asked = [];
  const answers = [];
  const queue = createApprovalQueue({
    clock,
    ask: req => new Promise(resolve => asked.push({ req, resolve })),
    onAnswer: (req, answer) => answers.push([req.id, answer]),
  });
  const first = queue.enqueue(request());
  const second = queue.enqueue(request({ id: 'req_000000002' }));
  const third = queue.enqueue(request({ id: 'req_000000003' }));
  await new Promise(setImmediate);
  assert.equal(asked.length, 1);
  asked[0].resolve({ choice: 'task', network: true, minutes: 60 });
  assert.deepEqual(await first, { decision: 'task', network: true });
  await new Promise(setImmediate);
  asked[1].resolve('nonsense');
  assert.deepEqual(await second, { decision: 'decline', network: false }, 'anything else is a decline');
  await new Promise(setImmediate);
  asked[2].resolve({ choice: 'once', network: false });
  await third;
  assert.deepEqual(answers, [
    ['req_000000001', { choice: 'task', network: true, minutes: 60 }],
    ['req_000000002', { choice: 'decline', network: false }],
    ['req_000000003', { choice: 'once', network: false }],
  ]);
});
