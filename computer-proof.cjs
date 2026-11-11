// Use My Computer, the origin rule: 1904 Desktop answers a request only for a message it sent
// itself (or inside away mode it started). Its main process stamps each message its own dashboard
// window sends with a proof made from a per-computer key the page never sees, and keeps the
// message's id here. 1904 lets a computer be used only for a stamped message; Desktop then checks
// the id against this list, whatever 1904 says.
// No Electron in here: main.cjs passes the request bodies in.

const { createHash, createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { COMPUTER_OWN_MESSAGE_MS, COMPUTER_PROOF_HEADER } = require('./computer-policy.cjs');

const PROOF_CONTEXT = '1904-computer-proof\nv1\n';
const MESSAGE_PATH = /^\/api\/apps\/[A-Za-z0-9_-]{1,128}\/agent-workspaces$/;
const MESSAGE_ID = /^[a-f0-9-]{36}$/;
const TASK_ID = /^[a-f0-9]{32}$/;
/** A message body larger than this is not read, so not stamped. */
const BODY_MAX = 32 * 1024 * 1024;

/** The exact text the proof signs. 1904 rebuilds it from the header and the body it received. */
function proofInput({ computerId, ms, body }) {
  return PROOF_CONTEXT + computerId + '\n' + ms + '\n' + createHash('sha256').update(body).digest('hex');
}

/** The proof key 1904 issues at pairing: base64url of 32 random bytes. */
const PROOF_KEY = /^[A-Za-z0-9_-]{43}$/;
function proofKeyBytes(proofKey) {
  const bytes = typeof proofKey === 'string' && PROOF_KEY.test(proofKey) ? Buffer.from(proofKey, 'base64url') : undefined;
  return bytes?.length === 32 ? bytes : undefined;
}

/**
 * `v1.<computerId>.<ms>.<mac>`: mac is base64url without padding (43 characters) of HMAC-SHA256
 * keyed with the proof key's 32 raw bytes over proofInput, as UTF-8.
 */
function proofHeader({ proofKey, computerId, ms, body }) {
  const key = proofKeyBytes(proofKey);
  if (!key) throw new Error('The proof key is not 32 bytes of base64url.');
  const mac = createHmac('sha256', key).update(proofInput({ computerId, ms, body }), 'utf8').digest('base64url');
  return `v1.${computerId}.${ms}.${mac}`;
}

/** Only POSTs to 1904's own agent-workspaces route are ever stamped: no query, no other path, no other origin. */
function stampableRequest({ method, url, origin }) {
  if (method !== 'POST') return false;
  try {
    const target = new URL(url);
    return target.origin === origin && !target.username && !target.password && !target.search && !target.hash && MESSAGE_PATH.test(target.pathname);
  } catch {
    return false;
  }
}

/**
 * The request body as the browser sends it: byte parts, and blobs read through the session.
 * Undefined for a file upload or anything too large: those are never messages.
 */
async function uploadBody(uploadData, getBlobData) {
  if (!Array.isArray(uploadData) || !uploadData.length) return undefined;
  const parts = [];
  let size = 0;
  for (const part of uploadData) {
    if (part?.file) return undefined;
    let bytes;
    if (part?.blobUUID) bytes = Buffer.from(await getBlobData(part.blobUUID));
    else if (part?.bytes) bytes = Buffer.from(part.bytes);
    else return undefined;
    size += bytes.length;
    if (size > BODY_MAX) return undefined;
    parts.push(bytes);
  }
  return Buffer.concat(parts);
}

/** The person's message in a dashboard body: a conversation prompt or answer. Anything else is not stamped. */
function messageInBody(body) {
  if (!Buffer.isBuffer(body) || !body.length || body.length > BODY_MAX) return undefined;
  let value;
  try { value = JSON.parse(body.toString('utf8')); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (value.action !== 'conversation' || (value.command !== 'prompt' && value.command !== 'answer')) return undefined;
  if (typeof value.requestId !== 'string' || !MESSAGE_ID.test(value.requestId)) return undefined;
  if (typeof value.id !== 'string' || !TASK_ID.test(value.id)) return undefined;
  return { messageId: value.requestId, taskId: value.id };
}

/**
 * The page is served by 1904, so a script on it could send a message nobody typed. A message is
 * stamped only when the person typed or clicked in the dashboard window this recently, and the window
 * has focus. These come from the main process's own input events, which a page cannot fake.
 */
const COMPUTER_STAMP_INPUT_MS = 10_000;

function stampDecision({ lastInputAt, now, focused, windowMs = COMPUTER_STAMP_INPUT_MS }) {
  if (!focused) return { stamp: false, reason: 'not stamped: the window was not in front' };
  if (!Number.isFinite(lastInputAt) || lastInputAt > now || now - lastInputAt > windowMs) return { stamp: false, reason: 'not stamped: no recent input' };
  return { stamp: true };
}

/** The person's last real input in the dashboard window, fed from webContents events in main.cjs. */
function createInputTracker({ now = Date.now, windowMs = COMPUTER_STAMP_INPUT_MS } = {}) {
  let lastInputAt;
  return {
    /** 'before-input-event': a key pressed. Holding a key down (auto-repeat) is not new input. */
    key(input) {
      if (input?.type === 'keyDown' && input.isAutoRepeat !== true) lastInputAt = now();
    },
    /** 'input-event': a click or a touch. Movement, wheel and the rest are not. */
    pointer(event) {
      if (event?.type === 'mouseDown' || event?.type === 'touchStart') lastInputAt = now();
    },
    decide({ focused }) {
      return stampDecision({ lastInputAt, now: now(), focused, windowMs });
    },
  };
}

/** Drops any proof header a page set itself; only the main process adds one. */
function withoutProof(headers) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([name]) => name.toLowerCase() !== COMPUTER_PROOF_HEADER));
}

/** The messages this computer sent, kept COMPUTER_OWN_MESSAGE_MS in memory and in a small file (memory only without one). */
function createMessageLog({ file, now = Date.now, keepMs = COMPUTER_OWN_MESSAGE_MS, max = 5000 } = {}) {
  let entries;
  function load() {
    if (entries) return;
    entries = new Map();
    if (!file) return;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (MESSAGE_ID.test(entry?.id) && Number.isFinite(entry?.at)) entries.set(entry.id, { taskId: TASK_ID.test(entry.taskId) ? entry.taskId : '', at: entry.at });
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('1904 Desktop could not read its list of sent messages.');
    }
  }
  function prune() {
    for (const [id, entry] of entries) if (now() - entry.at > keepMs || entry.at > now() + 60_000) entries.delete(id);
    while (entries.size > max) entries.delete(entries.keys().next().value);
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify([...entries].map(([id, entry]) => ({ id, ...entry }))), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch {
      console.warn('1904 Desktop could not save its list of sent messages.');
    }
  }
  return {
    record(messageId, taskId) {
      if (!MESSAGE_ID.test(messageId) || !TASK_ID.test(taskId ?? '')) return false;
      load();
      entries.delete(messageId);
      entries.set(messageId, { taskId: TASK_ID.test(taskId) ? taskId : '', at: now() });
      prune();
      save();
      return true;
    },
    /** Sent from here within the last six hours, for exactly this task. */
    has(messageId, taskId) {
      load();
      prune();
      const entry = entries.get(messageId);
      return Boolean(entry && TASK_ID.test(taskId ?? '') && entry.taskId === taskId);
    },
    clear() {
      entries = new Map();
      save();
    },
  };
}

module.exports = {
  PROOF_CONTEXT, BODY_MAX, PROOF_KEY, COMPUTER_STAMP_INPUT_MS, proofKeyBytes, proofInput, proofHeader, stampableRequest, uploadBody,
  messageInBody, stampDecision, createInputTracker, withoutProof, createMessageLog,
};
