const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const {
  TASK_NOTICE_HIDE_MS,
  TASK_NOTICE_HOVER_RESUME_MIN_MS,
  TASK_NOTICE_TIMEOUT_MS,
  createTaskNoticeController,
  normalizeTaskNotice,
  noticeBounds,
} = require('../task-notice.cjs');

const ORIGIN = 'https://1904.ai';
const TASK_A = 'a'.repeat(32);
const TASK_B = 'b'.repeat(32);

function fakeClock(start = 1_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      const target = now + ms;
      while (true) {
        let earliest = null;
        for (const [id, entry] of timers.entries()) {
          if (entry.at <= target && (!earliest || entry.at < earliest.entry.at)) {
            earliest = { id, entry };
          }
        }
        if (!earliest) break;
        timers.delete(earliest.id);
        now = earliest.entry.at;
        earliest.entry.fn();
      }
      now = target;
    },
    pending() {
      return timers.size;
    },
  };
}

test('normalizeTaskNotice validates origin/path/id/kind and sanitizes title and body with safe defaults', () => {
  assert.ok(TASK_NOTICE_TIMEOUT_MS >= 10_000 && TASK_NOTICE_TIMEOUT_MS <= 15_000, 'timebox is 10-15 seconds');

  const needsYou = normalizeTaskNotice({
    id: 'n1',
    kind: 'task_needs_you',
    href: `/agents?app=shop&task=${TASK_A}`,
    title: '  Your agent\u202E has a\nquestion  ',
    body: 'Fix checkout:\tconfirm branch target',
  }, ORIGIN);
  assert.deepEqual(needsYou, {
    id: 'n1',
    kind: 'task_needs_you',
    href: `${ORIGIN}/agents?app=shop&task=${TASK_A}`,
    path: `/agents?app=shop&task=${TASK_A}`,
    badge: 'Needs attention',
    title: 'Your agent has a question',
    body: 'Fix checkout: confirm branch target',
  });

  const readyFallback = normalizeTaskNotice({
    id: 'n2',
    kind: 'task_ready',
    href: `/agents-beta2?task=${TASK_B}`,
  }, ORIGIN);
  assert.deepEqual(readyFallback, {
    id: 'n2',
    kind: 'task_ready',
    href: `${ORIGIN}/agents?task=${TASK_B}`,
    path: `/agents?task=${TASK_B}`,
    badge: 'Task ready',
    title: 'A task is ready for review',
    body: 'Open 1904 Desktop to view the task.',
  });

  for (const bad of [
    null,
    { id: 'n3', kind: 'task_ready', href: 'https://evil.example/agents?task=' + TASK_A },
    { id: 'n4', kind: 'other', href: `/agents?task=${TASK_A}` },
    { id: 'bad id!', kind: 'task_ready', href: `/agents?task=${TASK_A}` },
    { id: 'n5', kind: 'task_ready', href: '/agents?task=not-hex' },
  ]) {
    assert.equal(normalizeTaskNotice(bad, ORIGIN), null);
  }
});

test('noticeBounds anchors the popup to the bottom-right corner of the display workArea', () => {
  const bounds = noticeBounds({ x: 0, y: 0, width: 1920, height: 1040 }, 384, 176, 16);
  assert.deepEqual(bounds, { x: 1520, y: 848, width: 384, height: 176 });

  const secondary = noticeBounds({ x: 1920, y: 40, width: 1440, height: 860 }, 384, 200, 16);
  assert.deepEqual(secondary, { x: 2960, y: 684, width: 384, height: 200 });
});

test('Close button only dismisses the popup and never opens the task or app', () => {
  const clock = fakeClock();
  const shown = [], hidden = [], opened = [];
  let seq = 0;
  const controller = createTaskNoticeController({
    clock,
    createNonce: () => `nonce-${++seq}`,
    onShow: payload => shown.push(payload),
    onHide: payload => hidden.push(payload),
    onOpen: notice => opened.push(notice),
  });

  const notice = normalizeTaskNotice({ id: 'n-close', kind: 'task_needs_you', href: `/agents?task=${TASK_A}` }, ORIGIN);
  assert.equal(controller.enqueue(notice), true);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].nonce, 'nonce-1');

  // Stale or unknown actions are ignored.
  assert.equal(controller.act('wrong-nonce', 'close'), false);
  assert.equal(controller.act('nonce-1', 'unknown'), false);
  assert.equal(opened.length, 0);
  assert.equal(hidden.length, 0);

  // Clicking Close hides the popup and NEVER calls onOpen.
  assert.equal(controller.act('nonce-1', 'close'), true);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].reason, 'close');
  assert.equal(opened.length, 0);
  assert.equal(controller.active(), null);
  assert.equal(clock.pending(), 0);
});

test('Open Task button closes the popup and opens the exact task', () => {
  const clock = fakeClock();
  const shown = [], hidden = [], opened = [];
  let seq = 0;
  const controller = createTaskNoticeController({
    clock,
    createNonce: () => `nonce-${++seq}`,
    onShow: payload => shown.push(payload),
    onHide: payload => hidden.push(payload),
    onOpen: notice => opened.push(notice),
  });

  const notice = normalizeTaskNotice({ id: 'n-open', kind: 'task_ready', href: `/agents?app=web&task=${TASK_A}` }, ORIGIN);
  controller.enqueue(notice);
  assert.equal(controller.act('nonce-1', 'open'), true);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].reason, 'open');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].href, `${ORIGIN}/agents?app=web&task=${TASK_A}`);
  assert.equal(controller.active(), null);
});

test('popup auto-dismisses after its timebox and pauses while hovered', () => {
  const clock = fakeClock();
  const hidden = [], opened = [], timerUpdates = [];
  let seq = 0;
  const controller = createTaskNoticeController({
    clock,
    createNonce: () => `nonce-${++seq}`,
    onHide: payload => hidden.push(payload),
    onOpen: notice => opened.push(notice),
    onTimer: payload => timerUpdates.push(payload),
  });

  const first = normalizeTaskNotice({ id: 'n-time-1', kind: 'task_needs_you', href: `/agents?task=${TASK_A}` }, ORIGIN);
  const second = normalizeTaskNotice({ id: 'n-time-2', kind: 'task_ready', href: `/agents?task=${TASK_B}` }, ORIGIN);
  controller.enqueue(first);
  controller.enqueue(second);

  // Hover near the end of the 12s window: timer pauses instead of disappearing mid-click.
  clock.advance(TASK_NOTICE_TIMEOUT_MS - 500);
  assert.equal(hidden.length, 0);
  assert.equal(controller.setHovered('nonce-1', true), true);
  clock.advance(30_000);
  assert.equal(hidden.length, 0, 'paused while hovered');

  // Leave hover: resumes with at least TASK_NOTICE_HOVER_RESUME_MIN_MS before closing.
  assert.equal(controller.setHovered('nonce-1', false), true);
  assert.equal(timerUpdates.at(-1).paused, false);
  assert.equal(timerUpdates.at(-1).remainingMs, TASK_NOTICE_HOVER_RESUME_MIN_MS);
  clock.advance(TASK_NOTICE_HOVER_RESUME_MIN_MS - 1);
  assert.equal(hidden.length, 0);
  clock.advance(1);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].reason, 'timeout');
  assert.equal(opened.length, 0, 'timeout never opens the task');

  // Queued second notice appears after the hide transition and auto-dismisses too.
  clock.advance(TASK_NOTICE_HIDE_MS);
  assert.equal(controller.active()?.notice.id, 'n-time-2');
  clock.advance(TASK_NOTICE_TIMEOUT_MS);
  assert.equal(hidden.length, 2);
  assert.equal(hidden[1].reason, 'timeout');
  assert.equal(opened.length, 0);
});

test('openTask navigates in-place when the dashboard is already open and ready, without loadURL hard refresh', () => {
  const source = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');
  const sent = [], loaded = [];
  let shownCount = 0;
  let existing = true;
  const frame = { url: `${ORIGIN}/agents` };
  const contents = {
    mainFrame: frame,
    isDestroyed: () => false,
    getURL: () => frame.url,
    send: (...args) => sent.push(args),
  };
  const context = vm.createContext({
    ORIGIN,
    taskUrl: require('../desktop-links.cjs').taskUrl,
    is1904: value => typeof value === 'string' && value.startsWith(ORIGIN + '/'),
    showDashboard: () => { shownCount++; },
    loadPage: (_c, url) => { loaded.push(url); },
    get mainWindow() { return existing ? { isDestroyed: () => false } : undefined; },
    dashboardContents: contents,
    loginReturnTo: '/agents',
    recovery: undefined,
    taskNavigationReady: true,
  });
  const start = source.indexOf('function openTask(');
  const openTaskSrc = source.slice(start, source.indexOf('\nfunction openRepositoryImport(', start));
  vm.runInContext(openTaskSrc, context);

  // Ready dashboard: brings window forward and sends 1904:open-task, ZERO loadURL calls.
  context.openTask(`${ORIGIN}/agents?app=shop&task=${TASK_A}`);
  assert.equal(shownCount, 1);
  assert.deepEqual(sent, [['1904:open-task', `/agents?app=shop&task=${TASK_A}`]]);
  assert.deepEqual(loaded, []);

  // Older dashboard or sign-in page (taskNavigationReady = false): falls back to loadPage.
  context.taskNavigationReady = false;
  context.openTask(`${ORIGIN}/agents?task=${TASK_B}`);
  assert.deepEqual(loaded, [`${ORIGIN}/agents?task=${TASK_B}`]);

  // Recovery mode or newly opened window: falls back to loadPage.
  context.taskNavigationReady = true;
  context.recovery = { kind: 'offline' };
  context.openTask(`${ORIGIN}/agents?task=${TASK_A}`);
  assert.equal(loaded.length, 2);

  context.recovery = undefined;
  existing = false;
  context.openTask(`${ORIGIN}/agents?task=${TASK_B}`);
  assert.equal(loaded.length, 3);
});

test('dashboard-preload exposes onOpenTask, signals readiness, and filters invalid paths', () => {
  const preload = readFileSync(join(__dirname, '..', 'dashboard-preload.cjs'), 'utf8');
  const sent = [];
  const handlers = new Map();
  let exposed;
  vm.runInNewContext(preload, {
    require: name => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (_name, value) => { exposed = value; } },
        ipcRenderer: {
          send: (channel, ...args) => sent.push([channel, ...args]),
          invoke: async () => true,
          on: (channel, handler) => handlers.set(channel, handler),
        },
      };
    },
    process: { isMainFrame: true, platform: 'win32' },
    window: { location: { origin: ORIGIN }, addEventListener: () => {}, dispatchEvent: () => {} },
    console: { error: () => {} },
  });

  const heard = [];
  const stop = exposed.onOpenTask(path => heard.push(path));
  assert.deepEqual(sent, [['1904:task-navigation-ready', true]]);

  handlers.get('1904:open-task')({}, `/agents?app=shop&task=${TASK_A}`);
  handlers.get('1904:open-task')({}, 'https://evil.example/agents?task=' + TASK_A);
  handlers.get('1904:open-task')({}, '/login?next=/agents');
  assert.deepEqual(heard, [`/agents?app=shop&task=${TASK_A}`]);

  stop();
  assert.deepEqual(sent.at(-1), ['1904:task-navigation-ready', false]);
  handlers.get('1904:open-task')({}, `/agents?task=${TASK_B}`);
  assert.equal(heard.length, 1);
});

test('main.cjs packages and guards the Windows notification drawer cleanly', () => {
  const main = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('task-notice.html'), 'task-notice.html is packaged in the release bundle');
  assert.match(main, /process\.platform === 'win32'[\s\S]*ensureTaskNoticeController\(\)\.enqueue\(normalized\)/);
  assert.match(main, /focusable: false/);
  assert.match(main, /win\.showInactive\(\)/);
  assert.match(main, /closeTaskNoticeWindow\(\)/);
  assert.doesNotMatch(main, /timeoutType:\s*item\.kind === 'task_needs_you' \? 'never' : 'default'/);
});
