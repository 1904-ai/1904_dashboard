const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const { LOG_MAX, LOG_OUTPUT_MAX, createActivityLog, logRecord } = require('../computer-log.cjs');

function dataFolder(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, '1904-computer-log-test-'));
  t.after(() => {
    const target = realpathSync(dir);
    assert.equal(dirname(target), parent);
    assert.match(basename(target), /^1904-computer-log-test-/);
    rmSync(target, { recursive: true });
  });
  return dir;
}

const entry = (n, overrides = {}) => ({
  id: `req_${String(n).padStart(9, '0')}`, messageId: 'msg_000000001', createdAt: n, endedAt: n + 5,
  task: { id: 'task_1', title: 'Fix login' }, sender: { id: 'user_1', name: 'Dana' }, app: { id: 'app_1', name: 'Shop' },
  command: 'npm test', reason: 'Run the tests.', folder: '/Users/dana/1904/shop', cwd: '/Users/dana/1904/shop', outside: false,
  access: 'sandbox', network: false, origin: 'desktop', approval: 'once', status: 'done', exitCode: 0, durationMs: 5,
  output: [{ stream: 'stdout', text: 'ok\n' }, { stream: 'stderr', text: 'warn\n' }],
  ...overrides,
});

test('each command is one line with its decision and the end of its output', t => {
  const dir = dataFolder(t);
  const file = join(dir, 'computer-activity.jsonl');
  const log = createActivityLog({ file });
  log.append(entry(1));
  log.append(entry(2, { status: 'declined', approval: undefined, exitCode: null, output: [] }));
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  const [newest, oldest] = log.list();
  assert.deepEqual([newest.id, newest.status, oldest.id, oldest.stdout, oldest.stderr], ['req_000000002', 'declined', 'req_000000001', 'ok\n', 'warn\n']);
  assert.equal(oldest.command, 'npm test');
  assert.equal(oldest.access, 'sandbox');
  assert.equal(oldest.origin, 'desktop');
  assert.equal(LOG_OUTPUT_MAX, 4096);
  const long = logRecord(entry(3, { output: [{ stream: 'stdout', text: 'x'.repeat(10_000) + 'END' }] }));
  assert.equal(long.stdout.length, LOG_OUTPUT_MAX);
  assert.ok(long.stdout.endsWith('END'), 'the end of the output is what is kept');
});

test('a message that left without its stamp is noted', t => {
  const dir = dataFolder(t);
  const log = createActivityLog({ file: join(dir, 'computer-activity.jsonl') });
  log.append(entry(1));
  log.note({ text: 'not stamped: no recent input', messageId: '0f8e2b1c-3d4e-4f5a-9b6c-7d8e9f0a1b2c', taskId: 'a'.repeat(32) });
  const [note, run] = log.list();
  assert.deepEqual([note.kind, note.note, note.messageId], ['note', 'not stamped: no recent input', '0f8e2b1c-3d4e-4f5a-9b6c-7d8e9f0a1b2c']);
  assert.ok(Number.isFinite(note.at));
  assert.equal(run.id, 'req_000000001');
});

test('only the newest 1,000 are kept', t => {
  assert.equal(LOG_MAX, 1000);
  const dir = dataFolder(t);
  const file = join(dir, 'computer-activity.jsonl');
  const log = createActivityLog({ file, max: 10 });
  for (let n = 1; n <= 12; n++) log.append(entry(n));
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 12, 'rewritten now and then, not on every line');
  assert.equal(log.list().length, 10, 'but only the newest are listed');
  log.append(entry(13));
  assert.deepEqual(log.list().map(record => record.at), [13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 10);
  assert.equal(createActivityLog({ file, max: 10 }).list(2).length, 2);
});
