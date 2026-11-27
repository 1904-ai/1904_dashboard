const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { resumePrompt } = require('../computer-link.cjs');

const main = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');
const preload = readFileSync(join(__dirname, '..', 'dashboard-preload.cjs'), 'utf8');

// Settings → 1904 Desktop in the dashboard: the real sender rule and handlers from main.cjs, without Electron.
function fixture({ paused = false, connected = true, updates = true, updateReady = false, answer = 1 } = {}) {
  const handlers = new Map();
  const asked = [], checks = [];
  const frame = { url: 'https://1904.ai/settings/desktop' };
  const contents = { mainFrame: frame, isFocused: () => true };
  const state = { paused, stamp: true };
  const context = vm.createContext({
    URL, console, ORIGIN: 'https://1904.ai',
    webUrl: href => { try { return new URL(href); } catch { return null; } },
    isTaskTitleBarPage: href => new URL(href).pathname === '/agents',
    dashboardContents: contents, mainWindow: { isFocused: () => true },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler), on: (name, handler) => handlers.set(name, handler) },
    computerBridge: {}, computerResuming: undefined,
    computerLink: { info: () => connected ? { id: 'cmp_studio01', name: 'Studio Mac' } : undefined, paused: () => state.paused },
    computerState: () => ({ connected, paused: state.paused }),
    setComputerPaused: value => { state.paused = value; },
    computerInput: { decide: () => ({ stamp: state.stamp }) },
    computerParent: () => undefined,
    messageBox: async options => { asked.push(options); return { response: typeof answer === 'function' ? answer() : answer }; },
    resumePrompt,
    app: { getVersion: () => '0.5.0' },
    menuUpdates: updates ? { check: () => { checks.push('check'); } } : undefined, updateReady,
    startAwayFromDashboard: () => null, readDeviceInfo: () => null, connectComputer: () => null, showActivity: () => {},
  });
  vm.runInContext(main.slice(main.indexOf('const COMPUTER_SETTINGS_PAGES'), main.indexOf('function showActivity(')), context);
  const start = main.indexOf("  ipcMain.handle('1904:computer-pause',");
  vm.runInContext(main.slice(start, main.indexOf("  ipcMain.on('1904:computer-activity',", start)), context);
  const event = { sender: contents, senderFrame: frame };
  const call = (channel, ...args) => handlers.get(channel)(event, ...args);
  return { context, call, handlers, state, asked, checks, frame, event };
}

test('only the dashboard, Settings → Computers and Settings → 1904 Desktop reach the computer', () => {
  const f = fixture();
  const allowed = href => vm.runInContext(`isComputerPage(${JSON.stringify(href)})`, f.context);
  assert.equal(allowed('https://1904.ai/agents'), true);
  assert.equal(allowed('https://1904.ai/settings/computers'), true);
  assert.equal(allowed('https://1904.ai/settings/desktop'), true);
  assert.equal(allowed('https://1904.ai/settings/desktop/'), true);
  assert.equal(allowed('https://1904.ai/settings/billing'), false);
  assert.equal(allowed('https://1904.ai/settings/desktop/more'), false);
  assert.equal(allowed('https://example.com/settings/desktop'), false);
});

test('the page pauses at once, even without a recent click', async () => {
  const f = fixture();
  f.state.stamp = false;
  assert.deepEqual(await f.call('1904:computer-pause', true), { connected: true, paused: true });
  assert.equal(f.asked.length, 0, 'taking access away needs no question');
});

test('turning Pause off is the person’s answer in Desktop’s own dialog', async () => {
  const cancelled = fixture({ paused: true, answer: 0 });
  assert.deepEqual(await cancelled.call('1904:computer-pause', false), { connected: true, paused: true });
  assert.equal(cancelled.asked[0].message, 'Resume Use My Computer on Studio Mac?');
  assert.deepEqual([cancelled.asked[0].buttons, cancelled.asked[0].defaultId, cancelled.asked[0].cancelId], [['Cancel', 'Resume'], 0, 0], 'Return and Escape both cancel');

  const resumed = fixture({ paused: true, answer: 1 });
  assert.deepEqual(await resumed.call('1904:computer-pause', false), { connected: true, paused: false });

  const unasked = fixture({ paused: true });
  unasked.state.stamp = false;
  assert.deepEqual(await unasked.call('1904:computer-pause', false), { connected: true, paused: true }, 'a page cannot resume at a moment of its own choosing');
  assert.equal(unasked.asked.length, 0);
});

test('two resume requests ask once, and a computer disconnected meanwhile stays as it is', async () => {
  const f = fixture({ paused: true });
  const [first, second] = await Promise.all([f.call('1904:computer-pause', false), f.call('1904:computer-pause', false)]);
  assert.equal(f.asked.length, 1);
  assert.deepEqual([first.paused, second.paused], [false, false]);

  let connected = true;
  const gone = fixture({ paused: true, answer: () => { connected = false; return 1; } });
  gone.context.computerLink.info = () => connected ? { id: 'cmp_studio01', name: 'Studio Mac' } : undefined;
  await gone.call('1904:computer-pause', false);
  assert.equal(gone.state.paused, true);
});

test('pause requests from elsewhere, for no computer, or without a yes or no change nothing', async () => {
  const f = fixture();
  assert.equal(await f.handlers.get('1904:computer-pause')({ ...f.event, senderFrame: { url: 'https://1904.ai/settings/billing' } }, true), null);
  assert.equal(await f.handlers.get('1904:computer-pause')({ sender: {}, senderFrame: f.frame }, true), null);
  assert.deepEqual(await f.call('1904:computer-pause', 'yes'), { connected: true, paused: false });
  assert.equal(f.state.paused, false);
  const none = fixture({ connected: false });
  assert.deepEqual(await none.call('1904:computer-pause', true), { connected: false, paused: false });
});

test('Settings reads the version and starts the Help menu’s update check, only on a click', () => {
  const f = fixture({ updateReady: true });
  assert.deepEqual({ ...f.call('1904:app-info') }, { version: '0.5.0', updates: true, updateReady: true });
  assert.equal(f.handlers.get('1904:app-info')({ ...f.event, senderFrame: { url: 'https://1904.ai/settings/billing' } }), null);
  f.call('1904:app-check-updates');
  assert.deepEqual(f.checks, ['check']);
  f.state.stamp = false;
  f.call('1904:app-check-updates');
  assert.deepEqual(f.checks, ['check'], 'not at a moment of the page’s choosing');

  const unpackaged = fixture({ updates: false, updateReady: true });
  assert.deepEqual({ ...unpackaged.call('1904:app-info') }, { version: '0.5.0', updates: false, updateReady: false });
  unpackaged.call('1904:app-check-updates');
  assert.deepEqual(unpackaged.checks, []);
});

test('the page gets these calls and nothing that runs, approves or reads a command', () => {
  assert.match(preload, /setPaused: paused => typeof paused === 'boolean' \? ipcRenderer\.invoke\('1904:computer-pause', paused\) : Promise\.resolve\(null\)/);
  assert.match(preload, /app: \{\s+info: \(\) => ipcRenderer\.invoke\('1904:app-info'\),\s+checkForUpdates: \(\) => ipcRenderer\.send\('1904:app-check-updates'\),\s+\}/);
  assert.match(resumePrompt('').message, /on this computer\?$/);
  assert.match(resumePrompt('Studio Mac').detail, /still asks you here first/);
});
