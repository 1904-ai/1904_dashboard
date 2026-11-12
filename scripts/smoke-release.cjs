const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { REFUSED_EXIT_CODE } = require('../startup-guard.cjs');

// A release build refuses the Node.js inspector and the DevTools port, so nothing can attach to it to
// look at its windows. Instead this starts it as a person would, with DESKTOP_SMOKE_REPORT naming a file,
// and reads what the app reports there about its title bar and the live 1904 sign-in page (see
// startup-guard.cjs). Then it checks that the same build refuses debugging switches and does not run
// as Node.js.

const LAUNCH_MS = 90000;
const REFUSAL_MS = 30000;

function appEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'DESKTOP_SMOKE_REPORT']) delete env[name];
  return { ...env, ...extra };
}

function launch(executablePath, args, env) {
  const child = spawn(executablePath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  const collect = chunk => { if (output.length < 64 * 1024) output += chunk; };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, exited, output: () => output.trim() || '(nothing)' };
}

const within = (promise, ms) => Promise.race([promise, sleep(ms).then(() => null)]);
const ended = app => app.child.exitCode !== null || app.child.signalCode !== null;

async function close(app) {
  if (ended(app)) return;
  if (process.platform === 'win32') {
    const taskkill = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    spawnSync(taskkill, ['/pid', String(app.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    app.child.kill('SIGTERM');
  }
  if (!await within(app.exited, 15000)) {
    app.child.kill('SIGKILL');
    await within(app.exited, 5000);
  }
}

async function checkLaunch(executablePath, root) {
  const profile = join(root, 'profile');
  const reportFile = join(root, 'smoke-report.json');
  const app = launch(executablePath, [`--user-data-dir=${profile}`], appEnv({ DESKTOP_SMOKE_REPORT: reportFile }));
  try {
    let report;
    for (const end = Date.now() + LAUNCH_MS; !report && Date.now() < end; await sleep(250)) {
      if (existsSync(reportFile)) {
        try { report = JSON.parse(readFileSync(reportFile, 'utf8')); } catch { /* still being written */ }
      }
      if (!report && ended(app)) {
        assert.fail(`The packaged app exited with ${app.child.exitCode ?? app.child.signalCode} before it reported. It printed:\n${app.output()}`);
      }
    }
    assert.ok(report, `The packaged app wrote no smoke report within ${LAUNCH_MS / 1000}s. It printed:\n${app.output()}`);
    const seen = `The app reported ${JSON.stringify(report)}`;
    assert.equal(report.titleBar, true, `The title bar and its Application menu button must open. ${seen}`);
    assert.equal(report.dashboard, 'https://1904.ai/login', `The hosted dashboard must open the 1904 sign-in page. ${seen}`);
    assert.equal(report.returnTo, '/agents', `Sign-in must return to /agents. ${seen}`);
    assert.equal(report.signIn, true, `The sign-in page must show its email field. ${seen}`);
    assert.equal(report.pageRequire, 'undefined', `The dashboard page must not have Node.js require. ${seen}`);
    assert.equal(report.ok, true, seen);
    assert.equal(existsSync(join(profile, 'DevToolsActivePort')), false, 'The packaged app opened a DevTools port');
    console.log('Packaged app opened its title bar and the live 1904 sign-in page.');
  } finally {
    await close(app);
  }
}

async function checkRefused(executablePath, root, label, args) {
  const profile = join(root, `refused-${label}`);
  const app = launch(executablePath, [`--user-data-dir=${profile}`, ...args], appEnv());
  const exit = await within(app.exited, REFUSAL_MS);
  if (!exit) await close(app);
  assert.ok(exit, `The packaged app kept running when started with ${args.join(' ')}. It printed:\n${app.output()}`);
  assert.equal(exit.code, REFUSED_EXIT_CODE,
    `Started with ${args.join(' ')}, the packaged app must refuse to start (exit ${REFUSED_EXIT_CODE}); it exited with ${exit.code ?? exit.signal}. It printed:\n${app.output()}`);
  assert.equal(existsSync(join(profile, 'DevToolsActivePort')), false, `Started with ${args.join(' ')}, the packaged app opened a DevTools port`);
  assert.doesNotMatch(app.output(), /DevTools listening on|Debugger listening on/, `Started with ${args.join(' ')}, the packaged app opened a debugger`);
}

// Were the RunAsNode or NodeOptions fuse on, the binary would run as Node.js: it would load the
// NODE_OPTIONS module and run the -e script, which each leave a mark, and exit 0. With both off it
// starts as the app, which refuses the --inspect-brk given after `--` (Node.js would treat that as a
// script argument) and exits.
async function checkNotNode(executablePath, root) {
  const mark = join(root, 'ran-as-node.txt');
  const hook = join(root, 'node-options-hook.cjs');
  writeFileSync(hook, `require('node:fs').appendFileSync(${JSON.stringify(mark)}, 'NODE_OPTIONS ');\n`);
  const script = `require('node:fs').appendFileSync(${JSON.stringify(mark)}, 'ELECTRON_RUN_AS_NODE ')`;
  const app = launch(executablePath, ['-e', script, '--', '--inspect-brk=0'],
    appEnv({ ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: `--require ${JSON.stringify(hook)}` }));
  const exit = await within(app.exited, REFUSAL_MS);
  if (!exit) await close(app);
  assert.equal(existsSync(mark), false,
    `The packaged app ran code as Node.js through ${existsSync(mark) ? readFileSync(mark, 'utf8').trim() : ''}`);
  assert.ok(exit, `Started with ELECTRON_RUN_AS_NODE, the packaged app kept running instead of refusing --inspect-brk. It printed:\n${app.output()}`);
  assert.equal(exit.code, REFUSED_EXIT_CODE,
    `Started with ELECTRON_RUN_AS_NODE, the packaged app must start as the app and refuse --inspect-brk (exit ${REFUSED_EXIT_CODE}); it exited with ${exit.code ?? exit.signal}. It printed:\n${app.output()}`);
}

async function smoke(executablePath) {
  assert.ok(executablePath, 'Pass the packaged application executable');
  const root = mkdtempSync(join(tmpdir(), '1904-desktop-smoke-'));
  try {
    await checkLaunch(executablePath, root);
    await checkRefused(executablePath, root, 'devtools-port', ['--remote-debugging-port=0']);
    await checkRefused(executablePath, root, 'inspector', ['--inspect=0']);
    await checkNotNode(executablePath, root);
    console.log('Packaged app refused the DevTools port, the Node.js inspector, ELECTRON_RUN_AS_NODE and NODE_OPTIONS.');
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

if (require.main === module) {
  smoke(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { smoke };
