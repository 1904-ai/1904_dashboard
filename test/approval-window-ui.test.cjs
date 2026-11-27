const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { approvalView } = require('../computer-approval.cjs');
const { validateRequest } = require('../computer-policy.cjs');

const ROOT = join(__dirname, '..');
const html = readFileSync(join(ROOT, 'approval.html'), 'utf8');
const preloadSource = readFileSync(join(ROOT, 'approval-preload.cjs'), 'utf8');
const mainSource = readFileSync(join(ROOT, 'main.cjs'), 'utf8');

function createElement(tag, id = '') {
  const listeners = new Map();
  const attrs = new Map();
  const styleProps = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    id,
    className: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    title: '',
    textContent: '',
    type: '',
    src: '',
    scrollTop: 0,
    scrollHeight: 100,
    clientHeight: 100,
    offsetHeight: 50,
    dataset: {},
    children: [],
    focused: false,
    scrolledIntoView: false,
    style: {
      setProperty(name, value) { styleProps.set(name, String(value)); },
      getPropertyValue(name) { return styleProps.get(name) ?? ''; },
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
    click() {
      el.dispatchEvent({ type: 'click', preventDefault() {} });
    },
    focus() {
      el.focused = true;
    },
    scrollIntoView() {
      el.scrolledIntoView = true;
    },
    setAttribute(name, value) {
      attrs.set(name, String(value));
    },
    removeAttribute(name) {
      attrs.delete(name);
    },
    getAttribute(name) {
      return attrs.get(name) ?? null;
    },
    replaceChildren(...nodes) {
      el.children = nodes;
    },
    append(...nodes) {
      el.children.push(...nodes);
    },
  };
  return el;
}

function loadApprovalWindow({ initialNow = 10_000, focused = true } = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z0-9-]+)\b([^>]*)>/gi)) {
    const [, tag, rawAttrs] = match;
    const idMatch = /\bid="([^"]+)"/.exec(rawAttrs);
    if (!idMatch) continue;
    const el = createElement(tag, idMatch[1]);
    el.hidden = /\bhidden\b/.test(rawAttrs);
    el.disabled = /\bdisabled\b/.test(rawAttrs);
    elements.set(el.id, el);
  }

  const mainEl = createElement('main');
  mainEl.scrollHeight = 620;
  const barEl = createElement('div');
  barEl.offsetHeight = 40;
  const footerEl = createElement('footer');
  footerEl.offsetHeight = 60;

  let now = initialNow;
  let isFocused = focused;
  const windowListeners = new Map();
  const documentListeners = new Map();
  const ipcListeners = new Map();
  const sent = [];
  let timerSeq = 0;
  const timers = new Map();

  function findRadioChecked(root, name) {
    for (const child of root.children) {
      if (child.tagName === 'INPUT' && child.name === name && child.checked) return child;
      const nested = findRadioChecked(child, name);
      if (nested) return nested;
    }
    return null;
  }

  function findByIdInTree(root, id) {
    for (const child of root.children) {
      if (child.id === id) return child;
      const nested = findByIdInTree(child, id);
      if (nested) return nested;
    }
    return null;
  }

  const document = {
    title: '',
    documentElement: { dataset: {} },
    hasFocus: () => isFocused,
    addEventListener(type, fn) {
      if (!documentListeners.has(type)) documentListeners.set(type, []);
      documentListeners.get(type).push(fn);
    },
    getElementById(id) {
      const el = elements.get(id) ?? findByIdInTree(elements.get('scopes'), id);
      if (!el && id !== 'minutes') throw new Error(`Missing element #${id} in approval.html`);
      return el ?? null;
    },
    querySelector(selector) {
      if (selector === 'main') return mainEl;
      if (selector === '.bar') return barEl;
      if (selector === 'footer') return footerEl;
      const match = /^input\[name="([^"]+)"\]:checked$/.exec(selector);
      if (match) return findRadioChecked(elements.get('scopes'), match[1]);
      return null;
    },
    createElement(tag) {
      return createElement(tag);
    },
  };

  const ipcRenderer = {
    send(channel, ...args) {
      sent.push({ channel, args });
    },
    on(channel, fn) {
      ipcListeners.set(channel, fn);
    },
  };

  const DateProxy = class extends Date {
    static now() { return now; }
  };

  const sandbox = {
    document,
    window: {
      addEventListener(type, fn) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(fn);
      },
    },
    require(name) {
      if (name === 'electron') return { ipcRenderer };
      throw new Error(`Unexpected require(${name})`);
    },
    requestAnimationFrame(fn) {
      fn();
    },
    setTimeout(fn, ms) {
      const id = ++timerSeq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    console,
    Date: DateProxy,
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
  };

  vm.runInNewContext(preloadSource, sandbox, { filename: 'approval-preload.cjs' });
  for (const fn of windowListeners.get('DOMContentLoaded') ?? []) fn();

  return {
    $: id => document.getElementById(id),
    sent,
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...timers.entries()]) {
        timers.delete(id);
        entry.fn();
      }
    },
    show(payload) {
      ipcListeners.get('1904:approval-show')?.({}, payload);
    },
    focus() {
      isFocused = true;
      for (const fn of windowListeners.get('focus') ?? []) fn();
    },
  };
}

function sampleView(overrides = {}) {
  const req = validateRequest({
    id: 'req_000000001', kind: 'run', messageId: 'msg_000000001',
    command: overrides.command ?? Array.from({ length: 20 }, (_, i) => `Write-Output "line ${i + 1}"`).join('\n'),
    timeoutSeconds: 30,
    reason: 'Inspect your existing deploy config on Workstation-26.',
    access: overrides.access ?? 'full',
    network: overrides.network ?? false,
    origin: { kind: 'desktop' },
    app: { id: 'app_1', name: '1904', repo: '1904' },
    task: { id: 'task_1', title: 'Task Analysis Request' },
    sender: { id: 'user_1', name: 'Local Admin' },
    createdAt: 1_000, expiresAt: 601_000,
  }).request;
  return approvalView({
    request: req,
    computerName: 'Workstation-26',
    place: { root: 'C:\\Users\\ayoun\\1904', chosen: false, path: 'C:\\Users\\ayoun\\1904', outside: false },
    full: overrides.full ?? true,
    platform: overrides.platform ?? 'windows',
    away: overrides.away ?? false,
  });
}

test('Use My Computer approval window opens wider and keeps strict text-only rendering', () => {
  const winMatch = /function approvalWindowNow\(\)[\s\S]*?new BrowserWindow\(\{([\s\S]*?)\}\);/.exec(mainSource);
  assert.ok(winMatch, 'approvalWindowNow BrowserWindow declaration exists');
  const width = Number(/\bwidth:\s*(\d+)/.exec(winMatch[1])?.[1]);
  const minWidth = Number(/\bminWidth:\s*(\d+)/.exec(winMatch[1])?.[1]);
  assert.ok(width >= 700, `expected wider approval window width (>= 700), got ${width}`);
  assert.ok(minWidth >= 500, `expected wider approval minWidth (>= 500), got ${minWidth}`);
  assert.doesNotMatch(preloadSource, /innerHTML/, 'approval-preload never parses untrusted text as HTML');
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"/);
});

test('long commands clearly indicate scroll-to-review before unlocking Run and update smoothly on scroll', () => {
  const ui = loadApprovalWindow();
  const cmd = ui.$('command');
  // Simulate an overflowing 20-line command (224px viewport over 500px content).
  cmd.clientHeight = 224;
  cmd.scrollHeight = 500;
  cmd.scrollTop = 0;

  ui.show({ nonce: 'n1', view: sampleView(), theme: 'dark', platform: 'windows' });

  // Even after ARM_MS has elapsed, Run stays locked with clear cues in header, command bar, and footer.
  ui.advance(1000);
  assert.equal(ui.$('run').disabled, true, 'Run stays disabled until full command is viewed');
  assert.equal(ui.$('command-box').dataset.review, 'pending');
  assert.equal(ui.$('review-pill').dataset.state, 'pending');
  assert.equal(ui.$('review-pill-text').textContent, 'Scroll to review · 20 lines');
  assert.equal(ui.$('scroll-hint').hidden, false);
  assert.equal(ui.$('scroll-hint-text').textContent, 'Scroll to the end of the command to enable Run with full access');
  assert.equal(ui.$('scroll-progress').textContent, '45% viewed');
  assert.equal(ui.$('run-gate').hidden, false, 'footer gate badge explains why Run is locked');
  assert.equal(ui.$('run').getAttribute('aria-describedby'), 'run-gate');
  assert.equal(ui.$('decline').focused, true, 'Decline still receives initial focus');

  // Clicking the footer gate focuses the command box without skipping the scroll requirement.
  ui.$('run-gate').click();
  assert.equal(cmd.focused, true);
  assert.equal(ui.$('command-box').scrolledIntoView, true);
  assert.equal(ui.$('run').disabled, true, 'clicking the gate never bypasses viewing the whole command');

  // Partial scroll updates progress percentage but never claims 100% or unlocks Run.
  cmd.scrollTop = 180;
  cmd.dispatchEvent({ type: 'scroll' });
  assert.equal(ui.$('scroll-progress').textContent, '81% viewed');
  assert.equal(ui.$('run').disabled, true);
  assert.equal(ui.$('command-box').dataset.review, 'pending');

  // Scrolling to the end unlocks Run and transitions cues to the reviewed state without hiding the bar.
  cmd.scrollTop = 276;
  cmd.dispatchEvent({ type: 'scroll' });
  assert.equal(ui.$('command-box').dataset.review, 'done');
  assert.equal(ui.$('review-pill').dataset.state, 'done');
  assert.equal(ui.$('review-pill-text').textContent, 'All 20 lines viewed');
  assert.equal(ui.$('scroll-hint').hidden, false, 'review bar stays visible to avoid a layout jump');
  assert.equal(ui.$('scroll-hint-text').textContent, 'Whole command viewed');
  assert.equal(ui.$('scroll-progress').textContent, '100%');
  assert.equal(ui.$('run-gate').hidden, true);
  assert.equal(ui.$('run').getAttribute('aria-describedby'), null);
  assert.equal(ui.$('run').disabled, false);

  ui.$('run').click();
  const answer = ui.sent.find(entry => entry.channel === '1904:approval-answer');
  assert.equal(answer?.args[0]?.action, 'run');
  assert.equal(answer?.args[0]?.nonce, 'n1');
});

test('short commands that fit completely omit the scroll gate and unlock after ARM_MS', () => {
  const ui = loadApprovalWindow();
  const cmd = ui.$('command');
  cmd.clientHeight = 120;
  cmd.scrollHeight = 40;
  cmd.scrollTop = 0;

  ui.show({
    nonce: 'n2',
    view: sampleView({ command: 'uname -a', access: 'sandbox', full: false, platform: 'macos', away: true }),
    theme: 'light',
    platform: 'macos',
  });

  assert.equal(cmd.dataset.multiline, 'false', 'single-line commands omit line numbers');
  assert.equal(ui.$('command-box').dataset.review, 'fit');
  assert.equal(ui.$('review-pill').dataset.state, 'fit');
  assert.equal(ui.$('review-pill-text').textContent, '1 line');
  assert.equal(ui.$('scroll-hint').hidden, true, 'no scroll banner when whole command already fits');
  assert.equal(ui.$('run-gate').hidden, true, 'no scroll lock badge when whole command already fits');
  assert.equal(ui.$('run').disabled, true, 'still waits for ARM_MS focus delay');
  assert.equal(ui.$('away').disabled, true, 'away button also waits for ARM_MS');

  ui.advance(1000);
  assert.equal(ui.$('run').disabled, false);
  assert.equal(ui.$('away').disabled, false);
});
