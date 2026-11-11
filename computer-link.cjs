// Use My Computer: this computer's link to 1904.
// When the person connects the computer, 1904 issues a token and a proof key for it once. Both are
// kept only in the app's data folder, encrypted with the operating system's key store (Electron
// safeStorage: the Keychain on macOS, DPAPI on Windows), and only the main process reads them.
// Without that key store the computer is not connected at all: neither is ever written in clear.
// The folder the person chose for each app, and the Pause switch, live beside it. Electron pieces are passed in.

const fs = require('node:fs');
const path = require('node:path');
const { COMPUTER_NAME_MAX, COMPUTER_SHELL_MAX, computerId, label } = require('./computer-policy.cjs');
const { proofKeyBytes } = require('./computer-proof.cjs');

const LINK_FILE = 'computer-link.json';
const FOLDERS_FILE = 'computer-folders.json';
const SETTINGS_FILE = 'computer-settings.json';
/** When this computer last heard from 1904 is written at most this often. */
const SEEN_WRITE_MS = 60 * 60_000;
const PAIR_PATH = '/api/desktop/computer/pair';
const TOKEN = /^[\x21-\x7e]{16,512}$/;
const appKey = key => typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('1904 Desktop could not read', path.basename(file));
    return undefined;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

function removeFile(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/**
 * `safeStorage` is Electron's; tests pass a stand-in with the same methods. `folderProblem(path)`
 * says why a saved folder choice may not be used (policy's folderChoiceProblem); such entries are
 * dropped whenever the choices are read, whoever wrote the file.
 */
function createComputerLink({ dir, safeStorage, now = Date.now, folderProblem = () => undefined }) {
  const linkFile = path.join(dir, LINK_FILE);
  const foldersFile = path.join(dir, FOLDERS_FILE);
  const settingsFile = path.join(dir, SETTINGS_FILE);
  let token;
  let proofKey;
  let seenWritten = 0;

  function stored() {
    const value = readJson(linkFile);
    if (!value || !computerId(value.id) || typeof value.token !== 'string' || !value.token) return undefined;
    return {
      id: value.id, name: label(value.name, COMPUTER_NAME_MAX) || 'This computer', token: value.token,
      proofKey: typeof value.proofKey === 'string' ? value.proofKey : undefined,
      seenAt: Number.isFinite(value.seenAt) ? value.seenAt : undefined,
    };
  }

  /** Decrypts one stored secret; re-encrypts it when the key store asks to. */
  async function secret(field) {
    const value = stored();
    if (!value?.[field]) return undefined;
    try {
      const { value: plain, refresh } = await decrypt(value[field]);
      if (!TOKEN.test(plain)) return undefined;
      if (refresh) writeJson(linkFile, { ...readJson(linkFile), [field]: await encrypt(plain) });
      return plain;
    } catch {
      console.warn('1904 Desktop could not read this computer’s 1904 key.');
      return undefined;
    }
  }

  async function encryptionAvailable() {
    try {
      if (typeof safeStorage?.isAsyncEncryptionAvailable === 'function') return Boolean(await safeStorage.isAsyncEncryptionAvailable());
      return Boolean(safeStorage?.isEncryptionAvailable?.());
    } catch {
      return false;
    }
  }

  async function encrypt(text) {
    const bytes = typeof safeStorage.encryptStringAsync === 'function' ? await safeStorage.encryptStringAsync(text) : safeStorage.encryptString(text);
    return Buffer.from(bytes).toString('base64');
  }

  async function decrypt(text) {
    const bytes = Buffer.from(text, 'base64');
    if (typeof safeStorage.decryptStringAsync === 'function') {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(bytes);
      return { value: result, refresh: Boolean(shouldReEncrypt) };
    }
    return { value: safeStorage.decryptString(bytes), refresh: false };
  }

  const folders = {
    all() {
      const value = readJson(foldersFile) || {};
      return Object.fromEntries(Object.entries(value).filter(([appId, entry]) =>
        appKey(appId) && entry && typeof entry.path === 'string' && path.isAbsolute(entry.path) && !folderProblem(entry.path)));
    },
    get(appId) {
      return appKey(appId) && Object.hasOwn(folders.all(), appId) ? folders.all()[appId].path : undefined;
    },
    set(appId, folder, app = {}) {
      if (!appKey(appId) || typeof folder !== 'string' || !path.isAbsolute(folder) || folderProblem(folder)) return false;
      const value = folders.all();
      value[appId] = { path: folder, name: label(app.name) || '', repo: label(app.repo) || '' };
      writeJson(foldersFile, value);
      return true;
    },
    reset(appId) {
      const value = folders.all();
      if (!appKey(appId) || !Object.hasOwn(value, appId)) return false;
      delete value[appId];
      writeJson(foldersFile, value);
      return true;
    },
  };

  return {
    encryptionAvailable,
    /** The id and name, without touching the key store. Undefined when this computer is not connected. */
    info() {
      const value = stored();
      return value ? { id: value.id, name: value.name } : undefined;
    },
    /** The token, decrypted on first use and then kept in memory. Undefined when there is none or it cannot be read. */
    async token() {
      if (!token) token = await secret('token');
      return token;
    },
    /** `{ computerId, proofKey }` for stamping this computer's own messages; undefined without a proof key. */
    async proof() {
      const value = stored();
      if (!value?.proofKey) return undefined;
      if (!proofKey) proofKey = await secret('proofKey');
      return proofKeyBytes(proofKey) ? { computerId: value.id, proofKey } : undefined;
    },
    async save({ id, name, token: plain, proofKey: key }) {
      if (!(await encryptionAvailable())) throw new Error('Secure storage is not available.');
      writeJson(linkFile, { id, name, token: await encrypt(plain), proofKey: await encrypt(key), seenAt: now() });
      token = plain;
      proofKey = key;
    },
    rename(name) {
      const value = readJson(linkFile);
      const clean = label(name, COMPUTER_NAME_MAX);
      if (!value || !clean || value.name === clean) return;
      writeJson(linkFile, { ...value, name: clean });
    },
    /** 1904 answered a poll. Kept so a later 401 can tell a lapsed pairing from a revoked one. */
    touch() {
      if (now() - seenWritten < SEEN_WRITE_MS) return;
      const value = readJson(linkFile);
      if (!value) return;
      seenWritten = now();
      writeJson(linkFile, { ...value, seenAt: seenWritten });
    },
    /** When this computer last heard from 1904, as far as it recorded. */
    seenAt() {
      return stored()?.seenAt;
    },
    forget() {
      token = undefined;
      proofKey = undefined;
      seenWritten = 0;
      removeFile(linkFile);
    },
    folders,
    /** The Pause switch survives a restart. */
    paused() {
      return readJson(settingsFile)?.paused === true;
    },
    setPaused(paused) {
      writeJson(settingsFile, { ...readJson(settingsFile), paused: paused === true });
    },
  };
}

/** The native prompt before connecting. Cancel is both the default and the Escape answer; Connect is 1. */
function connectPrompt(name) {
  return {
    type: 'question', title: 'Use My Computer',
    message: `Connect this computer to 1904 as ${label(name, COMPUTER_NAME_MAX) || 'My computer'}?`,
    detail: 'When a task’s agent asks to run a command on this computer, 1904 Desktop shows you the command, ' +
      'the folder and the agent’s reason first. Nothing runs unless you approve it here or start away mode, and only for ' +
      'messages you send from 1904 Desktop. Commands run in a sandbox where this computer has one; a command that needs ' +
      'full access runs as you, with your permissions, and always asks you here. You can pause or disconnect this computer ' +
      'from the 1904 menu, or disconnect it in 1904 Settings.',
    buttons: ['Cancel', 'Connect'], defaultId: 0, cancelId: 0, noLink: true,
  };
}

/** What the person is told when connecting does not work. */
const PAIR_NOTICES = {
  unavailable: {
    message: 'Use My Computer isn’t available here',
    detail: '1904 Desktop keeps this computer’s key in your system’s secure storage, and that isn’t available right now. Nothing was connected.',
  },
  signedOut: {
    message: 'Sign in to 1904 first',
    detail: 'Sign in in the 1904 Desktop window, then choose Use My Computer… again.',
  },
  limit: {
    message: 'This computer was not connected',
    detail: 'Your account already has as many computers as it can connect. Disconnect one in 1904 Settings, then try again.',
  },
  failed: {
    message: 'Could not connect this computer',
    detail: 'Check your connection and try again.',
  },
};

/**
 * Connects this computer: asks the person, then asks 1904 for a token with the dashboard's
 * signed-in session. `confirm(name)` resolves true to go ahead; `notice({ message, detail })` tells
 * the person why it did not work. Resolves true when the computer is now connected.
 */
async function pairComputer({ link, fetch, origin, computer, confirm, notice }) {
  if (link.info()) return true;
  if (!(await link.encryptionAvailable())) {
    await notice(PAIR_NOTICES.unavailable);
    return false;
  }
  const name = label(computer.name, COMPUTER_NAME_MAX) || 'My computer';
  if (!(await confirm(name))) return false;
  let response;
  try {
    response = await fetch(origin + PAIR_PATH, {
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-1904-desktop-exchange': '1' },
      body: JSON.stringify({
        name, platform: computer.platform,
        shell: label(computer.shell, COMPUTER_SHELL_MAX) || '', appVersion: String(computer.appVersion || ''),
      }),
    });
  } catch {
    await notice(PAIR_NOTICES.failed);
    return false;
  }
  const body = await response.json().catch(() => undefined);
  if (response.status === 401) {
    await notice(PAIR_NOTICES.signedOut);
    return false;
  }
  if (response.status === 409) {
    const detail = label(body?.error, 300);
    await notice(detail ? { ...PAIR_NOTICES.limit, detail } : PAIR_NOTICES.limit);
    return false;
  }
  if (response.status === 503) {
    const detail = label(body?.error, 300);
    await notice(detail ? { ...PAIR_NOTICES.failed, detail } : PAIR_NOTICES.failed);
    return false;
  }
  const id = computerId(body?.id);
  // Without its proof key (32 bytes, base64url) this computer could not show which messages it sent, so it is not connected.
  if (!response.ok || !id || typeof body.token !== 'string' || !TOKEN.test(body.token) || !proofKeyBytes(body.proofKey)) {
    await notice(PAIR_NOTICES.failed);
    return false;
  }
  try {
    await link.save({ id, name: label(body.name, COMPUTER_NAME_MAX) || name, token: body.token, proofKey: body.proofKey });
  } catch {
    await notice(PAIR_NOTICES.unavailable);
    return false;
  }
  return true;
}

module.exports = { LINK_FILE, FOLDERS_FILE, SETTINGS_FILE, PAIR_PATH, PAIR_NOTICES, connectPrompt, createComputerLink, pairComputer };
