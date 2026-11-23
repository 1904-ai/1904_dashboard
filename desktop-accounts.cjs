// Multi-account state for 1904 Desktop.
// Each added 1904 account gets its own isolated Electron session partition so cookies,
// localStorage, IndexedDB dashboard caches and Cloudflare clearance never cross between accounts.
// The first slot keeps the historical 'persist:1904-agents' partition so existing installs stay
// signed in without re-authenticating. No Electron imports here: main.cjs passes paths and handles
// session storage cleanup.

const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ACCOUNTS_FILE = 'accounts.json';
const DEFAULT_ACCOUNT_ID = 'default';
const DEFAULT_PARTITION = 'persist:1904-agents';
const MAX_ACCOUNTS = 8;
const ACCOUNT_ID = /^(?:default|acct_[a-f0-9]{16})$/;

function cleanText(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanEmail(value) {
  const text = cleanText(value, 254);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? text : '';
}

function cleanUserId(value) {
  const text = cleanText(value, 128);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(text) ? text : '';
}

function isAccountId(value) {
  return typeof value === 'string' && ACCOUNT_ID.test(value);
}

/** Always derived from the validated account id, never read from untrusted input. */
function partitionForAccount(id) {
  if (!isAccountId(id)) throw new Error('Invalid desktop account id.');
  return id === DEFAULT_ACCOUNT_ID ? DEFAULT_PARTITION : `${DEFAULT_PARTITION}-${id}`;
}

function sanitizeIdentity(input) {
  if (!input || typeof input !== 'object') return {};
  const userId = cleanUserId(input.userId);
  const email = cleanEmail(input.email);
  const name = cleanText(input.name, 120);
  const workspaceName = cleanText(input.workspaceName, 120);
  return {
    ...(userId ? { userId } : {}),
    ...(email ? { email } : {}),
    ...(name ? { name } : {}),
    ...(workspaceName ? { workspaceName } : {}),
  };
}

function accountLabel(account) {
  if (!account || typeof account !== 'object') return '1904 Account';
  if (account.name) return account.name;
  if (account.email) return account.email.split('@')[0] || account.email;
  return account.signedIn === false ? 'Add account' : '1904 Account';
}

function accountInitials(account) {
  const source = cleanText(account?.name || account?.email?.split('@')[0] || '', 120);
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '19';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return ((parts[0][0] || '') + (parts[1][0] || '')).toUpperCase();
}

function isEmptyPending(account) {
  return Boolean(account && !account.signedIn && !account.email && !account.userId);
}

function defaultAccount(now) {
  const at = now();
  return {
    id: DEFAULT_ACCOUNT_ID,
    userId: '',
    email: '',
    name: '',
    workspaceName: '',
    signedIn: false,
    addedAt: at,
    lastUsedAt: at,
  };
}

function readJson(file) {
  if (!file) return undefined;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('1904 Desktop could not read accounts list.');
    return undefined;
  }
}

function writeJson(file, value) {
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  } catch {
    console.warn('1904 Desktop could not save accounts list.');
  }
}

function normalizeStored(raw, now) {
  const at = now();
  const list = Array.isArray(raw?.accounts) ? raw.accounts : [];
  const seen = new Set();
  const accounts = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || !isAccountId(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    const identity = sanitizeIdentity(item);
    accounts.push({
      id: item.id,
      userId: identity.userId || '',
      email: identity.email || '',
      name: identity.name || '',
      workspaceName: identity.workspaceName || '',
      signedIn: item.signedIn === true,
      addedAt: Number.isFinite(item.addedAt) ? item.addedAt : at,
      lastUsedAt: Number.isFinite(item.lastUsedAt) ? item.lastUsedAt : at,
    });
    if (accounts.length >= MAX_ACCOUNTS) break;
  }
  if (accounts.length === 0) accounts.push(defaultAccount(now));
  const activeId = isAccountId(raw?.activeId) && accounts.some(a => a.id === raw.activeId)
    ? raw.activeId
    : accounts[0].id;
  return { activeId, accounts };
}

function toRecord(account) {
  return { ...account, partition: partitionForAccount(account.id) };
}

function toPublic(account, activeId) {
  return {
    id: account.id,
    userId: account.userId,
    email: account.email,
    name: account.name,
    workspaceName: account.workspaceName,
    signedIn: account.signedIn,
    active: account.id === activeId,
  };
}

function createAccountStore({ file, now = Date.now, randomId = () => `acct_${randomBytes(8).toString('hex')}` } = {}) {
  let state = normalizeStored(readJson(file), now);

  function save() {
    writeJson(file, { version: 1, activeId: state.activeId, accounts: state.accounts });
  }

  function findIndex(id) {
    return state.accounts.findIndex(account => account.id === id);
  }

  function activeEntry() {
    const index = findIndex(state.activeId);
    return state.accounts[index >= 0 ? index : 0];
  }

  function pruneEmptyPending(exceptId) {
    const removedPartitions = [];
    if (state.accounts.length <= 1) return removedPartitions;
    state.accounts = state.accounts.filter(account => {
      if (account.id === exceptId || account.id === DEFAULT_ACCOUNT_ID || !isEmptyPending(account)) return true;
      removedPartitions.push(partitionForAccount(account.id));
      return false;
    });
    if (state.accounts.length === 0) {
      state.accounts.push(defaultAccount(now));
    }
    if (!state.accounts.some(account => account.id === state.activeId)) {
      state.activeId = state.accounts[0].id;
    }
    return removedPartitions;
  }

  return {
    active() {
      return toRecord(activeEntry());
    },

    get(id) {
      if (!isAccountId(id)) return undefined;
      const entry = state.accounts.find(account => account.id === id);
      return entry ? toRecord(entry) : undefined;
    },

    /** Public snapshot sent to chrome and the dashboard: never exposes partition names. */
    snapshot() {
      const savedCount = state.accounts.filter(account => !isEmptyPending(account)).length;
      return {
        activeId: state.activeId,
        canAdd: savedCount < MAX_ACCOUNTS && state.accounts.length < MAX_ACCOUNTS,
        maxAccounts: MAX_ACCOUNTS,
        accounts: state.accounts.map(account => toPublic(account, state.activeId)),
      };
    },

    partitionForEmail(email) {
      const target = cleanEmail(email).toLowerCase();
      if (!target) return undefined;
      const match = state.accounts.find(account => account.email.toLowerCase() === target);
      return match ? partitionForAccount(match.id) : undefined;
    },

    /**
     * Records the signed-in identity of the active account. If the user added a new slot and
     * signed into an account that already exists in another slot, deduplicates cleanly.
     */
    syncActive(input) {
      const identity = sanitizeIdentity(input);
      if (!identity.userId && !identity.email) return { active: toRecord(activeEntry()), changed: false, deduplicated: false, removedPartitions: [] };
      const current = activeEntry();
      const duplicate = state.accounts.find(account => {
        if (account.id === current.id) return false;
        if (identity.userId && account.userId && account.userId === identity.userId) return true;
        if (identity.email && account.email && account.email.toLowerCase() === identity.email.toLowerCase()) return true;
        return false;
      });
      const at = now();
      if (duplicate) {
        const removedPartitions = [];
        // Keep the existing slot if it is already signed in (preserving its partition/cache);
        // otherwise keep the newly authenticated slot and drop the stale signed-out duplicate.
        if (duplicate.signedIn) {
          duplicate.userId = identity.userId || duplicate.userId;
          duplicate.email = identity.email || duplicate.email;
          duplicate.name = identity.name || duplicate.name;
          duplicate.workspaceName = identity.workspaceName || duplicate.workspaceName;
          duplicate.lastUsedAt = at;
          if (current.id !== DEFAULT_ACCOUNT_ID) {
            state.accounts = state.accounts.filter(account => account.id !== current.id);
            removedPartitions.push(partitionForAccount(current.id));
          } else {
            current.userId = '';
            current.email = '';
            current.name = '';
            current.workspaceName = '';
            current.signedIn = false;
            removedPartitions.push(partitionForAccount(current.id));
          }
          state.activeId = duplicate.id;
          save();
          return { active: toRecord(duplicate), changed: true, deduplicated: true, removedPartitions };
        }
        // Existing duplicate was signed out: keep the fresh session in `current` and remove the stale slot.
        current.userId = identity.userId || duplicate.userId;
        current.email = identity.email || duplicate.email;
        current.name = identity.name || duplicate.name;
        current.workspaceName = identity.workspaceName || duplicate.workspaceName;
        current.signedIn = true;
        current.lastUsedAt = at;
        state.accounts = state.accounts.filter(account => account.id !== duplicate.id);
        removedPartitions.push(partitionForAccount(duplicate.id));
        save();
        return { active: toRecord(current), changed: true, deduplicated: false, removedPartitions };
      }

      const next = {
        userId: identity.userId || current.userId,
        email: identity.email || current.email,
        name: identity.name || current.name,
        workspaceName: identity.workspaceName || current.workspaceName,
        signedIn: true,
      };
      const changed = next.userId !== current.userId || next.email !== current.email ||
        next.name !== current.name || next.workspaceName !== current.workspaceName || !current.signedIn;
      Object.assign(current, next);
      current.lastUsedAt = at;
      if (changed) save();
      return { active: toRecord(current), changed, deduplicated: false, removedPartitions: [] };
    },

    markSignedOut(id = state.activeId) {
      const index = findIndex(id);
      if (index < 0) return { changed: false };
      const entry = state.accounts[index];
      if (!entry.signedIn) return { changed: false };
      entry.signedIn = false;
      save();
      return { changed: true };
    },

    /** Starts an Add Account flow by creating (or reusing) an empty pending slot. */
    beginAdd() {
      const pending = state.accounts.find(account => isEmptyPending(account));
      if (pending) {
        const changed = state.activeId !== pending.id;
        state.activeId = pending.id;
        pending.lastUsedAt = now();
        save();
        return { ok: true, account: toRecord(pending), changed, reused: true };
      }
      if (state.accounts.length >= MAX_ACCOUNTS) {
        return { ok: false, reason: 'limit' };
      }
      let id = randomId();
      while (!isAccountId(id) || id === DEFAULT_ACCOUNT_ID || findIndex(id) >= 0) {
        id = `acct_${randomBytes(8).toString('hex')}`;
      }
      const at = now();
      const entry = {
        id,
        userId: '',
        email: '',
        name: '',
        workspaceName: '',
        signedIn: false,
        addedAt: at,
        lastUsedAt: at,
      };
      state.accounts.push(entry);
      state.activeId = id;
      save();
      return { ok: true, account: toRecord(entry), changed: true, reused: false };
    },

    /** One-click switch to another saved account. Auto-prunes abandoned empty Add Account slots. */
    switchTo(id) {
      if (!isAccountId(id)) return { ok: false, reason: 'not_found' };
      const target = state.accounts.find(account => account.id === id);
      if (!target) return { ok: false, reason: 'not_found' };
      const changed = state.activeId !== target.id;
      const removedPartitions = pruneEmptyPending(target.id);
      state.activeId = target.id;
      target.lastUsedAt = now();
      if (changed || removedPartitions.length > 0) save();
      return { ok: true, account: toRecord(target), changed, removedPartitions };
    },

    /** Removes an account and returns its partition so the caller can wipe cookies & cache. */
    remove(id) {
      if (!isAccountId(id)) return { ok: false, reason: 'not_found' };
      const index = findIndex(id);
      if (index < 0) return { ok: false, reason: 'not_found' };
      const target = state.accounts[index];
      const partition = partitionForAccount(target.id);
      const wasActive = state.activeId === target.id;

      if (state.accounts.length === 1) {
        // Last account: reset to a clean signed-out default slot and clear its storage.
        state.accounts = [defaultAccount(now)];
        state.activeId = DEFAULT_ACCOUNT_ID;
        save();
        return { ok: true, active: toRecord(state.accounts[0]), switched: true, removedPartitions: [partition] };
      }

      state.accounts.splice(index, 1);
      if (wasActive) {
        const next = [...state.accounts].sort((a, b) => (b.lastUsedAt || 0) - (a.lastUsedAt || 0))[0];
        state.activeId = next.id;
        next.lastUsedAt = now();
      }
      save();
      return { ok: true, active: toRecord(activeEntry()), switched: wasActive, removedPartitions: [partition] };
    },
  };
}

module.exports = {
  ACCOUNTS_FILE,
  DEFAULT_ACCOUNT_ID,
  DEFAULT_PARTITION,
  MAX_ACCOUNTS,
  isAccountId,
  partitionForAccount,
  sanitizeIdentity,
  accountLabel,
  accountInitials,
  isEmptyPending,
  createAccountStore,
};
