const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const { FOLDERS_FILE, LINK_FILE, PAIR_PATH, connectPrompt, createComputerLink, pairComputer } = require('../computer-link.cjs');

const ORIGIN = 'https://1904.ai';
const TOKEN = 'tok_' + 'z'.repeat(40);
const PROOF_KEY = Buffer.alloc(32, 0x5a).toString('base64url');

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
  assert.match(prompt.detail, /only for messages you send from 1904 Desktop/);
  assert.doesNotMatch(prompt.detail, /1904 account/, 'an older 1904 names no account');
  const named = connectPrompt('Studio Mac', { email: 'dana@example.com', name: 'Dana' });
  assert.match(named.detail, /^1904 account: dana@example\.com \(Dana\)\. Only this account’s tasks can ask to use this computer\. If this is not your account, choose Cancel/);
});

test('connecting pairs with the dashboard session, names the account, and keeps the token and proof key encrypted', async t => {
  const dir = dataFolder(t);
  const link = createComputerLink({ dir, safeStorage: fakeSafeStorage() });
  const person = { email: 'dana@example.com', name: 'Dana' };
  const { fetch, calls } = fakeFetch(200, { id: 'cmp_00000001', token: TOKEN, name: 'Studio Mac', proofKey: PROOF_KEY, person });
  const asked = [];
  const connected = await pairComputer({
    link, fetch, origin: ORIGIN, computer,
    confirm: async (name, who) => { asked.push([name, who]); return true; },
    notice: async () => assert.fail('no notice when it works'),
  });
  assert.equal(connected, true);
  assert.deepEqual(asked, [['Studio Mac', person]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ORIGIN + PAIR_PATH);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.headers['x-1904-desktop-exchange'], '1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Studio Mac', platform: 'macos', shell: 'zsh', appVersion: '0.3.2' });

  const onDisk = readFileSync(join(dir, LINK_FILE), 'utf8');
  assert.doesNotMatch(onDisk, new RegExp(TOKEN), 'the token is never written in clear');
  assert.doesNotMatch(onDisk, new RegExp(PROOF_KEY), 'nor the proof key');
  assert.deepEqual(link.info(), { id: 'cmp_00000001', name: 'Studio Mac', account: 'dana@example.com' });
  const reopened = createComputerLink({ dir, safeStorage: fakeSafeStorage() });
  assert.equal(await reopened.token(), TOKEN, 'it survives a restart');
  assert.deepEqual(await reopened.proof(), { computerId: 'cmp_00000001', proofKey: PROOF_KEY });

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
  const cancelled = fakeFetch(200, { id: 'cmp_00000001', token: TOKEN, name: 'Studio Mac', proofKey: PROOF_KEY, person: { email: 'eve@example.com' } });
  assert.equal(await pairComputer({ link, fetch: cancelled.fetch, origin: ORIGIN, computer, confirm: async () => false, notice: async () => {} }), false);
  assert.deepEqual(cancelled.calls.map(call => call.init.method), ['POST', 'DELETE'], 'Cancel takes the pairing back from 1904 at once');
  assert.equal(cancelled.calls[1].init.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(cancelled.calls[1].init.redirect, 'error');
  assert.equal(link.info(), undefined, 'and keeps nothing here');
  for (const [status, body, pattern] of [
    [401, {}, /Sign in to 1904 first/],
    [409, { error: 'You can connect up to 5 computers.' }, /up to 5 computers/],
    [409, {}, /Disconnect one in 1904 Settings/],
    [200, { id: 'cmp_00000001', token: 'short', name: 'x', proofKey: PROOF_KEY }, /Check your connection/],
    [200, { id: 'cmp_00000001', token: TOKEN, name: 'x' }, /Check your connection/],
    [200, { id: 'cmp_00000001', token: TOKEN, name: 'x', proofKey: 'pk_' + 'q'.repeat(30) }, /Check your connection/],
    [200, { id: 'cmp_00000001', token: TOKEN, name: 'x', proofKey: Buffer.alloc(16).toString('base64url') }, /Check your connection/],
    [503, { error: '1904 can’t connect computers right now.', code: 'computer.unavailable' }, /can’t connect computers right now/],
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

test('a saved folder choice that is no longer allowed is dropped when read, whoever wrote the file', t => {
  const dir = dataFolder(t);
  const good = join(dir, 'checkout');
  const bad = join(dir, 'secrets');
  writeFileSync(join(dir, FOLDERS_FILE), JSON.stringify({ app_1: { path: good, name: 'Shop' }, app_2: { path: bad, name: 'Blog' } }));
  const link = createComputerLink({ dir, safeStorage: fakeSafeStorage(), folderProblem: folder => folder === bad ? 'Not here.' : undefined });
  assert.deepEqual(Object.keys(link.folders.all()), ['app_1']);
  assert.equal(link.folders.get('app_2'), undefined);
  assert.equal(link.folders.set('app_3', bad), false, 'and never saved');
});

test('the Pause switch survives a restart', t => {
  const dir = dataFolder(t);
  const link = createComputerLink({ dir, safeStorage: fakeSafeStorage() });
  assert.equal(link.paused(), false);
  link.setPaused(true);
  assert.equal(createComputerLink({ dir, safeStorage: fakeSafeStorage() }).paused(), true);
  link.setPaused(false);
  assert.equal(link.paused(), false);
});

test('when this computer last heard from 1904 is kept, written at most hourly', async t => {
  const dir = dataFolder(t);
  let now = 5_000_000;
  const link = createComputerLink({ dir, safeStorage: fakeSafeStorage(), now: () => now });
  await link.save({ id: 'cmp_00000001', name: 'Studio Mac', token: TOKEN, proofKey: PROOF_KEY });
  assert.equal(link.seenAt(), 5_000_000);
  now += 60_000;
  link.touch();
  assert.equal(link.seenAt(), now, 'the first answer after starting is written');
  const first = now;
  now += 30 * 60_000;
  link.touch();
  assert.equal(link.seenAt(), first, 'not again within the hour');
  now += 31 * 60_000;
  link.touch();
  assert.equal(link.seenAt(), now);
});
