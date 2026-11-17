const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installScreenCapture } = require('../screen-capture.cjs');

function fixture({ sources, failure } = {}) {
  let handler, options, template, popup, errors = 0, reads = 0;
  const frame = { url: 'https://1904.ai/agents' };
  const contents = { mainFrame: frame, getURL: () => frame.url, isDestroyed: () => false };
  const source = { id: 'window:1:0', name: 'Notes & tasks' };
  const allowed = installScreenCapture({
    setDisplayMediaRequestHandler(fn, opts) { handler = fn; options = opts; },
  }, {
    getContents: () => contents, getWindow: () => ({ isDestroyed: () => false }),
    desktopCapturer: { async getSources() { reads++; if (failure) throw failure; return sources ?? [source]; } },
    Menu: { buildFromTemplate(items) { template = items; return { popup(opts) { popup = opts; } }; } },
    is1904(value) { try { return new URL(value).origin === 'https://1904.ai'; } catch { return false; } },
    onError() { errors++; },
  });
  const request = { frame, securityOrigin: 'https://1904.ai', videoRequested: true, audioRequested: false, userGesture: true };
  const replies = [];
  const run = async (overrides = {}) => {
    handler({ ...request, ...overrides }, answer => replies.push(answer));
    await new Promise(resolve => setImmediate(resolve));
  };
  return { contents, frame, source, allowed, run, replies, options,
    get template() { return template; }, get popup() { return popup; },
    get errors() { return errors; }, get reads() { return reads; } };
}

test('screen permission is limited to the live dashboard main frame and 1904 origin', () => {
  const f = fixture();
  assert.equal(f.allowed(f.contents, 'https://1904.ai', true), true);
  assert.equal(f.allowed(f.contents, 'https://evil.example', true), false);
  assert.equal(f.allowed(f.contents, 'https://1904.ai', false), false);
  assert.equal(f.allowed({ ...f.contents }, 'https://1904.ai', true), false);
  f.frame.url = 'https://evil.example';
  assert.equal(f.allowed(f.contents, 'https://1904.ai', true), false);
});

test('use the OS picker where available; fallback grants only an explicitly chosen source, with no audio', async () => {
  const f = fixture();
  assert.equal(f.options.useSystemPicker, true);
  await f.run();
  assert.equal(f.reads, 1);
  assert.deepEqual(f.replies, []);
  const choice = f.template.find(item => item.label === 'Windows').submenu[0];
  assert.equal(choice.label, 'Notes && tasks');
  choice.click();
  f.popup.callback();
  assert.deepEqual(f.replies, [{ video: f.source }]);
});

test('cancelling the picker denies capture and allows a new attempt', async () => {
  const f = fixture();
  await f.run();
  f.popup.callback();
  assert.deepEqual(f.replies, [null]);
  await f.run();
  assert.equal(f.reads, 2);
});

test('untrusted frames, audio, missing gestures and concurrent requests never open another picker', async () => {
  const f = fixture();
  for (const overrides of [
    { frame: null }, { frame: { url: f.frame.url } }, { securityOrigin: 'https://evil.example' },
    { userGesture: false }, { audioRequested: true }, { videoRequested: false },
  ]) await f.run(overrides);
  assert.equal(f.reads, 0);
  assert.deepEqual(f.replies, Array(6).fill(null));
  await f.run();
  await f.run();
  assert.equal(f.reads, 1);
  assert.equal(f.replies.at(-1), null);
});

test('navigating while choosing revokes the capture', async () => {
  const f = fixture();
  await f.run();
  f.frame.url = 'https://1904.ai/settings';
  f.template.find(item => item.label === 'Windows').submenu[0].click();
  assert.deepEqual(f.replies, [null]);
});

test('an OS capture failure denies capture, explains the failure and releases the picker', async () => {
  const f = fixture({ failure: new Error('OS denied screen recording') });
  await f.run();
  assert.deepEqual(f.replies, [null]);
  assert.equal(f.errors, 1);
  await f.run();
  assert.equal(f.reads, 2);
});

test('no available sources never grants an undefined source', async () => {
  const f = fixture({ sources: [] });
  await f.run();
  assert.deepEqual(f.replies, [null]);
  assert.equal(f.template, undefined);
});
