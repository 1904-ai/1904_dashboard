const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');
const { REFUSED_EXIT_CODE, guardStartup, refusedSwitch, startupRefusal, startSmokeReport, switchName } = require('../startup-guard.cjs');

const exe = '/Applications/1904 Desktop.app/Contents/MacOS/1904 Desktop';
const winExe = 'C:\\Users\\me\\AppData\\Local\\Programs\\1904 Desktop\\1904 Desktop.exe';
const noSwitches = { hasSwitch: () => false };
const refusal = (args, options = {}) => startupRefusal({
  argv: [options.platform === 'win32' ? winExe : exe, ...args], commandLine: noSwitches, packaged: true, platform: 'darwin', ...options,
});

test('a packaged build refuses debugger, DevTools, process-wrapper and traffic-capture switches', () => {
  for (const arg of [
    '--remote-debugging-port=9222', '--remote-debugging-port=0', '--remote-debugging-pipe', '--remote-debugging-address=0.0.0.0',
    '--remote-allow-origins=*', '--inspect', '--inspect=0', '--inspect-brk=127.0.0.1:9229', '--inspect-brk-node', '--inspect-port=9229',
    '--inspect-publish-uid=http', '--inspect-wait', '--inspect-anything-new', '--debug', '--debug-brk', '--debug-port=5858',
    '--js-flags=--allow-natives-syntax', '--auto-open-devtools-for-tabs', '--wait-for-debugger', '--wait-for-debugger-children=renderer',
    '--renderer-cmd-prefix=gdb --args', '--gpu-launcher=x', '--utility-cmd-prefix=x', '--browser-subprocess-path=/tmp/x',
    '--log-net-log=/tmp/net.json', '--net-log-capture-mode=Everything', '--ssl-key-log-file=/tmp/keys',
    '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list=abc', '--use-mock-keychain',
  ]) {
    assert.match(refusal([arg]) || '', /^1904 Desktop does not start with --[a-z-]+\./, arg);
  }
});

test('spelling variants Chromium and Node.js accept are refused too', () => {
  for (const arg of ['-remote-debugging-port=9222', '--Remote-Debugging-Port=9222', '--inspect_brk=9229', '--INSPECT', '--js_flags=--x']) {
    assert.ok(refusal([arg]), arg);
  }
  assert.ok(refusal(['/remote-debugging-port=9222'], { platform: 'win32' }), 'Chromium reads / switches on Windows');
  assert.ok(refusal(['/INSPECT'], { platform: 'win32' }));
  assert.equal(refusal(['/remote-debugging-port=9222']), null, 'on macOS a / argument is a path, not a switch');
});

test('a switch after -- or after other arguments is still refused', () => {
  assert.ok(refusal(['-e', 'console.log(1)', '--', '--inspect-brk=0']));
  assert.ok(refusal(['app-1904://task?url=x', '--remote-debugging-port=1']));
});

test('ordinary starts are allowed', () => {
  for (const args of [
    [],
    ['app-1904://task?url=https%3A%2F%2F1904.ai%2Fagents%3Ftask%3Dabc'],
    ['app-1904://import?--inspect'],
    ['--user-data-dir=/tmp/profile'],
    ['-psn_0_12345'],
    ['--updated', '--force-run'],
    ['--enable-logging'],
    ['inspect'],
  ]) {
    assert.equal(refusal(args), null, args.join(' '));
  }
  assert.equal(refusal(['C:\\Users\\me\\inspect'], { platform: 'win32' }), null);
});

test('the executable path itself is never read as a switch', () => {
  assert.equal(refusedSwitch({ argv: ['--inspect'], commandLine: noSwitches, platform: 'darwin' }), null);
});

test('an unpackaged build allows debugging', () => {
  assert.equal(refusal(['--remote-debugging-port=9222', '--inspect-brk'], { packaged: false }), null);
});

test("Chromium's own reading of the command line is checked as well", () => {
  const commandLine = { hasSwitch: name => name === 'remote-debugging-pipe' };
  assert.equal(refusedSwitch({ argv: [exe], commandLine, platform: 'darwin' }), 'remote-debugging-pipe');
  assert.match(startupRefusal({ argv: [exe], commandLine, packaged: true, platform: 'darwin' }), /--remote-debugging-pipe\./);
});

test('the reason names the switch but never repeats its value', () => {
  const reason = refusal(['--log-net-log=/Users/me/secret-path.json']);
  assert.match(reason, /--log-net-log\./);
  assert.doesNotMatch(reason, /secret-path/);
});

test('switch names are read the way Chromium and Node.js read them', () => {
  assert.equal(switchName('--Inspect_Brk=9229', 'win32'), 'inspect-brk');
  assert.equal(switchName('/js-flags=--x', 'win32'), 'js-flags');
  assert.equal(switchName('/js-flags=--x', 'darwin'), null);
  assert.equal(switchName('app-1904://task', 'win32'), null);
  assert.equal(switchName('--', 'darwin'), null);
  assert.equal(switchName(undefined, 'darwin'), null);
});

function fakeApp({ packaged = true, switches = [] } = {}) {
  const present = new Set(switches);
  const app = {
    isPackaged: packaged,
    exitCode: undefined,
    removed: [],
    commandLine: {
      hasSwitch: name => present.has(name),
      removeSwitch: name => { present.delete(name); app.removed.push(name); },
    },
    exit: code => { app.exitCode = code; },
  };
  return app;
}

test('guardStartup removes the switches, says why on stderr, and exits a refused start', () => {
  const app = fakeApp({ switches: ['remote-debugging-port'] });
  const written = [];
  const refusedStart = guardStartup(app, { argv: [exe, '--remote-debugging-port=9222'], platform: 'darwin', write: text => written.push(text) });
  assert.equal(refusedStart, true);
  assert.equal(app.exitCode, REFUSED_EXIT_CODE);
  assert.deepEqual(app.removed, ['remote-debugging-port']);
  assert.equal(app.commandLine.hasSwitch('remote-debugging-port'), false);
  assert.match(written.join(''), /^1904 Desktop does not start with --remote-debugging-port\..*\n$/);
});

test('guardStartup exits even when nothing can be written to stderr', () => {
  const app = fakeApp();
  guardStartup(app, { argv: [exe, '--inspect'], platform: 'darwin', write: () => { throw new Error('EBADF'); } });
  assert.equal(app.exitCode, REFUSED_EXIT_CODE);
});

test('guardStartup leaves an ordinary or unpackaged start alone', () => {
  for (const [app, argv] of [
    [fakeApp(), [exe, 'app-1904://import']],
    [fakeApp({ packaged: false, switches: ['remote-debugging-port'] }), [exe, '--remote-debugging-port=9222']],
  ]) {
    assert.equal(guardStartup(app, { argv, platform: 'darwin', write: () => assert.fail('nothing to say') }), false);
    assert.equal(app.exitCode, undefined);
    assert.deepEqual(app.removed, []);
  }
});

test('main.cjs runs the guard before anything else and starts the smoke report once the window is up', () => {
  const main = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');
  const statements = main.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('//'));
  assert.match(statements[0], /^const \{[^}]*\bapp\b[^}]*\} = require\('electron'\);$/);
  assert.match(statements[1], /^const \{[^}]*\bguardStartup\b[^}]*\} = require\('\.\/startup-guard\.cjs'\);$/);
  assert.equal(statements[2], 'guardStartup(app);');
  assert.match(main, /showDashboard\(\);\r?\n\s+startSmokeReport\(\{ file: process\.env\.DESKTOP_SMOKE_REPORT, origin: ORIGIN,/);
});

const ORIGIN = 'https://1904.ai';

function contents(url, answers = {}) {
  return {
    url,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    getURL() { return this.url; },
    async executeJavaScript(code) {
      for (const [needle, answer] of Object.entries(answers)) {
        if (code.includes(needle)) {
          if (answer instanceof Error) throw answer;
          return typeof answer === 'function' ? answer() : answer;
        }
      }
      throw new Error(`unexpected script ${code}`);
    },
  };
}

function reportFixture(t) {
  const tempParent = realpathSync(tmpdir());
  const root = mkdtempSync(join(tempParent, '1904-startup-guard-test-'));
  t.after(() => {
    const target = realpathSync(root);
    assert.equal(dirname(target), tempParent);
    assert.match(basename(target), /^1904-startup-guard-test-/);
    rmSync(target, { recursive: true });
  });
  return join(root, 'report.json');
}

async function waitForFile(file, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(10)) {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  }
  return null;
}

test('without DESKTOP_SMOKE_REPORT the app reads nothing from its pages', () => {
  const read = () => assert.fail('no page is read');
  assert.equal(startSmokeReport({ file: undefined, origin: ORIGIN, chrome: read, dashboard: read }), null);
  assert.equal(startSmokeReport({ file: '', origin: ORIGIN, chrome: read, dashboard: read }), null);
});

test('the smoke report is written once the title bar and the sign-in page are up', async t => {
  const file = reportFixture(t);
  const chrome = contents('file:///C:/app/resources/app.asar/chrome.html', { 'Application menu': true });
  const dashboard = contents('https://1904.ai/agents', { 'input[type=email]': true, 'typeof globalThis.require': 'undefined' });
  startSmokeReport({ file, origin: ORIGIN, chrome: () => chrome, dashboard: () => dashboard, interval: 5 });
  await sleep(30);
  assert.equal(existsSync(file), false, 'not before the sign-in page opens');
  dashboard.url = 'https://1904.ai/login?returnTo=%2Fagents';
  assert.deepEqual(await waitForFile(file), {
    ok: true, titleBar: true, dashboard: 'https://1904.ai/login', returnTo: '/agents', signIn: true, pageRequire: 'undefined',
  });
});

test('a page that exposes require never passes, and the report says what was seen', async t => {
  const file = reportFixture(t);
  const chrome = contents('file:///app/chrome.html', { 'Application menu': true });
  const dashboard = contents('https://1904.ai/login?returnTo=%2Fagents&task=secret', { 'input[type=email]': true, 'typeof globalThis.require': 'function' });
  startSmokeReport({ file, origin: ORIGIN, chrome: () => chrome, dashboard: () => dashboard, timeout: 40, interval: 5 });
  const report = await waitForFile(file);
  assert.equal(report.ok, false);
  assert.equal(report.pageRequire, 'function');
  assert.equal(report.dashboard, 'https://1904.ai/login', 'only the origin and path, never the rest of the address');
});

test('a hidden menu button, a missing window or another site times out as a failed report', async t => {
  for (const [chrome, dashboard, expected] of [
    [contents('file:///app/chrome.html', { 'Application menu': false }), contents('https://1904.ai/login?returnTo=%2Fagents', { 'input[type=email]': true, 'typeof globalThis.require': 'undefined' }), { titleBar: false, signIn: true }],
    [undefined, undefined, { titleBar: false, dashboard: null }],
    [contents('file:///app/chrome.html', { 'Application menu': new Error('destroyed') }), contents('https://example.com/login?returnTo=%2Fagents'), { titleBar: false, dashboard: 'https://example.com', signIn: false }],
  ]) {
    const file = reportFixture(t);
    startSmokeReport({ file, origin: ORIGIN, chrome: () => chrome, dashboard: () => dashboard, timeout: 30, interval: 5 });
    const report = await waitForFile(file);
    assert.equal(report.ok, false);
    for (const [key, value] of Object.entries(expected)) assert.equal(report[key], value, key);
  }
});

test('the smoke report never replaces an existing file', async t => {
  const file = reportFixture(t);
  writeFileSync(file, 'keep me');
  const warn = t.mock.method(console, 'warn', () => {});
  const chrome = contents('file:///app/chrome.html', { 'Application menu': true });
  const dashboard = contents('https://1904.ai/login?returnTo=%2Fagents', { 'input[type=email]': true, 'typeof globalThis.require': 'undefined' });
  startSmokeReport({ file, origin: ORIGIN, chrome: () => chrome, dashboard: () => dashboard, interval: 5 });
  for (let i = 0; i < 100 && warn.mock.callCount() === 0; i++) await sleep(10);
  assert.equal(readFileSync(file, 'utf8'), 'keep me');
  assert.equal(warn.mock.callCount(), 1);
});

test('stop ends the report without writing it', async t => {
  const file = reportFixture(t);
  const chrome = contents('file:///app/chrome.html', { 'Application menu': true });
  const dashboard = contents('https://1904.ai/agents');
  const report = startSmokeReport({ file, origin: ORIGIN, chrome: () => chrome, dashboard: () => dashboard, timeout: 20, interval: 5 });
  report.stop();
  await sleep(60);
  assert.equal(existsSync(file), false);
});
