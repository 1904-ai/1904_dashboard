const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { BLOCKED_WAIT_MS, createComputerBridge, NO_SANDBOX, POLL_PATH, QUICK_ANSWER_MS, RESULT_PATH, UNCONFIRMED } = require('../computer-bridge.cjs');
const { TOO_LONG } = require('../computer-approval.cjs');
const { createAwayLeases } = require('../computer-away.cjs');
const { NOT_FROM_DESKTOP } = require('../computer-policy.cjs');

const ORIGIN = 'https://1904.ai';
const START = 1_700_000_000_000;

const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };

function fakeClock() {
  let now = START;
  let next = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { timers.set(++next, { at: now + Math.max(0, Number(ms) || 0), fn }); return next; },
    clearTimeout(id) { timers.delete(id); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        timers.delete(due[0]);
        now = Math.max(now, due[1].at);
        due[1].fn();
      }
      now = end;
      await flush();
    },
  };
}

function answer(status, body, headers = {}) {
  return { status, ok: status >= 200 && status < 300, headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => body };
}

// A stand-in for 1904: polls wait until the test delivers something, results are recorded.
// `serverOffset` puts 1904's clock (its Date header) that far from this computer's.
function fake1904(clock) {
  const open = [];
  const queued = [];
  const results = [];
  const away = [];
  const state = {
    offline: false, pollStatus: 200, pollBody: {}, resultStatus: 200, runningStatus: [], polls: 0, resultCalls: 0, revokes: 0,
    serverOffset: undefined, awayStatus: 200,
  };
  const dated = () => state.serverOffset === undefined ? {} : { date: new Date(clock.now() + state.serverOffset).toUTCString() };
  async function fetch(url, init = {}) {
    const { origin, pathname } = new URL(url);
    assert.equal(origin, ORIGIN);
    assert.equal(init.credentials, 'include', 'requests carry the dashboard session');
    assert.match(init.headers.authorization, /^Bearer tok_/);
    if (pathname === POLL_PATH) {
      state.polls++;
      if (state.offline) throw new TypeError('fetch failed');
      if (state.pollStatus !== 200) return answer(state.pollStatus, state.pollBody);
      if (queued.length) return answer(200, queued.shift(), dated());
      return new Promise((resolve, reject) => {
        const entry = { resolve: body => resolve(answer(200, body, dated())) };
        open.push(entry);
        init.signal?.addEventListener('abort', () => {
          open.splice(open.indexOf(entry), 1);
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }
    if (pathname === RESULT_PATH) {
      state.resultCalls++;
      assert.equal(init.method, 'POST');
      const update = JSON.parse(init.body);
      // runningStatus: what each "running" gets in turn (a status, { status, body }, or 'offline'); 200 once the list is used up.
      const running = update.status === 'running' ? state.runningStatus.shift() ?? 200 : undefined;
      if (state.offline || running === 'offline') throw new TypeError('fetch failed');
      results.push(update);
      if (running && typeof running === 'object') return answer(running.status, running.body);
      return answer(running ?? state.resultStatus, {});
    }
    if (pathname === '/api/desktop/computer/pair' && init.method === 'DELETE') {
      state.revokes++;
      if (state.offline) throw new TypeError('fetch failed');
      return answer(200, { ok: true });
    }
    if (pathname === '/api/desktop/computer/away' && init.method === 'POST') {
      const body = JSON.parse(init.body);
      away.push(body);
      if (state.offline) throw new TypeError('fetch failed');
      if (body.action === 'end') return answer(200, { ok: true });
      if (state.awayStatus !== 200) return answer(state.awayStatus, { error: 'This task cannot use away mode.' });
      return answer(200, { lease: { id: `lease_${String(away.length).padStart(8, '0')}`, computerId: 'cmp_00000001', taskId: body.taskId, appId: body.appId,
        taskTitle: 'Fix the login page', network: body.network, maxCommands: body.maxCommands, used: 0, startedAt: clock.now(), endsAt: clock.now() + body.minutes * 60_000 } });
    }
    throw new Error(`Unexpected request to ${url}`);
  }
  function deliver(body) {
    const full = { enabled: true, computer: { id: 'cmp_00000001', name: 'Studio Mac' }, requests: [], cancelled: [], awayEnded: [], ...body };
    const waiting = open.shift();
    if (waiting) waiting.resolve(full);
    else queued.push(full);
  }
  return { fetch, deliver, results, away, state, get openPolls() { return open.length; } };
}

function fakeLink({ seenAt = START } = {}) {
  let stored = { id: 'cmp_00000001', name: 'Studio Mac', token: 'tok_test' };
  const chosen = {};
  let paused = false;
  return {
    info: () => stored && { id: stored.id, name: stored.name },
    token: async () => stored?.token,
    forget() { stored = undefined; },
    rename(name) { if (stored) stored.name = name; },
    touch() {},
    seenAt: () => seenAt,
    paused: () => paused,
    setPaused(value) { paused = value === true; },
    folders: { get: id => chosen[id], set: (id, folder) => { chosen[id] = folder; } },
  };
}

// The messages this computer "sent": every test request's message is one, unless a test says otherwise.
function fakeMessages() {
  const sent = new Set(Array.from({ length: 9 }, (_, i) => `msg_00000000${i + 1}`));
  return { sent, has: id => sent.has(id), record: id => sent.add(id), clear() { sent.clear(); } };
}

// A stand-in shell: each child is driven by the test. taskkill ends the child it names.
function fakeShell({ missing = false } = {}) {
  const children = [];
  const spawned = [];
  function spawn(file, args, options) {
    spawned.push({ file, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.done = false;
    child.finish = (code, signal = null) => {
      if (child.done) return;
      child.done = true;
      child.emit('exit', code, signal);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    };
    if (/taskkill\.exe$/.test(file)) {
      const target = children.find(candidate => String(candidate.pid) === args[1]);
      setImmediate(() => target?.finish(1));
      return child;
    }
    if (missing) {
      process.nextTick(() => {
        child.emit('error', Object.assign(new Error(`spawn ${file} ENOENT`), { code: 'ENOENT' }));
        child.emit('close', -2, null);
      });
      return child;
    }
    child.pid = 4100 + children.length;
    Object.assign(child, { file, args, options });
    children.push(child);
    return child;
  }
  return { spawn, children, spawned };
}

const PARENT_ENV = { SHELL: '/bin/zsh', HOME: '/Users/dana', USER: 'dana', GITHUB_TOKEN: 'ghp_never_in_a_command', AWS_SECRET_ACCESS_KEY: 'never' };

function setup({
  platform = 'macos', home = '/Users/dana', env = PARENT_ENV, dirs = [], missing = false, sandboxExec = true, seenAt,
  awayChoice = async () => ({ minutes: 60, network: false, maxCommands: 50 }), confirmPresence = async () => true,
  confirmLease = async () => true,
} = {}) {
  const clock = fakeClock();
  const server = fake1904(clock);
  const link = fakeLink({ seenAt });
  const messages = fakeMessages();
  const leases = createAwayLeases({ now: clock.now });
  const logged = [];
  const shell = fakeShell({ missing });
  const folders = new Set(dirs);
  const made = [];
  const temps = [];
  const removed = [];
  const killed = [];
  const prompts = [];
  const disconnected = [];
  const notices = [];
  const choices = [];
  const presence = [];
  const leaseQuestions = [];
  const bridge = createComputerBridge({
    origin: ORIGIN, fetch: server.fetch, link, messages, leases, platform, home, user: 'dana', env,
    log: { append: entry => logged.push({ ...entry }), list: limit => logged.slice().reverse().slice(0, limit) },
    userData: `${home}/Library/Application Support/1904 Desktop`, tmpRoot: '/private/tmp',
    exists: file => sandboxExec && file === '/usr/bin/sandbox-exec',
    fs: {
      mkdir: async folder => { made.push(folder); folders.add(folder); },
      stat: async folder => {
        if (folders.has(folder)) return { isDirectory: () => true };
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      mkdtemp: async prefix => { const dir = `${prefix}${temps.length + 1}`; temps.push(dir); return dir; },
      realpath: async value => value,
      rm: async value => { removed.push(value); },
    },
    resolvePath: async () => '/opt/homebrew/bin:/usr/bin:/bin',
    spawn: shell.spawn,
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      shell.children.find(child => child.pid === -pid)?.finish(null, signal);
    },
    clock,
    ask: (request, options) => new Promise(resolve => {
      const prompt = { request, options, place: options.describe(request), open: true };
      prompt.answer = (choice, network = false) => { prompt.open = false; resolve({ choice, network }); };
      prompts.push(prompt);
      options.signal.addEventListener('abort', () => { prompt.open = false; prompt.aborted = true; resolve({ choice: 'decline' }); });
    }),
    awayChoice: async task => { choices.push(task); return awayChoice(task); },
    confirmPresence: async reason => { presence.push(reason); return confirmPresence(reason); },
    confirmLease: async lease => { leaseQuestions.push(lease); return confirmLease(lease); },
    onDisconnected: reason => disconnected.push(reason),
    onNotice: notice => notices.push(notice),
  });
  const openPrompts = () => prompts.filter(prompt => prompt.open);
  const run = id => bridge.snapshot({ output: true }).runs.find(entry => entry.id === id);
  return {
    clock, server, link, messages, leases, logged, shell, folders, made, temps, removed, killed, prompts, openPrompts,
    disconnected, notices, choices, presence, leaseQuestions, bridge, run,
  };
}

let sequence = 0;
function request(overrides = {}) {
  sequence++;
  return {
    id: `req_${String(sequence).padStart(9, '0')}`, kind: 'run', messageId: 'msg_000000001',
    command: 'uname -a', timeoutSeconds: 30, reason: 'Check the macOS version.',
    access: 'sandbox', network: false, origin: { kind: 'desktop' },
    app: { id: 'app_1', name: 'Shop', repo: 'shop' },
    task: { id: 'task_1', title: 'Fix the login page' },
    sender: { id: 'user_1', name: 'Dana' },
    createdAt: START, expiresAt: START + 600_000,
    ...overrides,
  };
}

test('an approved command runs in the app folder and its output and exit code go back', async () => {
  const t = setup();
  assert.equal(t.bridge.start(), true);
  await flush();
  assert.equal(t.server.openPolls, 1, 'one poll is open at a time');
  const ask = request();
  t.server.deliver({ requests: [ask] });
  await flush();
  assert.equal(t.openPrompts().length, 1);
  assert.deepEqual(t.prompts[0].place, { root: '/Users/dana/1904/shop', chosen: false, path: '/Users/dana/1904/shop', outside: false });
  assert.equal(t.run(ask.id).status, 'waiting');
  assert.equal(t.run(ask.id).asking, true);
  assert.equal(t.shell.children.length, 0, 'nothing runs before the person answers');

  assert.equal(t.prompts[0].options.full, false, 'a sandboxed command');
  assert.equal(typeof t.prompts[0].options.startAway, 'function', 'away mode is offered on macOS');
  t.prompts[0].answer('once');
  await flush();
  assert.deepEqual(t.made, ['/Users/dana/1904/shop'], 'the folder is created on first use');
  const child = t.shell.children[0];
  assert.equal(child.file, '/usr/bin/sandbox-exec', 'it runs in the sandbox');
  assert.deepEqual(child.args.slice(-4), ['/bin/zsh', '-f', '-c', 'uname -a'], 'with no startup files');
  assert.equal(child.args[child.args.lastIndexOf('-p') + 1].split('\n')[0], '(version 1)');
  assert.ok(child.args.includes('P0=/Users/dana/1904/shop'), 'writes allowed in the app’s folder');
  assert.ok(child.args.includes('P1=/private/tmp/1904-run-1'), 'and in its own temp folder');
  assert.ok(!child.args[child.args.lastIndexOf('-p') + 1].includes('(allow network-outbound'), 'no network');
  assert.equal(child.options.cwd, '/Users/dana/1904/shop');
  assert.deepEqual(child.options.stdio, ['ignore', 'pipe', 'pipe'], 'stdin is closed');
  assert.equal(child.options.detached, true);
  assert.equal(child.options.windowsHide, true);
  assert.deepEqual(child.options.env, {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/Users/dana', USER: 'dana', SHELL: '/bin/zsh', TERM: 'dumb', TMPDIR: '/private/tmp/1904-run-1',
  }, 'nothing else from 1904 Desktop’s environment, never its tokens');
  assert.deepEqual(t.server.results, [{ requestId: ask.id, status: 'running', cwd: '/Users/dana/1904/shop' }]);
  assert.equal(t.bridge.running(), 1);

  child.stdout.write('Darwin\n');
  child.stderr.write('a note\n');
  await flush();
  child.finish(0);
  await flush();
  assert.deepEqual(t.server.results[1], {
    requestId: ask.id, status: 'done', exitCode: 0, stdout: 'Darwin\n', stderr: 'a note\n',
    trimmed: { stdout: false, stderr: false }, durationMs: 0, cwd: '/Users/dana/1904/shop',
  });
  assert.deepEqual(t.killed, [[-child.pid, 'SIGTERM'], [-child.pid, 'SIGKILL']], 'what the command left running in its group ends with it');
  const shown = t.run(ask.id);
  assert.deepEqual([shown.status, shown.exitCode, shown.approval], ['done', 0, 'once']);
  assert.deepEqual(shown.output, [{ stream: 'stdout', text: 'Darwin\n' }, { stream: 'stderr', text: 'a note\n' }]);
  assert.equal(t.bridge.running(), 0);
  assert.equal(t.server.openPolls, 1, 'polling carries on');
  assert.deepEqual(t.removed, ['/private/tmp/1904-run-1'], 'its temp folder is removed');
  assert.deepEqual(t.logged.map(entry => [entry.id, entry.status, entry.access]), [[ask.id, 'done', 'sandbox']], 'and it is in this computer’s own log');
});

test('a declined command never runs and 1904 hears that the person declined', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request();
  t.server.deliver({ requests: [ask] });
  await flush();
  t.prompts[0].answer('decline');
  await flush();
  assert.equal(t.shell.children.length, 0);
  assert.deepEqual(t.server.results, [{
    requestId: ask.id, status: 'declined', exitCode: null, stdout: '', stderr: '',
    trimmed: { stdout: false, stderr: false }, durationMs: 0, cwd: '/Users/dana/1904/shop', message: 'The person declined.',
  }]);
  assert.equal(t.run(ask.id).status, 'declined');
  assert.deepEqual(t.made, [], 'a declined request creates no folder');
});

test('a failing command reports its own exit code and stderr', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request({ command: 'ls missing' });
  t.server.deliver({ requests: [ask] });
  await flush();
  t.prompts[0].answer('once');
  await flush();
  t.shell.children[0].stderr.write('ls: missing: No such file or directory\n');
  await flush();
  t.shell.children[0].finish(3);
  await flush();
  const result = t.server.results.find(update => update.status !== 'running');
  assert.deepEqual([result.status, result.exitCode, result.stderr], ['done', 3, 'ls: missing: No such file or directory\n']);
});

test('a command that runs past its time limit is stopped with its whole process group', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request({ command: 'sleep 600', timeoutSeconds: 5 });
  t.server.deliver({ requests: [ask] });
  await flush();
  t.prompts[0].answer('once');
  await flush();
  const child = t.shell.children[0];
  child.stdout.write('started\n');
  await t.clock.advance(4999);
  assert.deepEqual(t.killed, []);
  await t.clock.advance(1);
  assert.deepEqual(t.killed[0], [-child.pid, 'SIGTERM'], 'the negative pid reaches the group');
  const result = t.server.results.find(update => update.status !== 'running');
  assert.equal(result.status, 'timeout');
  assert.equal(result.exitCode, null);
  assert.equal(result.stdout, 'started\n');
  assert.match(result.message, /after 5 seconds/);
  await t.clock.advance(2000);
  assert.ok(t.killed.some(([, signal]) => signal === 'SIGKILL'), 'anything that ignored SIGTERM is killed');
  assert.ok(t.killed.every(([pid]) => pid === -child.pid), 'only this command’s group');
});

test('a request cancelled while it waits in line is dropped, and its open prompt closes', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const first = request();
  const second = request({ messageId: 'msg_000000002' });
  t.server.deliver({ requests: [first, second] });
  await flush();
  assert.deepEqual(t.openPrompts().map(prompt => prompt.request.id), [first.id], 'one prompt at a time');
  t.server.deliver({ cancelled: [second.id] });
  await flush();
  assert.equal(t.run(second.id).status, 'cancelled');
  await t.clock.advance(QUICK_ANSWER_MS);
  t.server.deliver({ cancelled: [first.id] });
  await flush();
  assert.equal(t.prompts[0].aborted, true, 'the open prompt is closed');
  assert.equal(t.run(first.id).status, 'cancelled');
  assert.equal(t.prompts.length, 1, 'the cancelled request behind it is never shown');
  assert.equal(t.shell.children.length, 0);
  assert.deepEqual(t.server.results, [], '1904 cancelled them itself');
  await t.clock.advance(QUICK_ANSWER_MS);
  t.server.deliver({ requests: [second] });
  await flush();
  assert.equal(t.prompts.length, 1, 'a cancelled request delivered again is ignored');
  await t.clock.advance(QUICK_ANSWER_MS);
  const third = request();
  t.server.deliver({ requests: [third] });
  await flush();
  assert.deepEqual(t.openPrompts().map(prompt => prompt.request.id), [third.id], 'the queue keeps moving');
});

test('a request cancelled while it runs is stopped and its output so far goes back', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request({ command: 'npm test' });
  t.server.deliver({ requests: [ask] });
  await flush();
  t.prompts[0].answer('once');
  await flush();
  const child = t.shell.children[0];
  child.stdout.write('1 passing\n');
  await flush();
  t.server.deliver({ cancelled: [ask.id] });
  await flush();
  assert.deepEqual(t.killed[0], [-child.pid, 'SIGTERM']);
  const result = t.server.results.find(update => update.status !== 'running');
  assert.deepEqual([result.status, result.exitCode, result.stdout], ['cancelled', null, '1 passing\n']);
  assert.match(result.message, /task cancelled/);
});

test('Stop in Computer Activity ends the command and says the person stopped it', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request();
  t.server.deliver({ requests: [ask] });
  await flush();
  t.prompts[0].answer('once');
  await flush();
  assert.equal(t.bridge.stopRun(ask.id), true);
  await flush();
  const result = t.server.results.find(update => update.status !== 'running');
  assert.equal(result.status, 'cancelled');
  assert.match(result.message, /person stopped/);
  assert.equal(t.bridge.stopRun(ask.id), false, 'nothing is running any more');
});

test('one prompt at a time; "Allow for this message" covers that message inside the folder only', async () => {
  const t = setup({ dirs: ['/Users/dana/1904/shop/src', '/etc'] });
  t.bridge.start();
  await flush();
  const a = request({ command: 'git status' });
  const b = request({ messageId: 'msg_000000002', command: 'whoami' });
  const c = request({ command: 'ls', cwd: 'src' });
  t.server.deliver({ requests: [a, b, c] });
  await flush();
  assert.deepEqual(t.openPrompts().map(prompt => prompt.request.id), [a.id]);

  t.prompts[0].answer('allow');
  await flush();
  assert.deepEqual(t.shell.children.map(child => child.args.at(-1)), ['git status', 'ls'], 'the same message’s request runs without a prompt');
  assert.equal(t.shell.children[1].options.cwd, '/Users/dana/1904/shop/src');
  assert.equal(t.run(c.id).approval, 'covered', 'it still appears in Computer Activity');
  assert.deepEqual(t.openPrompts().map(prompt => prompt.request.id), [b.id], 'another message still asks');

  const outside = request({ command: 'cat /etc/hosts', cwd: '/etc' });
  t.server.deliver({ requests: [outside] });
  await flush();
  assert.equal(t.shell.children.length, 2, 'a request that leaves the folder is never covered');
  t.prompts[1].answer('decline');
  await flush();
  assert.equal(t.openPrompts()[0].request.id, outside.id);
  assert.equal(t.openPrompts()[0].place.outside, true);
  assert.equal(t.openPrompts()[0].place.path, '/etc');
  t.openPrompts()[0].answer('once');
  await flush();
  assert.equal(t.shell.children[2].options.cwd, '/etc');

  const later = request({ command: 'pwd' });
  t.server.deliver({ requests: [later] });
  await flush();
  assert.equal(t.shell.children.length, 4, 'a request arriving later in the same message runs straight away');
  assert.equal(t.openPrompts().length, 0);
  const nextMessage = request({ messageId: 'msg_000000003', command: 'pwd' });
  t.server.deliver({ requests: [nextMessage] });
  await flush();
  assert.equal(t.openPrompts()[0].request.id, nextMessage.id, 'the next message asks again');
});

test('a prompt nobody answers closes when the request expires', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request({ expiresAt: START + 60_000 });
  t.server.deliver({ requests: [ask] });
  await flush();
  await t.clock.advance(59_999);
  assert.equal(t.prompts[0].open, true);
  await t.clock.advance(1);
  assert.equal(t.prompts[0].aborted, true);
  assert.equal(t.run(ask.id).status, 'expired');
  assert.deepEqual(t.server.results, [], 'expiry is 1904’s to report');
  const stale = request({ expiresAt: START - 1 });
  t.server.deliver({ requests: [stale] });
  await flush();
  assert.equal(t.prompts.length, 1, 'an already expired request is never shown');
  assert.equal(t.run(stale.id).status, 'expired');
});

test('offline, the poll backs off; waking the computer retries at once', async () => {
  const t = setup();
  t.server.state.offline = true;
  t.bridge.start();
  await flush();
  assert.equal(t.server.state.polls, 1);
  assert.equal(t.bridge.connection().status, 'offline');
  await t.clock.advance(1999);
  assert.equal(t.server.state.polls, 1);
  await t.clock.advance(1);
  assert.equal(t.server.state.polls, 2, 'then 2 s');
  await t.clock.advance(3999);
  assert.equal(t.server.state.polls, 2);
  await t.clock.advance(1);
  assert.equal(t.server.state.polls, 3, 'then 4 s');

  t.bridge.suspend();
  assert.equal(t.bridge.connection().status, 'sleeping');
  await t.clock.advance(60_000);
  assert.equal(t.server.state.polls, 3, 'nothing is tried while the computer sleeps');
  t.server.state.offline = false;
  t.bridge.resume();
  await flush();
  assert.equal(t.server.state.polls, 4, 'waking tries again straight away');
  assert.equal(t.server.openPolls, 1);
  t.server.deliver({});
  await flush();
  assert.equal(t.bridge.connection().status, 'connected');
});

test('sleep closes the open poll and waking opens a new one', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  assert.equal(t.server.openPolls, 1);
  t.bridge.suspend();
  await flush();
  assert.equal(t.server.openPolls, 0);
  t.bridge.resume();
  await flush();
  assert.equal(t.server.openPolls, 1);
  assert.equal(t.server.state.polls, 2);
});

test('a 401 means 1904 no longer knows this computer: the token is forgotten and polling stops', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request();
  t.server.deliver({ requests: [ask] });
  await flush();
  t.server.state.pollStatus = 401;
  t.server.deliver({});
  await t.clock.advance(QUICK_ANSWER_MS);
  assert.equal(t.server.state.polls, 3, 'the next poll is answered 401');
  assert.equal(t.link.info(), undefined, 'the token is gone');
  assert.deepEqual(t.disconnected, ['revoked']);
  assert.equal(t.prompts[0].aborted, true, 'its prompt closes');
  assert.equal(t.bridge.connection().status, 'revoked');
  assert.equal(t.bridge.connection().connected, false);
  const polls = t.server.state.polls;
  await t.clock.advance(120_000);
  assert.equal(t.server.state.polls, polls, 'no more polls');
  assert.equal(t.bridge.start(), false, 'it cannot start again without connecting');
});

test('a request this app cannot read is reported as failed and never shown', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  t.server.deliver({ requests: [request({ id: 'req_bad000001', kind: 'screen' }), { id: 'x' }] });
  await flush();
  assert.equal(t.prompts.length, 0);
  assert.equal(t.server.results.length, 1);
  assert.equal(t.server.results[0].requestId, 'req_bad000001');
  assert.equal(t.server.results[0].status, 'failed');
  assert.match(t.server.results[0].message, /update 1904 Desktop/);
});

test('a program that cannot start fails the request with a plain message', async () => {
  const t = setup({ missing: true });
  t.bridge.start();
  await flush();
  const ask = request();
  t.server.deliver({ requests: [ask] });
  await flush();
  t.prompts[0].answer('once');
  await flush();
  assert.deepEqual(t.server.results.map(update => update.status), ['running', 'failed'], '1904 confirms before the shell is started');
  assert.equal(t.server.results[1].message, 'Not found: /usr/bin/sandbox-exec');
  assert.equal(t.run(ask.id).status, 'failed');
});

test('a folder that does not exist inside the app folder fails before anything starts', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request({ cwd: 'nope' });
  t.server.deliver({ requests: [ask] });
  await flush();
  t.prompts[0].answer('once');
  await flush();
  assert.equal(t.shell.children.length, 0);
  assert.equal(t.server.results[0].status, 'failed');
  assert.match(t.server.results[0].message, /does not exist on this computer: \/Users\/dana\/1904\/shop\/nope/);
});

test('Windows runs PowerShell with the encoded command, decodes its stderr, and stops the tree with taskkill', async () => {
  const t = setup({ platform: 'windows', home: 'C:\\Users\\dana', env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\system32' } });
  t.bridge.start();
  await flush();
  const ask = request({ command: 'Get-Item nope; Start-Sleep 600' });
  t.server.deliver({ requests: [ask] });
  await flush();
  t.prompts[0].answer('once');
  await flush();
  const child = t.shell.children[0];
  assert.equal(child.file, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(child.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.match(Buffer.from(child.args[4], 'base64').toString('utf16le'), /Get-Item nope; Start-Sleep 600/);
  assert.equal(child.options.cwd, 'C:\\Users\\dana\\1904\\shop');
  assert.equal(child.options.detached, false);
  child.stderr.write('#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">Get-Item : Cannot find path_x000D__x000A_</S>');
  await flush();
  t.bridge.stopRun(ask.id);
  await flush();
  const killer = t.shell.spawned.find(entry => /taskkill\.exe$/.test(entry.file));
  assert.equal(killer.file, 'C:\\Windows\\System32\\taskkill.exe');
  assert.deepEqual(killer.args, ['/pid', String(child.pid), '/T', '/F']);
  const result = t.server.results.find(update => update.status !== 'running');
  assert.equal(result.status, 'cancelled');
  assert.equal(result.stderr, 'Get-Item : Cannot find path\r\n', 'the result carries plain text, not CLIXML');
});

test('a result that cannot be delivered is sent again while the computer stays connected', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request();
  t.server.deliver({ requests: [ask] });
  await flush();
  t.server.state.offline = true;
  t.prompts[0].answer('decline');
  await flush();
  assert.equal(t.server.results.length, 0);
  const calls = t.server.state.resultCalls;
  await t.clock.advance(2000);
  assert.equal(t.server.state.resultCalls, calls + 1);
  t.server.state.offline = false;
  await t.clock.advance(4000);
  assert.deepEqual(t.server.results.map(update => update.status), ['declined']);
});

test('Disconnect stops what runs, tells 1904, then forgets the token', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const running = request();
  const waiting = request({ messageId: 'msg_000000002' });
  t.server.deliver({ requests: [running, waiting] });
  await flush();
  t.prompts[0].answer('once');
  await flush();
  assert.equal(t.bridge.busy(), true);
  const done = t.bridge.disconnect();
  await flush();
  assert.equal(await done, true, '1904 confirmed the revocation');
  assert.equal(t.server.state.revokes, 1, 'DELETE on the pair route, with the token');
  assert.equal(t.link.info(), undefined);
  const finals = t.server.results.filter(update => update.status !== 'running');
  assert.deepEqual(finals.map(update => [update.requestId, update.status]).sort(), [[running.id, 'cancelled'], [waiting.id, 'cancelled']].sort());
  assert.ok(finals.every(update => /disconnected/.test(update.message)));
  assert.equal(t.bridge.busy(), false);
  assert.equal(t.bridge.connection().status, 'not-connected');
});

test('Disconnect while 1904 cannot be reached still forgets the token here', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  t.server.state.offline = true;
  const done = t.bridge.disconnect();
  await t.clock.advance(3000);
  assert.equal(await done, false);
  assert.equal(t.server.state.revokes, 1);
  assert.equal(t.link.info(), undefined);
});

test('a result 1904 refuses (409 finished, 404 not this computer’s) is dropped, not retried', async () => {
  for (const status of [409, 404]) {
    const t = setup();
    t.bridge.start();
    await flush();
    t.server.state.resultStatus = status;
    t.server.deliver({ requests: [request()] });
    await flush();
    t.prompts[0].answer('decline');
    await flush();
    await t.clock.advance(120_000);
    assert.equal(t.server.state.resultCalls, 1, String(status));
  }
  const t = setup();
  t.bridge.start();
  await flush();
  t.server.state.resultStatus = 503;
  t.server.deliver({ requests: [request()] });
  await flush();
  t.prompts[0].answer('decline');
  await flush();
  await t.clock.advance(60_000);
  assert.equal(t.server.state.resultCalls, 6, 'a 5xx is retried with backoff: 0, 2, 6, 14, 30 and 60 s');
  await t.clock.advance(600_000);
  assert.equal(t.server.state.resultCalls, 8, 'a few times, then it gives up');
});

test('while Use My Computer is turned off for the workspace, nothing is shown and polling slows', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  t.server.deliver({ enabled: false, message: 'Your workspace’s Admin turned Use My Computer off.', requests: [request()] });
  await flush();
  assert.equal(t.prompts.length, 0);
  assert.equal(t.bridge.connection().status, 'disabled');
  assert.equal(t.bridge.connection().text, 'Your workspace’s Admin turned Use My Computer off.');
  const polls = t.server.state.polls;
  await t.clock.advance(59_999);
  assert.equal(t.server.state.polls, polls);
  await t.clock.advance(1);
  assert.equal(t.server.state.polls, polls + 1);
});

test('nothing starts until 1904 confirms it; a refused "running" means the request was withdrawn', async () => {
  for (const refusal of [409, 404]) {
    const t = setup();
    t.bridge.start();
    await flush();
    t.server.state.runningStatus = [refusal];
    const ask = request();
    t.server.deliver({ requests: [ask] });
    await flush();
    t.prompts[0].answer('once');
    await flush();
    assert.equal(t.shell.children.length, 0, `${refusal}: nothing runs`);
    assert.deepEqual(t.server.results.map(update => update.status), ['running'], 'no result follows a withdrawal');
    assert.equal(t.run(ask.id).status, 'withdrawn');
    assert.match(t.run(ask.id).message, /withdrew/);
  }
});

test('a "running" 1904 cannot confirm is tried again briefly, and never confirmed means never run', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  t.server.state.runningStatus = [503, 'offline'];
  const first = request();
  t.server.deliver({ requests: [first] });
  await flush();
  t.prompts[0].answer('once');
  await flush();
  assert.equal(t.shell.children.length, 0);
  assert.equal(t.run(first.id).status, 'starting');
  await t.clock.advance(2000);
  assert.equal(t.shell.children.length, 0);
  await t.clock.advance(4000);
  assert.equal(t.shell.children.length, 1, 'confirmed on the third try, so it runs');
  t.shell.children[0].finish(0);
  await flush();

  t.server.state.runningStatus = [500, 502, 'offline'];
  const second = request({ messageId: 'msg_000000002' });
  t.server.deliver({ requests: [second] });
  await flush();
  t.openPrompts()[0].answer('once');
  await flush();
  await t.clock.advance(6000);
  assert.equal(t.shell.children.length, 1, 'never confirmed, so never started');
  assert.deepEqual([t.run(second.id).status, t.run(second.id).message], ['failed', UNCONFIRMED]);
  const failed = t.server.results.find(update => update.requestId === second.id && update.status === 'failed');
  assert.equal(failed.message, UNCONFIRMED);
});

test('a prompt closes by 1904’s clock, not only this computer’s', async () => {
  // This computer is an hour behind 1904, and the request reaches it nine minutes into its ten.
  const behind = setup();
  behind.server.state.serverOffset = 3_600_000;
  behind.bridge.start();
  await flush();
  behind.server.deliver({});
  await behind.clock.advance(QUICK_ANSWER_MS);
  const serverNow = START + QUICK_ANSWER_MS + 3_600_000;
  behind.server.deliver({ requests: [request({ createdAt: serverNow - 540_000, expiresAt: serverNow + 60_000 })] });
  await flush();
  await behind.clock.advance(59_000);
  assert.equal(behind.prompts[0].open, true);
  await behind.clock.advance(1000);
  assert.equal(behind.prompts[0].aborted, true, 'it closes when 1904’s expiry passes');

  // An hour ahead: by its own clock the request would look expired on arrival.
  const ahead = setup();
  ahead.server.state.serverOffset = -3_600_000;
  ahead.bridge.start();
  await flush();
  ahead.server.deliver({});
  await ahead.clock.advance(QUICK_ANSWER_MS);
  const aheadNow = START + QUICK_ANSWER_MS - 3_600_000;
  ahead.server.deliver({ requests: [request({ createdAt: aheadNow, expiresAt: aheadNow + 600_000 })] });
  await flush();
  assert.equal(ahead.prompts.length, 1, 'shown, not dropped as expired');
  await ahead.clock.advance(599_000);
  assert.equal(ahead.prompts[0].open, true);
  await ahead.clock.advance(1000);
  assert.equal(ahead.prompts[0].aborted, true);
});

test('"Allow for this message" ends when the task moves on to another message, and after 30 minutes', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const first = request();
  t.server.deliver({ requests: [first] });
  await flush();
  t.prompts[0].answer('allow');
  await flush();
  t.shell.children[0].finish(0);
  await flush();
  t.server.deliver({ requests: [request()] });
  await flush();
  assert.equal(t.prompts.length, 1, 'covered while the message lasts');
  assert.equal(t.shell.children.length, 2);
  t.shell.children[1].finish(0);
  await flush();

  t.server.deliver({ requests: [request({ messageId: 'msg_000000002' })] });
  await flush();
  t.openPrompts()[0].answer('decline');
  await flush();
  const again = request();
  t.server.deliver({ requests: [again] });
  await flush();
  assert.equal(t.openPrompts()[0]?.request.id, again.id, 'the first message’s allowance ended with its turn');
  t.openPrompts()[0].answer('allow');
  await flush();
  t.shell.children[2].finish(0);
  await flush();

  await t.clock.advance(30 * 60_000 + 1);
  const later = request();
  t.server.deliver({ requests: [later] });
  await t.clock.advance(30_000);
  assert.equal(t.openPrompts()[0]?.request.id, later.id, 'thirty minutes on, it asks again');
});

test('a command too long to show in one prompt is never asked about or run', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const long = request({ command: 'echo ' + 'x'.repeat(3100) });
  const lines = request({ messageId: 'msg_000000002', command: Array.from({ length: 61 }, (_, i) => `echo ${i}`).join('\n') });
  t.server.deliver({ requests: [long, lines] });
  await flush();
  assert.equal(t.prompts.length, 0);
  assert.equal(t.shell.children.length, 0);
  for (const ask of [long, lines]) {
    const result = t.server.results.find(update => update.requestId === ask.id);
    assert.deepEqual([result.status, result.message], ['failed', TOO_LONG]);
    assert.equal(t.run(ask.id).status, 'failed', 'it is listed in Computer Activity');
  }
});

test('Computer Activity shows commands, reasons and folders spelled out the way the prompt does', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request({ command: 'echo safe‮txt.exe rm -rf ~', reason: 'Check‮ this' });
  t.server.deliver({ requests: [ask] });
  await flush();
  const shown = t.run(ask.id);
  assert.equal(shown.command, 'echo safe<U+202E>txt.exe<U+2028>rm -rf ~');
  assert.equal(shown.reason, 'Check<U+202E> this');
});

test('a 403 computer.blocked keeps the token and asks again every five minutes', async () => {
  const t = setup();
  t.server.state.pollStatus = 403;
  t.server.state.pollBody = { code: 'computer.blocked', error: 'This account is paused.' };
  t.bridge.start();
  await flush();
  assert.equal(t.server.state.polls, 1);
  assert.deepEqual(t.link.info(), { id: 'cmp_00000001', name: 'Studio Mac' }, 'the token stays');
  assert.deepEqual([t.bridge.connection().status, t.bridge.connection().text], ['blocked', 'This account is paused.']);
  await t.clock.advance(BLOCKED_WAIT_MS - 1);
  assert.equal(t.server.state.polls, 1);
  await t.clock.advance(1);
  assert.equal(t.server.state.polls, 2);
  t.server.state.pollStatus = 200;
  await t.clock.advance(BLOCKED_WAIT_MS);
  assert.equal(t.server.openPolls, 1);
  t.server.deliver({});
  await flush();
  assert.equal(t.bridge.connection().status, 'connected');
  assert.deepEqual(t.disconnected, [], 'only a 401 forgets the token');
});

// ── Round 3: origin, sandbox, full access, away mode, pause, the local record ──

const profileOf = child => child.args[child.args.lastIndexOf('-p') + 1];

test('a request for a message this computer did not send is refused without a prompt', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const stranger = request({ messageId: 'msg_000000077' });
  const noOrigin = request();
  delete noOrigin.origin;
  t.server.deliver({ requests: [stranger, noOrigin] });
  await flush();
  assert.equal(t.prompts.length, 0);
  assert.equal(t.shell.children.length, 0);
  for (const refused of [stranger, noOrigin]) {
    const result = t.server.results.find(update => update.requestId === refused.id);
    assert.deepEqual([result.status, result.message], ['failed', NOT_FROM_DESKTOP]);
  }
  assert.equal(NOT_FROM_DESKTOP, '1904 Desktop did not send this message, so it will not run commands for it.');
  assert.equal(t.run(stranger.id).status, 'failed', 'listed in Computer Activity');
  assert.ok(t.logged.some(entry => entry.id === stranger.id && entry.status === 'failed'), 'and in the log');
});

test('full access always asks, with no allowance and no away mode, and runs without the sandbox in a clean environment', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const first = request({ access: 'full', command: 'git push' });
  t.server.deliver({ requests: [first] });
  await flush();
  assert.equal(t.prompts[0].options.full, true);
  assert.equal(t.prompts[0].options.startAway, undefined, 'away mode is never offered for full access');
  t.prompts[0].answer('allow');
  await flush();
  const child = t.shell.children[0];
  assert.equal(child.file, '/bin/zsh');
  assert.deepEqual(child.args, ['-f', '-c', 'git push'], 'the person’s shell without startup files');
  assert.equal(child.options.env.GITHUB_TOKEN, undefined);
  assert.equal(child.options.env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(t.run(first.id).access, 'full');
  child.finish(0);
  await flush();
  const second = request({ access: 'full' });
  t.server.deliver({ requests: [second] });
  await flush();
  assert.equal(t.openPrompts()[0]?.request.id, second.id, 'never covered by "Allow for this message"');
});

test('internet access reaches the sandbox only when the person ticked it', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const first = request({ network: true });
  t.server.deliver({ requests: [first] });
  await flush();
  t.prompts[0].answer('once', false);
  await flush();
  assert.doesNotMatch(profileOf(t.shell.children[0]), /allow network-outbound/);
  t.shell.children[0].finish(0);
  await flush();
  const second = request({ network: true, messageId: 'msg_000000002' });
  t.server.deliver({ requests: [second] });
  await flush();
  t.openPrompts()[0].answer('once', true);
  await flush();
  assert.match(profileOf(t.shell.children[1]), /^\(allow network-outbound \(remote ip "\*:\*"\)\)$/m);
  assert.equal(t.run(second.id).network, true);
});

test('without sandbox-exec a sandboxed command is refused before anything starts', async () => {
  const t = setup({ sandboxExec: false });
  t.bridge.start();
  await flush();
  const ask = request();
  t.server.deliver({ requests: [ask] });
  await flush();
  t.prompts[0].answer('once');
  await flush();
  assert.equal(t.shell.children.length, 0);
  assert.deepEqual(t.server.results.map(update => [update.status, update.message]), [['failed', NO_SANDBOX]]);
});

test('away mode: started here with Touch ID, it runs the task’s sandboxed commands without asking until its budget runs out', async () => {
  const t = setup({ awayChoice: async () => ({ minutes: 60, network: false, maxCommands: 1 }) });
  t.bridge.start();
  await flush();
  const first = request();
  t.server.deliver({ requests: [first] });
  await flush();
  // The person picks "Allow while I’m away…" in the prompt.
  assert.equal(await t.prompts[0].options.startAway(), true);
  t.prompts[0].answer('away');
  await flush();
  assert.deepEqual(t.server.away[0], { action: 'start', taskId: 'task_1', appId: 'app_1', minutes: 60, network: false, maxCommands: 1 });
  assert.deepEqual(t.presence, ['start away mode for “Fix the login page”'], 'Touch ID where available');
  assert.ok(t.notices.some(notice => notice.kind === 'away-started'));
  assert.equal(t.shell.children.length, 1, 'the request the person answered runs');
  assert.equal(t.run(first.id).approval, 'once', 'they approved it themselves');
  t.shell.children[0].finish(0);
  await flush();
  assert.equal(t.leases.list()[0].used, 0, 'a message sent from this window does not use the budget, as on 1904');

  // A later message from this window still asks, lease or not.
  const fromHere = request({ messageId: 'msg_000000002' });
  t.server.deliver({ requests: [fromHere] });
  await flush();
  assert.equal(t.openPrompts()[0]?.request.id, fromHere.id, 'away mode covers only messages sent from elsewhere');
  t.openPrompts()[0].answer('decline');
  await flush();

  // A message sent from a phone: 1904 marks it away, with this lease.
  const leaseId = t.leases.list()[0].id;
  const fromPhone = request({ messageId: 'msg_000000088', origin: { kind: 'away', leaseId } });
  t.server.deliver({ requests: [fromPhone] });
  await flush();
  assert.equal(t.prompts.length, 2, 'no prompt for a message from elsewhere in away mode');
  assert.equal(t.shell.children.length, 2);
  assert.equal(t.shell.children[1].file, '/usr/bin/sandbox-exec', 'still in the sandbox');
  assert.ok(t.notices.some(notice => notice.kind === 'away-run' && notice.request.id === fromPhone.id), 'announced');
  t.shell.children[1].finish(0);
  await flush();
  assert.deepEqual(t.leases.list(), [], 'the command from elsewhere used the budget');
  assert.ok(!t.server.away.some(call => call.action === 'end'), '1904 ends it at the same count itself');
  assert.ok(t.notices.some(notice => notice.kind === 'away-ended' && notice.reason === 'budget'));

  const late = request({ messageId: 'msg_000000089', origin: { kind: 'away', leaseId } });
  t.server.deliver({ requests: [late] });
  await flush();
  assert.equal(t.shell.children.length, 2);
  assert.match(t.server.results.find(update => update.requestId === late.id).message, /Away mode is not on for this task/);
});

test('away mode never starts without the person, and the cloud cannot start one', async () => {
  const noTouch = setup({ confirmPresence: async () => false });
  noTouch.bridge.start();
  await flush();
  assert.equal((await noTouch.bridge.startAway({ taskId: 'task_1', appId: 'app_1', taskTitle: 'Fix' })).ok, false);
  assert.deepEqual(noTouch.server.away, [], 'Touch ID refused: 1904 is never asked');
  const cancelled = setup({ awayChoice: async () => undefined });
  cancelled.bridge.start();
  await flush();
  assert.equal((await cancelled.bridge.startAway({ taskId: 'task_1', appId: 'app_1', taskTitle: 'Fix' })).ok, false);
  assert.deepEqual(cancelled.presence, [], 'cancelled questions end it before Touch ID');
  // An away request with a lease id this computer never started is refused.
  const forged = request({ messageId: 'msg_000000099', origin: { kind: 'away', leaseId: 'lease_forged01' } });
  cancelled.server.deliver({ requests: [forged] });
  await flush();
  assert.equal(cancelled.shell.children.length, 0);
  assert.match(cancelled.server.results[0].message, /Away mode is not on/);
});

test('without Touch ID, away mode asks once more with 1904’s own task title, and Cancel ends it at once', async () => {
  const declined = setup({ confirmPresence: async () => undefined, confirmLease: async () => false });
  declined.bridge.start();
  await flush();
  const refused = await declined.bridge.startAway({ taskId: 'task_1', appId: 'app_1', taskTitle: 'A title the page made up' });
  await flush();
  assert.equal(refused.ok, false);
  assert.deepEqual(declined.leaseQuestions.map(lease => [lease.taskTitle, lease.minutes, lease.maxCommands, lease.network]),
    [['Fix the login page', 60, 50, false]], 'the question names 1904’s task, not the page’s');
  assert.deepEqual(declined.server.away.map(call => call.action), ['start', 'end'], 'ended at once');
  assert.deepEqual(declined.bridge.away(), [], 'never kept here, so nothing ran under it');

  const confirmed = setup({ confirmPresence: async () => undefined, confirmLease: async () => true });
  confirmed.bridge.start();
  await flush();
  const started = await confirmed.bridge.startAway({ taskId: 'task_1', appId: 'app_1', taskTitle: 'A title the page made up' });
  assert.equal(started.ok, true);
  assert.equal(confirmed.bridge.away()[0].taskTitle, 'Fix the login page');

  const touched = setup({ confirmPresence: async () => true });
  touched.bridge.start();
  await flush();
  assert.equal((await touched.bridge.startAway({ taskId: 'task_1', appId: 'app_1', taskTitle: 'x' })).ok, true);
  assert.deepEqual(touched.leaseQuestions, [], 'Touch ID is enough');
});

test('away mode covers sandboxed commands only; full access still waits for the person', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const { lease } = await t.bridge.startAway({ taskId: 'task_1', appId: 'app_1', taskTitle: 'Fix the login page' });
  const fullHere = request({ access: 'full' });
  const fullAway = request({ access: 'full', messageId: 'msg_000000090', origin: { kind: 'away', leaseId: lease.id } });
  const online = request({ network: true, messageId: 'msg_000000091', origin: { kind: 'away', leaseId: lease.id } });
  t.server.deliver({ requests: [fullHere, fullAway, online] });
  await flush();
  assert.deepEqual(t.openPrompts().map(prompt => prompt.request.id), [fullHere.id], 'full access from this computer asks');
  assert.match(t.server.results.find(update => update.requestId === fullAway.id).message, /sandboxed commands only/);
  assert.match(t.server.results.find(update => update.requestId === online.id).message, /no internet access/);
  assert.equal(t.shell.children.length, 0);
});

test('a "running" answered away_ended withdraws the command and ends away mode here', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const { lease } = await t.bridge.startAway({ taskId: 'task_1', appId: 'app_1', taskTitle: 'Fix the login page' });
  t.server.state.runningStatus = [{ status: 409, body: { error: 'Away mode ended.', code: 'computer.away_ended' } }];
  const late = request({ messageId: 'msg_000000092', origin: { kind: 'away', leaseId: lease.id } });
  t.server.deliver({ requests: [late] });
  await flush();
  assert.equal(t.shell.children.length, 0);
  assert.equal(t.run(late.id).status, 'withdrawn');
  assert.deepEqual(t.bridge.away(), [], 'the lease ended here too');
  assert.ok(!t.server.away.some(call => call.action === 'end'), '1904 already knows');
});

test('away mode ends at its time, from Desktop, and when 1904 says it ended elsewhere', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const task = { taskId: 'task_1', appId: 'app_1', taskTitle: 'Fix the login page' };
  await t.bridge.startAway(task);
  await t.clock.advance(60 * 60_000);
  assert.deepEqual(t.bridge.away(), []);
  assert.ok(t.notices.some(notice => notice.kind === 'away-ended' && notice.reason === 'time'));

  const second = (await t.bridge.startAway(task)).lease;
  assert.equal(t.bridge.away()[0].commandsLeft, 50);
  assert.equal(t.bridge.endAway(second.id), true);
  await flush();
  assert.ok(t.server.away.some(call => call.action === 'end' && call.leaseId === second.id), 'ended here, so 1904 hears it');

  const third = (await t.bridge.startAway(task)).lease;
  const ends = t.server.away.filter(call => call.action === 'end').length;
  t.server.deliver({ awayEnded: [third.id] });
  await t.clock.advance(30_000);
  assert.deepEqual(t.bridge.away(), []);
  assert.equal(t.server.away.filter(call => call.action === 'end').length, ends, '1904 already knows');
  assert.ok(t.notices.some(notice => notice.kind === 'away-ended' && notice.reason === 'elsewhere'));
});

test('Windows has no sandbox yet: every command is full access, with no allowance and no away mode', async () => {
  const t = setup({ platform: 'windows', home: 'C:\\Users\\dana', env: { SystemRoot: 'C:\\Windows', Path: 'C:\\Windows\\system32', GITHUB_TOKEN: 'never' } });
  t.bridge.start();
  await flush();
  const first = request();
  t.server.deliver({ requests: [first] });
  await flush();
  assert.equal(t.prompts[0].options.full, true);
  assert.equal(t.prompts[0].options.startAway, undefined);
  t.prompts[0].answer('allow');
  await flush();
  const child = t.shell.children[0];
  assert.match(child.file, /powershell\.exe$/);
  assert.equal(child.options.env.GITHUB_TOKEN, undefined);
  assert.deepEqual([child.options.env.TEMP, child.options.env.TMP], ['\\private\\tmp\\1904-run-1', '\\private\\tmp\\1904-run-1'], 'its own temp folder');
  child.finish(0);
  await flush();
  t.server.deliver({ requests: [request()] });
  await flush();
  assert.equal(t.openPrompts().length, 1, 'the same message asks again');
  assert.match((await t.bridge.startAway({ taskId: 'task_1', appId: 'app_1', taskTitle: 'x' })).message, /only on macOS/);
});

test('Pause stops polling and closes prompts until the person resumes', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  const ask = request();
  t.server.deliver({ requests: [ask] });
  await flush();
  t.bridge.setPaused(true);
  await flush();
  assert.equal(t.prompts[0].aborted, true);
  assert.deepEqual(t.server.results.map(update => [update.status, update.message]), [['cancelled', 'The person paused Use My Computer on this computer.']]);
  assert.deepEqual([t.bridge.connection().status, t.bridge.connection().paused], ['paused', true]);
  assert.equal(t.server.openPolls, 0);
  const polls = t.server.state.polls;
  await t.clock.advance(120_000);
  assert.equal(t.server.state.polls, polls, 'no polling while paused');
  assert.equal(t.bridge.start(), false, 'starting does nothing while paused');
  t.bridge.setPaused(false);
  await flush();
  assert.equal(t.server.openPolls, 1);
  assert.equal(t.bridge.connection().paused, false);
});

test('a 401 after a month without use says the pairing lapsed', async () => {
  const t = setup({ seenAt: START - 31 * 24 * 60 * 60_000 });
  t.server.state.pollStatus = 401;
  t.bridge.start();
  await flush();
  assert.deepEqual(t.disconnected, ['lapsed']);
  assert.equal(t.bridge.connection().status, 'lapsed');
  assert.match(t.bridge.connection().text, /lapsed after 30 days without use/);
  assert.equal(t.messages.sent.size, 0, 'the list of sent messages goes with the pairing');
});

test('Computer Activity lists earlier commands from the log and the active away mode', async () => {
  const t = setup();
  t.bridge.start();
  await flush();
  t.logged.push({ id: 'req_old000001', at: 1, status: 'done', command: 'echo \u202Eold', task: { title: 'Old task' }, sender: { name: 'Dana' }, app: { name: 'Shop' }, stdout: 'old\n', stderr: '' });
  t.logged.push({ kind: 'note', at: 2, note: 'not stamped: no recent input', messageId: 'x' });
  await t.bridge.startAway({ taskId: 'task_1', appId: 'app_1', taskTitle: 'Fix the login page' });
  const snapshot = t.bridge.snapshot({ output: true });
  assert.deepEqual(snapshot.history.map(run => [run.id, run.command]), [['req_old000001', 'echo <U+202E>old']]);
  assert.deepEqual(snapshot.history[0].output, [{ stream: 'stdout', text: 'old\n' }]);
  assert.deepEqual(snapshot.away.map(lease => [lease.taskTitle, lease.commandsLeft]), [['Fix the login page', 50]]);
  assert.equal(t.bridge.snapshot().history[0].output, undefined, 'output only on the first full load');
});
