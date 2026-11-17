const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const { installSnippetCapture, encodeSelection } = require('../snippet-capture.cjs');

const REQUEST = 'b7505bfc-b97c-4d63-8cab-f5d29af80861';
const PAGE = pathToFileURL(path.join(__dirname, '../snippet-capture.html')).href;

function fixture({ permission = 'granted', focused = true } = {}) {
  const handlers = new Map();
  const messages = new EventEmitter();
  const ipcMain = { handle: (key, fn) => handlers.set(key, fn), on: messages.on.bind(messages) };
  const sourceReads = [];
  const crops = [];
  const image = {
    getSize: () => ({ width: 640, height: 360 }),
    toDataURL: () => 'data:image/png;base64,full-source',
    toPNG: () => Buffer.from('full-source'),
    isEmpty: () => false,
    crop(rect) {
      crops.push(rect);
      return { isEmpty: () => false, toPNG: () => Buffer.from('cropped-source') };
    },
  };
  const display = { id: 8, bounds: { x: -500, y: 0, width: 500, height: 500 } };
  const secondDisplay = { id: 12, bounds: { x: 0, y: 0, width: 800, height: 600 } };
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [display, secondDisplay], getCursorScreenPoint: () => ({ x: -50, y: 10 }),
    getDisplayNearestPoint: () => display,
  });
  const desktopCapturer = { async getSources(options) {
    sourceReads.push(options.types[0]);
    if (options.types[0] === 'window') return [
      { id: 'window:44:1', name: 'Overlay', thumbnail: image },
      { id: 'window:88:0', name: 'Notes', thumbnail: image },
    ];
    return [{ display_id: '12', thumbnail: image }, { display_id: '8', thumbnail: image }];
  }};
  const dashboard = Object.assign(new EventEmitter(), { isDestroyed: () => false, mainFrame: { url: 'https://1904.ai/agents' } });
  const event = { sender: dashboard, senderFrame: dashboard.mainFrame };
  let overlay;
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: { url: PAGE },
        setWindowOpenHandler() {},
      });
      overlay = this;
    }
    isDestroyed() { return Boolean(this.destroyed); }
    destroy() { this.destroyed = true; this.emit('closed'); }
    getMediaSourceId() { return 'window:44:0'; }
    setBounds(bounds) { this.bounds = bounds; }
    async loadFile() {}
    show() {}
    focus() {}
  }
  installSnippetCapture({
    ipcMain, BrowserWindow, desktopCapturer, screen, nativeImage: { createFromBuffer: () => image },
    getContents: () => dashboard, getWindow: () => ({ isFocused: () => focused }),
    is1904: url => new URL(url).origin === 'https://1904.ai', permission: () => permission, theme: () => 'dark',
  });
  return {
    dashboard, sourceReads, crops, screen,
    get overlay() { return overlay; },
    start: (sender = event) => handlers.get('1904:snippet-start')(sender, REQUEST),
    command(action, input, sender = { sender: overlay.webContents, senderFrame: overlay.webContents.mainFrame }) {
      return handlers.get('1904:snippet-overlay')(sender, action, input);
    },
    dashboardCommand: (action, input) => handlers.get('1904:snippet-overlay')(event, action, input),
    cancel: id => messages.emit('1904:snippet-cancel', event, id),
  };
}

test('opens on the display under the pointer, switches display, and returns only the confirmed crop', async t => {
  const f = fixture();
  t.after(() => f.cancel(REQUEST));
  const result = f.start();
  await new Promise(setImmediate);
  assert.equal(f.overlay.options.x, -500);
  assert.equal(f.overlay.options.webPreferences.sandbox, true);
  assert.equal(await f.dashboardCommand('initial'), null);
  assert.equal(await f.dashboardCommand('attach', {}), null);

  const initial = await f.command('initial');
  assert.equal(initial.displayIndex, 0);
  assert.equal(initial.image, 'data:image/png;base64,full-source');
  const switched = await f.command('display', 1);
  assert.equal(f.overlay.bounds.x, 0);
  const rect = { x: 12, y: 20, width: 180, height: 90 };
  assert.equal(await f.command('attach', { revision: initial.revision, rect }), null);
  assert.deepEqual(f.crops, []);
  await f.command('attach', { revision: switched.revision, rect });
  assert.deepEqual(await result, { mime: 'image/png', data: Buffer.from('cropped-source').toString('base64') });
  assert.deepEqual(f.crops, [rect]);
  assert.equal(f.overlay.isDestroyed(), true);
});

test('window choices exclude the overlay and capture only after choosing a window', async t => {
  const f = fixture();
  t.after(() => f.cancel(REQUEST));
  const result = f.start();
  await new Promise(setImmediate);
  assert.deepEqual(f.sourceReads, ['screen']);
  assert.deepEqual(await f.command('windows'), ['Notes']);
  assert.deepEqual(f.sourceReads, ['screen', 'window']);
  assert.equal(await f.command('window', 4), null);
  const chosen = await f.command('window', 0);
  assert.ok(chosen.image);
  assert.deepEqual(f.sourceReads, ['screen', 'window', 'window']);
  await f.command('cancel');
  assert.equal(await result, null);
  assert.deepEqual(f.crops, []);
});

test('permission, sender, navigation and cancellation are scoped to the active request', async t => {
  const denied = fixture({ permission: 'denied' });
  assert.deepEqual(await denied.start(), { error: 'permission' });
  assert.deepEqual(denied.sourceReads, []);
  assert.equal(await fixture({ focused: false }).start(), null);

  const f = fixture();
  t.after(() => f.cancel(REQUEST));
  assert.equal(await f.start({ sender: f.dashboard, senderFrame: { url: 'https://1904.ai/agents' } }), null);
  const result = f.start();
  await new Promise(setImmediate);
  assert.deepEqual(await f.start(), { error: 'busy' });
  f.cancel('another-request');
  assert.equal(f.overlay.isDestroyed(), false);
  f.dashboard.emit('did-start-navigation', { isMainFrame: false });
  assert.equal(f.overlay.isDestroyed(), false);
  f.dashboard.emit('did-start-navigation', { isMainFrame: true });
  assert.equal(await result, null);
  assert.equal(f.overlay.isDestroyed(), true);
  assert.equal(f.screen.listenerCount('display-removed'), 0);
});

test('empty and out-of-bounds regions never reach the encoder', () => {
  const image = { getSize: () => ({ width: 640, height: 360 }), crop: () => assert.fail('Invalid crop') };
  for (const rect of [{ x: -1, y: 0, width: 12, height: 12 }, { x: 0, y: 0, width: 1, height: 12 },
    { x: 639, y: 0, width: 12, height: 12 }, { x: 0, y: 0, width: 12, height: NaN }]) {
    assert.equal(encodeSelection(image, rect), null);
  }
});
