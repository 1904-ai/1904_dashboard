const assert = require('node:assert/strict');
const { createHash, createHmac } = require('node:crypto');
const { mkdtempSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const {
  COMPUTER_STAMP_INPUT_MS, createInputTracker, createMessageLog, messageInBody, proofHeader, proofInput, stampDecision, stampableRequest,
  uploadBody, withoutProof,
} = require('../computer-proof.cjs');

const ORIGIN = 'https://1904.ai';
const MESSAGE = '0f8e2b1c-3d4e-4f5a-9b6c-7d8e9f0a1b2c';
const TASK = 'a'.repeat(32);
const body = Buffer.from(JSON.stringify({ action: 'conversation', command: 'prompt', id: TASK, requestId: MESSAGE, text: 'run uname on my Mac' }));

function dataFolder(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, '1904-computer-proof-test-'));
  t.after(() => {
    const target = realpathSync(dir);
    assert.equal(dirname(target), parent);
    assert.match(basename(target), /^1904-computer-proof-test-/);
    rmSync(target, { recursive: true });
  });
  return dir;
}

test('the proof signs exactly the text 1904 checks, keyed with the proof key’s 32 raw bytes', () => {
  const ms = 1_700_000_000_123;
  const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1));
  const proofKey = raw.toString('base64url');
  assert.equal(proofKey.length, 43);
  const hash = createHash('sha256').update(body).digest('hex');
  assert.match(hash, /^[a-f0-9]{64}$/, 'lowercase hex');
  assert.equal(proofInput({ computerId: 'cmp_00000001', ms, body }), `1904-computer-proof\nv1\ncmp_00000001\n${ms}\n${hash}`);
  const expected = createHmac('sha256', raw).update(`1904-computer-proof\nv1\ncmp_00000001\n${ms}\n${hash}`, 'utf8').digest('base64url');
  const header = proofHeader({ proofKey, computerId: 'cmp_00000001', ms, body });
  assert.equal(header, `v1.cmp_00000001.${ms}.${expected}`);
  assert.match(header, /^v1\.cmp_00000001\.1700000000123\.[A-Za-z0-9_-]{43}$/, 'base64url without padding: 43 characters');
  assert.notEqual(header.split('.')[3], createHmac('sha256', Buffer.from(proofKey, 'utf8')).update(proofInput({ computerId: 'cmp_00000001', ms, body })).digest('base64url'),
    'the key is the decoded bytes, not the text');
  // Pinned with a fixed key and body, so any change to the format shows up here first.
  assert.equal(proofHeader({ proofKey: Buffer.alloc(32, 0).toString('base64url'), computerId: 'cmp_00000001', ms: 1, body: Buffer.from('{}') }),
    'v1.cmp_00000001.1.' + createHmac('sha256', Buffer.alloc(32, 0))
      .update('1904-computer-proof\nv1\ncmp_00000001\n1\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a').digest('base64url'));
  assert.notEqual(proofHeader({ proofKey, computerId: 'cmp_00000001', ms, body: Buffer.concat([body, Buffer.from(' ')]) }), header, 'one more byte, another proof');
  for (const bad of ['short', 'k'.repeat(43) + '=', Buffer.alloc(31).toString('base64url'), undefined]) {
    assert.throws(() => proofHeader({ proofKey: bad, computerId: 'cmp_00000001', ms, body }), /32 bytes/, String(bad));
  }
});

test('only a POST to 1904’s own agent-workspaces route is ever stamped', () => {
  assert.equal(stampableRequest({ method: 'POST', url: `${ORIGIN}/api/apps/app_123/agent-workspaces`, origin: ORIGIN }), true);
  for (const [method, url] of [
    ['GET', `${ORIGIN}/api/apps/app_123/agent-workspaces`],
    ['PUT', `${ORIGIN}/api/apps/app_123/agent-workspaces`],
    ['POST', `${ORIGIN}/api/apps/app_123/agent-workspaces?x=1`],
    ['POST', `${ORIGIN}/api/apps/app_123/agent-workspaces/extra`],
    ['POST', `${ORIGIN}/api/apps/app_123/agent-workspaces#x`],
    ['POST', `${ORIGIN}/api/apps/../agent-workspaces`],
    ['POST', `${ORIGIN}/api/desktop/computer/result`],
    ['POST', 'https://1904.ai.example.com/api/apps/app_123/agent-workspaces'],
    ['POST', 'http://1904.ai/api/apps/app_123/agent-workspaces'],
    ['POST', 'https://user:pw@1904.ai/api/apps/app_123/agent-workspaces'],
    ['POST', 'not a url'],
  ]) assert.equal(stampableRequest({ method, url, origin: ORIGIN }), false, `${method} ${url}`);
});

test('the body is read as the browser sends it: bytes, blobs, never files', async () => {
  const blobs = { 'blob-1': Buffer.from('"tail"}') };
  assert.deepEqual(await uploadBody([{ bytes: Buffer.from('{"a":') }, { blobUUID: 'blob-1' }], async id => blobs[id]), Buffer.from('{"a":"tail"}'));
  assert.equal(await uploadBody([{ bytes: Buffer.from('{}') }, { file: '/etc/passwd' }], async () => Buffer.alloc(0)), undefined);
  assert.equal(await uploadBody([], async () => Buffer.alloc(0)), undefined);
  assert.equal(await uploadBody(undefined, async () => Buffer.alloc(0)), undefined);
  assert.equal(await uploadBody([{}], async () => Buffer.alloc(0)), undefined);
});

test('only a conversation prompt or answer is a message', () => {
  assert.deepEqual(messageInBody(body), { messageId: MESSAGE, taskId: TASK });
  const as = value => Buffer.from(JSON.stringify(value));
  assert.deepEqual(messageInBody(as({ action: 'conversation', command: 'answer', id: TASK, requestId: MESSAGE })), { messageId: MESSAGE, taskId: TASK });
  for (const value of [
    { action: 'conversation', command: 'stop', id: TASK, requestId: MESSAGE },
    { action: 'conversation', command: 'side-ask', id: TASK, requestId: MESSAGE },
    { action: 'create', command: 'prompt', id: TASK, requestId: MESSAGE },
    { action: 'conversation', command: 'prompt', id: TASK, requestId: 'not-a-uuid' },
    { action: 'conversation', command: 'prompt', id: 'short', requestId: MESSAGE },
    [],
  ]) assert.equal(messageInBody(as(value)), undefined, JSON.stringify(value));
  assert.equal(messageInBody(Buffer.from('not json')), undefined);
  assert.equal(messageInBody(Buffer.alloc(0)), undefined);
});

test('a message is stamped only right after the person typed or clicked in the focused window', () => {
  assert.equal(COMPUTER_STAMP_INPUT_MS, 10_000);
  let now = 50_000;
  const input = createInputTracker({ now: () => now });
  assert.deepEqual(input.decide({ focused: true }), { stamp: false, reason: 'not stamped: no recent input' }, 'nothing typed yet');
  input.key({ type: 'keyDown', key: 'Enter', isAutoRepeat: false });
  now += 9_999;
  assert.deepEqual(input.decide({ focused: true }), { stamp: true }, 'sent within ten seconds');
  assert.equal(input.decide({ focused: false }).reason, 'not stamped: the window was not in front');
  now += 2;
  assert.deepEqual(input.decide({ focused: true }), { stamp: false, reason: 'not stamped: no recent input' }, 'too long ago');

  input.key({ type: 'keyDown', key: 'a', isAutoRepeat: true });
  assert.equal(input.decide({ focused: true }).stamp, false, 'a key held down is not new input');
  input.key({ type: 'keyUp', key: 'a', isAutoRepeat: false });
  assert.equal(input.decide({ focused: true }).stamp, false, 'releasing a key is not');
  for (const type of ['mouseMove', 'mouseUp', 'mouseWheel', 'mouseEnter', 'contextMenu', 'char', undefined]) input.pointer({ type });
  assert.equal(input.decide({ focused: true }).stamp, false, 'moving or scrolling is not');
  input.pointer({ type: 'mouseDown' });
  assert.equal(input.decide({ focused: true }).stamp, true, 'a click is');
  now += 10_001;
  input.pointer({ type: 'touchStart' });
  assert.equal(input.decide({ focused: true }).stamp, true, 'and so is a touch');

  assert.equal(stampDecision({ lastInputAt: 2_000, now: 1_000, focused: true }).stamp, false, 'input from the future after a clock change does not count');
  assert.equal(stampDecision({ lastInputAt: undefined, now: 1_000, focused: true }).stamp, false);
});

test('the main process stamps only for the dashboard’s main frame, never without a frame, and only after real input', () => {
  const main = require('node:fs').readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.match(main, /Boolean\(frame && main && frame\.processId === main\.processId && frame\.routingId === main\.routingId\)/, 'fails closed without a frame');
  assert.doesNotMatch(main, /\(!frame \|\|/, 'no request without a frame passes');
  assert.match(main, /const decision = computerInput\.decide\(\{ focused: /);
  assert.match(main, /if \(!decision\.stamp\) \{\n\s+computerLog\?\.note\(/, 'unstamped, and noted');
  assert.match(main, /contents\.on\('before-input-event', \(_event, input\) => computerInput\.key\(input\)\)/);
  assert.match(main, /contents\.on\('input-event', \(_event, input\) => computerInput\.pointer\(input\)\)/);
  assert.match(main, /if \(!computerInput\.decide\(\{ focused: [^}]+\}\)\.stamp\) return computerState\(\);/, 'away mode from the page needs real input too');
});

test('a proof header a page set itself never leaves', () => {
  assert.deepEqual(withoutProof({ 'Content-Type': 'application/json', 'X-1904-Computer-Proof': 'forged', 'x-1904-computer-proof': 'forged' }),
    { 'Content-Type': 'application/json' });
});

test('sent messages are kept six hours, survive a restart, and can be cleared', t => {
  const dir = dataFolder(t);
  let now = 1_000_000;
  const file = join(dir, 'computer-messages.json');
  const log = createMessageLog({ file, now: () => now });
  const APP = 'app_1';
  assert.equal(log.has(MESSAGE), false);
  assert.equal(log.record(MESSAGE, TASK, APP), true);
  assert.equal(log.record('not-a-message', TASK, APP), false);
  assert.equal(log.has(MESSAGE, TASK, APP), true);
  assert.equal(log.has(MESSAGE, 'b'.repeat(32), APP), false, 'not for another task');
  assert.equal(log.has(MESSAGE, TASK, 'app_2'), false, 'not for another app');
  assert.equal(log.has(MESSAGE, TASK), false, 'never without the app');
  assert.equal(log.has(MESSAGE, 'task_other', APP), false, 'only a valid task id that matches');
  assert.equal(log.has(MESSAGE), false, 'never without a task');
  assert.equal(log.record(MESSAGE, 'not-a-task', APP), false, 'nothing is recorded without its task');
  assert.equal(log.record(MESSAGE, TASK), false, 'nothing is recorded without its app');
  assert.equal(createMessageLog({ file, now: () => now }).has(MESSAGE, TASK, APP), true, 'kept across a restart');
  now += 6 * 60 * 60_000;
  assert.equal(log.has(MESSAGE, TASK, APP), true);
  now += 1;
  assert.equal(log.has(MESSAGE, TASK, APP), false, 'gone after six hours');
  log.record(MESSAGE, TASK, APP);
  log.clear();
  assert.equal(createMessageLog({ file, now: () => now }).has(MESSAGE, TASK, APP), false);
});
