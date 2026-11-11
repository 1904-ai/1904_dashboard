const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const { FOLDERS_FILE, LINK_FILE, PAIR_PATH, connectPrompt, createComputerLink, pairComputer } = require('../computer-link.cjs');

const ORIGIN = 'https://1904.ai';
const TOKEN = 'tok_' + 'z'.repeat(40);

function dataFolder(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, '1904-computer-link-test-'));
  t.after(() => {
    const target = realpathSync(dir);
    assert.equal(dirname(target), parent);
    assert.match(basename(target), /^1904-computer-link-test-/);
    rmSync(target, { recursive: true });
  });
  return dir;
}

// Stands in for Electron's safeStorage: reversible, but never the plain text.
function fakeSafeStorage({ available = true } = {}) {
  const flip = buffer => Buffer.from(buffer.map(byte => byte ^ 0x5a));
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async text => flip(Buffer.from('sealed:' + text)),
    decryptStringAsync: async bytes => ({ result: flip(bytes).toString().replace(/^sealed:/, ''), shouldReEncrypt: false }),
  };
}

function fakeFetch(status, body) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { fetch, calls };
}

const computer = { name: 'Studio Mac', platform: 'macos', shell: 'zsh', appVersion: '0.3.2' };

test('the connect prompt defaults to Cancel', () => {
  const prompt = connectPrompt('Studio Mac');
  assert.equal(prompt.message, 'Connect this computer to 1904 as Studio Mac?');
  assert.deepEqual(prompt.buttons, ['Cancel', 'Connect']);
  assert.deepEqual([prompt.defaultId, prompt.cancelId], [0, 0], 'Return and Escape both cancel');
  assert.match(prompt.detail, /runs as you, with your permissions/);
});

test('connecting asks first, then pairs with the dashboard session and keeps the token encrypted', async t => {
  const dir = dataFolder(t);
  const link = createComputerLink({ dir, safeStorage: fakeSafeStorage() });
  const { fetch, calls } = fakeFetch(200, { id: 'cmp_00000001', token: TOKEN, name: 'Studio Mac' });
  const asked = [];
  const connected = await pairComputer({
    link, fetch, origin: ORIGIN, computer,
    confirm: async name => { asked.push(name); return true; },
    notice: async () => assert.fail('no notice when it works'),
  });
  assert.equal(connected, true);
  assert.deepEqual(asked, ['Studio Mac']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ORIGIN + PAIR_PATH);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers['x-1904-desktop-exchange'], '1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Studio Mac', platform: 'macos', shell: 'zsh', appVersion: '0.3.2' });

  const onDisk = readFileSync(join(dir, LINK_FILE), 'utf8');
  assert.doesNotMatch(onDisk, new RegExp(TOKEN), 'the token is never written in clear');
  assert.deepEqual(link.info(), { id: 'cmp_00000001', name: 'Studio Mac' });
  const reopened = createComputerLink({ dir, safeStorage: fakeSafeStorage() });
  assert.equal(await reopened.token(), TOKEN, 'it survives a restart');

  reopened.rename('Studio Mac Pro');
  assert.equal(createComputerLink({ dir, safeStorage: fakeSafeStorage() }).info().name, 'Studio Mac Pro');
  reopened.forget();
  assert.equal(reopened.info(), undefined);
  assert.equal(await reopened.token(), undefined);
  assert.deepEqual(readdirSync(dir), []);
});

test('without the system’s secure storage the computer is not connected at all', async t => {
  const dir = dataFolder(t);
  const link = createComputerLink({ dir, safeStorage: fakeSafeStorage({ available: false }) });
  const { fetch, calls } = fakeFetch(200, { id: 'cmp_00000001', token: TOKEN, name: 'Studio Mac' });
  const notices = [];
  const connected = await pairComputer({
    link, fetch, origin: ORIGIN, computer,
    confirm: async () => assert.fail('it does not ask to connect what it cannot keep'),
    notice: async view => notices.push(view),
  });
  assert.equal(connected, false);
  assert.equal(calls.length, 0, '1904 is never asked for a token');
  assert.match(notices[0].message, /isn’t available/);
  assert.deepEqual(readdirSync(dir), []);
  await assert.rejects(link.save({ id: 'cmp_00000001', name: 'x', token: TOKEN }), /Secure storage/);
});

test('cancel, signed out, too many computers and a bad answer leave nothing behind', async t => {
  const dir = dataFolder(t);
  const link = createComputerLink({ dir, safeStorage: fakeSafeStorage() });
  const cancelled = fakeFetch(200, {});
  assert.equal(await pairComputer({ link, fetch: cancelled.fetch, origin: ORIGIN, computer, confirm: async () => false, notice: async () => {} }), false);
  assert.equal(cancelled.calls.length, 0, 'cancelling sends nothing');
  for (const [status, body, pattern] of [
    [401, {}, /Sign in to 1904 first/],
    [409, { error: 'You can connect up to 5 computers.' }, /up to 5 computers/],
    [409, {}, /Disconnect one in 1904 Settings/],
    [200, { id: 'cmp_00000001', token: 'short', name: 'x' }, /Check your connection/],
    [500, {}, /Check your connection/],
  ]) {
    const notices = [];
    const { fetch } = fakeFetch(status, body);
    assert.equal(await pairComputer({ link, fetch, origin: ORIGIN, computer, confirm: async () => true, notice: async view => notices.push(view) }), false);
    assert.match(notices[0].detail + notices[0].message, pattern, String(status));
  }
  assert.deepEqual(readdirSync(dir), []);
});

test('each app’s folder choice is kept by app id and can be reset', async t => {
  const dir = dataFolder(t);
  const link = createComputerLink({ dir, safeStorage: fakeSafeStorage() });
  const folder = join(dir, 'checkout');
  assert.equal(link.folders.get('app_1'), undefined);
  assert.equal(link.folders.set('app_1', folder, { name: 'Shop', repo: 'shop' }), true);
  assert.equal(link.folders.set('__proto__', folder), false);
  assert.equal(link.folders.set('app_2', 'relative/path'), false);
  assert.equal(createComputerLink({ dir, safeStorage: fakeSafeStorage() }).folders.get('app_1'), folder);
  assert.deepEqual(link.folders.all(), { app_1: { path: folder, name: 'Shop', repo: 'shop' } });
  assert.equal(link.folders.get('constructor'), undefined);
  assert.equal(link.folders.reset('app_1'), true);
  assert.equal(link.folders.reset('app_1'), false);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, FOLDERS_FILE), 'utf8')), {});
});
