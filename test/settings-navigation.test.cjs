const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');

// Exercise the real route, sender, layout and in-page navigation code without launching Electron.
function fixture() {
  const sent = [], bounds = [], handlers = new Map();
  const frame = { url: 'https://1904.ai/agents?app=shop' };
  const contents = { mainFrame: frame, getURL: () => frame.url, send: (...args) => sent.push(args) };
  const context = vm.createContext({
    URL, ORIGIN: 'https://1904.ai', CHROME_HEIGHT: 44,
    webUrl: href => { try { return new URL(href); } catch { return null; } },
    mainWindow: { isDestroyed: () => false, getContentSize: () => [1280, 800], webContents: contents },
    dashboardContents: contents, dashboardView: { setBounds: value => bounds.push({ ...value }) },
    contents, ipcMain: { on: (name, handler) => handlers.set(name, handler) },
    taskTitleBar: false, taskTabKeys: false,
  });
  vm.runInContext(source.slice(source.indexOf('function isTaskTitleBarPage('), source.indexOf('function installChromeHandlers(')), context);
  vm.runInContext(source.slice(source.indexOf("  ipcMain.on('1904:task-title-bar',"), source.indexOf("  ipcMain.on('1904:task-title-bar-menu',")), context);
  const start = source.indexOf("  contents.on('did-navigate-in-page',");
  const navigationCode = source.slice(start, source.indexOf('\n  });', start) + 6);
  contents.on = (name, handler) => handlers.set(name, handler);
  vm.runInContext(navigationCode, context);
  const event = { sender: contents, senderFrame: frame };
  const request = (channel, active, override = {}) => handlers.get(channel)({ ...event, ...override }, active);
  const navigate = (path, main = true) => {
    frame.url = new URL(path, 'https://1904.ai').href;
    handlers.get('did-navigate-in-page')({}, frame.url, main);
  };
  return { context, request, navigate, bounds, sent, frame, contents };
}

test('Agents → Settings → Agents retains the native view bounds and pauses task keys', () => {
  const f = fixture();
  f.request('1904:task-title-bar', true);
  f.request('1904:task-tab-keys', true);
  assert.equal(f.context.taskTitleBar, true);
  assert.equal(f.context.taskTabKeys, true);
  assert.deepEqual(f.bounds, [{ x: 0, y: 0, width: 1280, height: 800 }]);
  for (const path of ['/settings', '/settings/tasks', '/settings/history?app=other']) {
    f.navigate(path);
    assert.equal(f.context.taskTitleBar, true, path);
    assert.equal(f.context.taskTabKeys, false, path);
    f.request('1904:task-title-bar', true);
    f.request('1904:task-tab-keys', true);
    assert.equal(f.context.taskTabKeys, false, 'a stale replay cannot enable task keys in Settings');
    assert.equal(f.bounds.length, 1, 'no native resize');
  }
  f.navigate('/agents?app=shop');
  f.request('1904:task-title-bar', true);
  f.request('1904:task-tab-keys', true);
  assert.equal(f.context.taskTabKeys, true);
  assert.equal(f.bounds.length, 1);
  assert.ok(f.sent.some(([channel]) => channel === '1904:task-title-bar-replay'));
  f.navigate('/dashboard');
  assert.equal(f.context.taskTitleBar, false);
  assert.equal(f.context.taskTabKeys, false);
  assert.deepEqual(f.bounds.at(-1), { x: 0, y: 44, width: 1280, height: 756 });
});

test('Settings title-bar requests retain origin, sender and main-frame boundaries', () => {
  const f = fixture();
  for (const path of ['https://evil.example/settings', '/settings-untrusted', '/apps/shop/settings', '/dashboard']) {
    f.navigate(path);
    f.request('1904:task-title-bar', true);
    assert.equal(f.context.taskTitleBar, false, path);
  }
  f.navigate('/settings/tasks');
  f.request('1904:task-title-bar', true, { sender: {} });
  f.request('1904:task-title-bar', true, { senderFrame: { url: f.frame.url } });
  f.request('1904:task-title-bar', 'true');
  assert.equal(f.context.taskTitleBar, false);
  f.request('1904:task-title-bar', true);
  assert.equal(f.context.taskTitleBar, true);
  f.navigate('/dashboard', false);
  assert.equal(f.context.taskTitleBar, true, 'a child-frame navigation does not change native chrome');
});

test('older dashboards may still release and reacquire the title bar in Settings', () => {
  const f = fixture();
  f.request('1904:task-title-bar', true);
  f.navigate('/settings/tasks');
  f.request('1904:task-title-bar', false);
  assert.equal(f.context.taskTitleBar, false);
  f.navigate('/agents');
  f.request('1904:task-title-bar', true);
  assert.equal(f.context.taskTitleBar, true);
});
