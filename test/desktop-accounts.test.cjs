const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  DEFAULT_ACCOUNT_ID,
  DEFAULT_PARTITION,
  MAX_ACCOUNTS,
  accountInitials,
  accountLabel,
  createAccountStore,
  isAccountId,
  partitionForAccount,
} = require('../desktop-accounts.cjs');
const { createDesktopBrowserBridge } = require('../browser-bridge.cjs');
const { startSignIn } = require('../desktop-links.cjs');

function tempFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), '1904-accounts-'));
  return { dir, file: path.join(dir, 'accounts.json'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('starts with the legacy default partition and never exposes partitions in snapshot', () => {
  const tmp = tempFile();
  try {
    let t = 1000;
    const store = createAccountStore({ file: tmp.file, now: () => ++t });
    assert.equal(store.active().id, DEFAULT_ACCOUNT_ID);
    assert.equal(store.active().partition, DEFAULT_PARTITION);
    const snap = store.snapshot();
    assert.equal(snap.activeId, DEFAULT_ACCOUNT_ID);
    assert.equal(snap.canAdd, true);
    assert.equal(snap.accounts.length, 1);
    assert.equal('partition' in snap.accounts[0], false);
  } finally {
    tmp.cleanup();
  }
});

test('supports adding accounts, one-click switching, persistence, and pruning abandoned adds', () => {
  const tmp = tempFile();
  try {
    let t = 1000;
    let seq = 0;
    const store = createAccountStore({
      file: tmp.file,
      now: () => ++t,
      randomId: () => `acct_${String(++seq).padStart(16, '0')}`,
    });

    const syncedA = store.syncActive({ userId: 'u_alice', email: 'alice@example.com', name: 'Alice Smith', workspaceName: 'Acme' });
    assert.equal(syncedA.changed, true);
    assert.equal(store.active().email, 'alice@example.com');

    // Start adding account 2
    const addedB = store.beginAdd();
    assert.equal(addedB.ok, true);
    assert.equal(addedB.account.id, 'acct_0000000000000001');
    assert.equal(addedB.account.partition, 'persist:1904-agents-acct_0000000000000001');
    assert.equal(store.active().id, addedB.account.id);

    // Sync account 2
    store.syncActive({ userId: 'u_bob', email: 'bob@studio.dev', name: 'Bob Jones', workspaceName: 'Studio' });
    assert.equal(store.snapshot().accounts.length, 2);

    // One-click switch back to Alice
    const back = store.switchTo(DEFAULT_ACCOUNT_ID);
    assert.equal(back.ok, true);
    assert.equal(back.changed, true);
    assert.equal(back.account.email, 'alice@example.com');
    assert.deepEqual(back.removedPartitions, []);

    // Start adding account 3, then abandon by switching to Bob: empty pending slot is pruned
    const pendingC = store.beginAdd();
    assert.equal(pendingC.ok, true);
    assert.equal(store.snapshot().accounts.length, 3);
    const toBob = store.switchTo(addedB.account.id);
    assert.equal(toBob.ok, true);
    assert.equal(toBob.changed, true);
    assert.deepEqual(toBob.removedPartitions, [pendingC.account.partition]);
    assert.equal(store.snapshot().accounts.length, 2);

    // Persists across restarts
    const reloaded = createAccountStore({ file: tmp.file, now: () => ++t });
    assert.equal(reloaded.active().id, addedB.account.id);
    assert.equal(reloaded.snapshot().accounts.length, 2);
    assert.equal(reloaded.partitionForEmail('ALICE@example.com'), DEFAULT_PARTITION);
    assert.equal(reloaded.partitionForEmail('bob@studio.dev'), addedB.account.partition);
  } finally {
    tmp.cleanup();
  }
});

test('deduplicates when adding an account that is already saved', () => {
  const tmp = tempFile();
  try {
    let t = 2000;
    let seq = 0;
    const store = createAccountStore({
      file: tmp.file,
      now: () => ++t,
      randomId: () => `acct_${String(++seq).padStart(16, '0')}`,
    });

    store.syncActive({ userId: 'u_alice', email: 'alice@example.com', name: 'Alice' });
    const pending = store.beginAdd();
    const dup = store.syncActive({ userId: 'u_alice', email: 'alice@example.com', name: 'Alice Updated' });
    assert.equal(dup.deduplicated, true);
    assert.equal(dup.active.id, DEFAULT_ACCOUNT_ID);
    assert.equal(dup.active.name, 'Alice Updated');
    assert.deepEqual(dup.removedPartitions, [pending.account.partition]);
    assert.equal(store.snapshot().accounts.length, 1);

    // When the earlier duplicate was signed out, keep the freshly signed-in slot and drop the stale one
    store.markSignedOut(DEFAULT_ACCOUNT_ID);
    const fresh = store.beginAdd();
    const reauthed = store.syncActive({ userId: 'u_alice', email: 'alice@example.com', name: 'Alice Fresh' });
    assert.equal(reauthed.deduplicated, false);
    assert.equal(reauthed.active.id, fresh.account.id);
    assert.equal(reauthed.active.signedIn, true);
    assert.deepEqual(reauthed.removedPartitions, [DEFAULT_PARTITION]);
    assert.equal(store.snapshot().accounts.length, 1);
  } finally {
    tmp.cleanup();
  }
});

test('enforces max accounts, removes accounts cleanly, and sanitizes tampered disk state', () => {
  const tmp = tempFile();
  try {
    let t = 3000;
    let seq = 0;
    const store = createAccountStore({
      file: tmp.file,
      now: () => ++t,
      randomId: () => `acct_${String(++seq).padStart(16, '0')}`,
    });

    store.syncActive({ userId: 'u_0', email: 'u0@example.com', name: 'User 0' });
    for (let i = 1; i < MAX_ACCOUNTS; i++) {
      const added = store.beginAdd();
      assert.equal(added.ok, true);
      store.syncActive({ userId: `u_${i}`, email: `u${i}@example.com`, name: `User ${i}` });
    }
    assert.equal(store.snapshot().canAdd, false);
    assert.deepEqual(store.beginAdd(), { ok: false, reason: 'limit' });

    // Remove active account -> switches to most recently used remaining account
    const activeBefore = store.active();
    const removed = store.remove(activeBefore.id);
    assert.equal(removed.ok, true);
    assert.equal(removed.switched, true);
    assert.deepEqual(removed.removedPartitions, [activeBefore.partition]);
    assert.notEqual(store.active().id, activeBefore.id);

    // Tampered disk file: rejects invalid ids and strips control characters
    writeFileSync(tmp.file, JSON.stringify({
      version: 1,
      activeId: '../evil',
      accounts: [
        { id: '../evil', partition: 'persist:hacked', email: 'evil@example.com', signedIn: true },
        { id: 'default', partition: 'persist:override-ignored', userId: 'u_safe', email: 'safe@example.com', name: 'Safe\u0007\nName', signedIn: true },
      ],
    }));
    const safeStore = createAccountStore({ file: tmp.file, now: () => ++t });
    assert.equal(safeStore.snapshot().accounts.length, 1);
    assert.equal(safeStore.active().id, DEFAULT_ACCOUNT_ID);
    assert.equal(safeStore.active().partition, DEFAULT_PARTITION);
    assert.equal(safeStore.active().name, 'Safe Name');
    assert.equal(isAccountId('../evil'), false);
    assert.throws(() => partitionForAccount('../evil'));
  } finally {
    tmp.cleanup();
  }
});

test('account labels, initials, addAccount sign-in link, and browser bridge resetLease', () => {
  assert.equal(accountLabel({ name: 'Alice Smith', email: 'alice@example.com', signedIn: true }), 'Alice Smith');
  assert.equal(accountLabel({ name: '', email: 'bob@studio.dev', signedIn: true }), 'bob');
  assert.equal(accountLabel({ name: '', email: '', signedIn: false }), 'Add account');
  assert.equal(accountInitials({ name: 'Alice Smith' }), 'AS');
  assert.equal(accountInitials({ email: 'bob@studio.dev' }), 'BO');

  const signIn = startSignIn('https://1904.ai', { addAccount: true });
  const parsed = new URL(signIn.url);
  assert.equal(parsed.pathname, '/desktop/sign-in');
  assert.equal(parsed.searchParams.get('addAccount'), '1');

  const tmp = tempFile();
  try {
    const bridge = createDesktopBrowserBridge({
      file: path.join(tmp.dir, 'browser-settings.json'),
      fetch: async () => new Response('{}'),
      origin: 'https://1904.ai',
      confirm: async () => true,
    });
    assert.equal(typeof bridge.resetLease, 'function');
    assert.doesNotThrow(() => bridge.resetLease());
  } finally {
    tmp.cleanup();
  }
});

test('main.cjs wires multi-account partition isolation, input gates, and resetLease', () => {
  const main = readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /require\('\.\/desktop-accounts\.cjs'\)/);
  assert.match(main, /ipcMain\.handle\('1904:accounts-switch'/);
  assert.match(main, /ipcMain\.handle\('1904:accounts-add'/);
  assert.match(main, /ipcMain\.handle\('1904:accounts-remove'/);
  assert.match(main, /desktopBrowserBridge\?\.resetLease\(\)/);
  assert.match(main, /clearPartitions\(/);
});
