const assert = require('node:assert/strict');
const { mkdtempSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const { AWAY_PATH, awayBudgetPrompt, awayConfirmPrompt, awayDurationPrompt, createAwayLeases, leaseCovers, readLease } = require('../computer-away.cjs');

function dataFolder(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, '1904-computer-away-test-'));
  t.after(() => {
    const target = realpathSync(dir);
    assert.equal(dirname(target), parent);
    assert.match(basename(target), /^1904-computer-away-test-/);
    rmSync(target, { recursive: true });
  });
  return dir;
}

const lease = { id: 'lease_00000001', taskId: 'a'.repeat(32), appId: 'app_1', taskTitle: 'Fix login', network: false, maxCommands: 3, used: 0 };
const request = (overrides = {}) => ({ task: { id: 'a'.repeat(32) }, app: { id: 'app_1' }, network: false, origin: { kind: 'away', leaseId: 'lease_00000001' }, ...overrides });
const inside = { outside: false };

test('the questions default to Cancel, internet off, and 50 commands', () => {
  assert.equal(AWAY_PATH, '/api/desktop/computer/away');
  const duration = awayDurationPrompt('Fix login');
  assert.deepEqual(duration.buttons, ['Cancel', '30 minutes', '1 hour', '2 hours', '4 hours', '8 hours']);
  assert.deepEqual(duration.minutes, [null, 30, 60, 120, 240, 480]);
  assert.deepEqual([duration.defaultId, duration.cancelId, duration.checkboxChecked], [0, 0, false]);
  assert.match(duration.message, /“Fix login”/);
  assert.match(duration.detail, /sandbox/);
  assert.match(duration.detail, /full access still waits for you/);
  const budget = awayBudgetPrompt();
  assert.equal(budget.buttons[budget.defaultId], '50 commands');
  assert.equal(budget.budgets[budget.defaultId], 50);
  assert.equal(budget.cancelId, 0);
});

test('without Touch ID, the last question restates 1904’s task and the limits, with Cancel as the default', () => {
  const view = awayConfirmPrompt({ taskTitle: 'Fix ‮login', minutes: 120, maxCommands: 25, network: true });
  assert.equal(view.message, 'Start away mode for “Fix <U+202E>login”?');
  assert.match(view.detail, /For 2 hours, up to 25 sandboxed commands .* with internet access/);
  assert.deepEqual([view.buttons, view.defaultId, view.cancelId], [['Cancel', 'Start away mode'], 0, 0]);
  assert.match(awayConfirmPrompt({ taskTitle: 'x', minutes: 30, maxCommands: 50, network: false }).detail, /For 30 minutes, .* without internet access/);
  assert.match(awayConfirmPrompt({ taskTitle: 'x', minutes: 60, maxCommands: 50, network: false }).detail, /For 1 hour,/);
});

test('1904’s answer to a start is checked against what this computer asked for', () => {
  const asked = { taskId: 'a'.repeat(32), appId: 'app_1', taskTitle: 'Fix login', network: false, maxCommands: 50 };
  const lease = readLease({ lease: { id: 'lease_00000001', taskId: asked.taskId, appId: 'app_1', network: true, maxCommands: 500, used: 0 } }, asked);
  assert.deepEqual([lease.id, lease.network, lease.maxCommands, lease.used], ['lease_00000001', false, 50, 0], '1904 can only narrow it');
  assert.equal(readLease({ lease: { id: 'lease_00000001', taskId: asked.taskId, appId: 'app_1', taskTitle: '1904’s title' } }, { ...asked, taskTitle: 'The page’s title' }).taskTitle,
    '1904’s title', '1904’s name for the task, not the page’s');
  assert.equal(readLease({ lease: { id: 'lease_00000001', taskId: 'b'.repeat(32), appId: 'app_1' } }, asked), undefined, 'another task');
  assert.equal(readLease({ lease: { id: 'lease_00000001', taskId: asked.taskId, appId: 'app_2' } }, asked), undefined, 'another app');
  assert.equal(readLease({ lease: { id: 'bad', taskId: asked.taskId, appId: 'app_1' } }, asked), undefined);
  assert.equal(readLease({}, asked), undefined);
});

test('a lease covers its own task’s sandboxed commands inside the folder, within its budget and network', () => {
  assert.deepEqual(leaseCovers(lease, request(), { full: false, place: inside }), { ok: true });
  assert.match(leaseCovers(undefined, request(), { full: false, place: inside }).message, /not on for this task/);
  assert.equal(leaseCovers(lease, request({ origin: { kind: 'desktop' } }), { full: false, place: inside }).ok, false, 'a message from this window always asks');
  assert.equal(leaseCovers(lease, request({ origin: { kind: 'away', leaseId: 'lease_other001' } }), { full: false, place: inside }).ok, false, 'only under this lease');
  assert.match(leaseCovers(lease, request({ task: { id: 'b'.repeat(32) } }), { full: false, place: inside }).message, /not on for this task/);
  assert.match(leaseCovers(lease, request(), { full: true, place: inside }).message, /sandboxed commands only/);
  assert.match(leaseCovers(lease, request({ network: true }), { full: false, place: inside }).message, /no internet access/);
  assert.equal(leaseCovers({ ...lease, network: true }, request({ network: true }), { full: false, place: inside }).ok, true);
  assert.match(leaseCovers(lease, request(), { full: false, place: { outside: true } }).message, /app’s folder only/);
  assert.match(leaseCovers({ ...lease, used: 3 }, request(), { full: false, place: inside }).message, /budget/);
});

test('leases end on time and on budget, one per task, and survive a restart', t => {
  const dir = dataFolder(t);
  let now = 1_000;
  const file = join(dir, 'computer-away.json');
  const leases = createAwayLeases({ file, now: () => now });
  const started = leases.start(lease, 30);
  assert.deepEqual([started.startedAt, started.endsAt], [1_000, 1_000 + 30 * 60_000]);
  assert.equal(leases.forTask(lease.taskId).id, lease.id);
  assert.equal(createAwayLeases({ file, now: () => now }).get(lease.id).id, lease.id, 'kept across a restart');
  assert.deepEqual([leases.use(lease.id).used, leases.use(lease.id).ended], [1, false]);
  const last = leases.use(lease.id);
  assert.deepEqual([last.used, last.ended], [3, true], 'the budget ends it');
  assert.equal(leases.get(lease.id), undefined);
  assert.equal(leases.use(lease.id), undefined);

  leases.start(lease, 30);
  leases.start({ ...lease, id: 'lease_00000002' }, 60);
  assert.deepEqual(leases.list().map(entry => entry.id), ['lease_00000002'], 'a new lease for the task replaces the old');
  assert.equal(leases.nextEnd(), now + 60 * 60_000);
  now += 60 * 60_000;
  assert.deepEqual(leases.expire().map(entry => entry.id), ['lease_00000002'], 'time ends it');
  assert.deepEqual(leases.list(), []);
  leases.start(lease, 30);
  assert.equal(leases.end(lease.id).id, lease.id);
  assert.equal(leases.end(lease.id), undefined);
  leases.start(lease, 30);
  assert.equal(leases.endAll().length, 1);
  assert.deepEqual(createAwayLeases({ file, now: () => now }).list(), []);
});
