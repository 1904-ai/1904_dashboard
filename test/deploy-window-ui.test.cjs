const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const ROOT = join(__dirname, '..');
const html = readFileSync(join(ROOT, 'deploy.html'), 'utf8');
const preloadSource = readFileSync(join(ROOT, 'deploy-preload.cjs'), 'utf8');
const mainSource = readFileSync(join(ROOT, 'main.cjs'), 'utf8');

// Minimal DOM fixture backed by the real element IDs declared in deploy.html, so deploy-preload.cjs
// runs unchanged without Electron and every interaction updates real element state.
function createElement(tag, id = '') {
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    id,
    className: '',
    value: '',
    checked: false,
    disabled: false,
    hidden: false,
    placeholder: '',
    title: '',
    textContent: '',
    type: '',
    dataset: {},
    children: [],
    focused: false,
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
    setAttribute(name, value) {
      attrs.set(name, String(value));
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

function loadDeployWindow({ state, onInvoke, onSend = () => {} } = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z0-9-]+)\b([^>]*)>/gi)) {
    const [, tag, rawAttrs] = match;
    const idMatch = /\bid="([^"]+)"/.exec(rawAttrs);
    if (!idMatch) continue;
    const el = createElement(tag, idMatch[1]);
    el.hidden = /\bhidden\b/.test(rawAttrs);
    const ariaBusy = /\baria-busy="([^"]+)"/.exec(rawAttrs);
    if (ariaBusy) el.setAttribute('aria-busy', ariaBusy[1]);
    elements.set(el.id, el);
  }
  const radioGroups = new Map();
  for (const match of html.matchAll(/<input\b([^>]*type="radio"[^>]*)>/gi)) {
    const rawAttrs = match[1];
    const name = /\bname="([^"]+)"/.exec(rawAttrs)?.[1];
    const value = /\bvalue="([^"]+)"/.exec(rawAttrs)?.[1];
    if (!name || !value) continue;
    const radio = createElement('input');
    radio.name = name;
    radio.value = value;
    radio.checked = /\bchecked\b/.test(rawAttrs);
    if (!radioGroups.has(name)) radioGroups.set(name, []);
    radioGroups.get(name).push(radio);
  }

  const windowListeners = new Map();
  const ipcListeners = new Map();
  const sent = [];
  const invoked = [];
  let timerSeq = 0;
  const timers = new Map();

  const document = {
    documentElement: { dataset: {} },
    getElementById(id) {
      const el = elements.get(id);
      if (!el) throw new Error(`Missing element #${id} in deploy.html`);
      return el;
    },
    querySelector(selector) {
      const match = /^input\[name="([^"]+)"\]:checked$/.exec(selector);
      if (match) return (radioGroups.get(match[1]) ?? []).find(r => r.checked) ?? null;
      return null;
    },
    querySelectorAll(selector) {
      const match = /^input\[name="([^"]+)"\]$/.exec(selector);
      if (match) return radioGroups.get(match[1]) ?? [];
      return [];
    },
    createElement(tag) {
      return createElement(tag);
    },
  };

  const ipcRenderer = {
    async invoke(channel, ...args) {
      invoked.push({ channel, args });
      if (channel === '1904:deploy-state') return state;
      return onInvoke(channel, ...args);
    },
    send(channel, ...args) {
      sent.push({ channel, args });
      onSend(channel, ...args);
    },
    on(channel, fn) {
      ipcListeners.set(channel, fn);
    },
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
    setTimeout(fn, ms) {
      const id = ++timerSeq;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    console,
    Date,
    Map,
    Set,
    Number,
    String,
    Boolean,
    Array,
    Object,
    Promise,
  };

  vm.runInNewContext(preloadSource, sandbox, { filename: 'deploy-preload.cjs' });
  for (const fn of windowListeners.get('DOMContentLoaded') ?? []) fn();

  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  };

  return {
    $: id => document.getElementById(id),
    sent,
    invoked,
    timers,
    flush,
    emit(channel, ...args) {
      ipcListeners.get(channel)?.({}, ...args);
    },
    runTimers() {
      for (const [id, entry] of [...timers.entries()]) {
        timers.delete(id);
        entry.fn();
      }
    },
  };
}

const KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILIsR/fI27KnIvYXgupxiKT/3X7sFW5PKJLPu59uzWQl 1904-deploy-OpenLS';
const HOST_KEY = 'openls.internal ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ' + 'x'.repeat(42);

function baseState({ trusted = true } = {}) {
  return {
    platform: 'macos',
    connection: { connected: true, text: 'Connected to 1904 as Studio Mac.' },
    apps: [{ id: 'app_openls', name: 'OpenLS' }],
    recipes: trusted ? [{
      appId: 'app_openls',
      appName: 'OpenLS',
      host: { name: 'openls.internal', user: 'deploy', port: 22, auth: 'key', keys: [HOST_KEY] },
      fingerprints: { [HOST_KEY]: 'ED25519 SHA256:Lh5htTA+sIPvycGXk9UZ' },
      connect: '',
      commands: 'git pull',
      log: { mode: 'output', path: '' },
      auto: true,
      noApproval: false,
      position: 10,
      stopOnFailure: false,
    }] : [],
    kept: {
      app_openls: {
        password: false,
        publicKey: KEY,
        installCommand: `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${KEY}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`,
      },
    },
  };
}

test('Deploy From This Computer opens wider and uses a wider content measure', () => {
  const winMatch = /function showDeploys\([^)]*\)[\s\S]*?new BrowserWindow\(\{([\s\S]*?)\}\);/.exec(mainSource);
  assert.ok(winMatch, 'showDeploys BrowserWindow declaration exists');
  const width = Number(/\bwidth:\s*(\d+)/.exec(winMatch[1])?.[1]);
  assert.ok(width >= 1100, `expected wider default deploy window width (>= 1100), got ${width}`);
  const mainMaxWidth = Number(/main\s*\{[^}]*max-width:\s*(\d+)px/.exec(html)?.[1]);
  assert.ok(mainMaxWidth >= 1100, `expected wider deploy main max-width (>= 1100px), got ${mainMaxWidth}`);
  assert.doesNotMatch(preloadSource, /innerHTML/, 'deploy-preload never parses untrusted text as HTML');
});

test('Add key shows immediate in-progress feedback, then clear inline success and Added on host badge', async () => {
  let resolveInstall;
  const ui = loadDeployWindow({
    state: baseState({ trusted: true }),
    onInvoke(channel) {
      if (channel === '1904:deploy-install-key') {
        return new Promise(resolve => { resolveInstall = resolve; });
      }
      return { ok: true };
    },
  });
  await ui.flush();

  assert.equal(ui.$('key-feedback').hidden, true);
  assert.equal(ui.$('key-added-badge').hidden, true);
  assert.equal(ui.$('install-key').disabled, true, 'disabled until a password is typed');

  ui.$('install-password').value = 's3cret';
  ui.$('form').dispatchEvent({ type: 'input' });
  assert.equal(ui.$('install-key').disabled, false);

  ui.$('install-key').click();
  // Synchronous immediate feedback before IPC finishes:
  assert.equal(ui.$('install-password').value, '', 'password cleared immediately');
  assert.equal(ui.$('install-key').getAttribute('aria-busy'), 'true');
  assert.equal(ui.$('install-key-label').textContent, 'Adding key…');
  assert.equal(ui.$('key-feedback').hidden, false);
  assert.equal(ui.$('key-feedback').dataset.kind, 'pending');
  assert.equal(ui.$('key-feedback').getAttribute('role'), 'status');
  assert.match(ui.$('key-feedback-title').textContent, /Connecting to deploy@openls\.internal/);

  resolveInstall({ ok: true });
  await ui.flush();

  assert.equal(ui.$('install-key').getAttribute('aria-busy'), 'false');
  assert.equal(ui.$('install-key-label').textContent, 'Add key');
  assert.equal(ui.$('key-added-badge').hidden, false, 'header badge confirms key added');
  assert.equal(ui.$('key-feedback').hidden, false);
  assert.equal(ui.$('key-feedback').dataset.kind, 'ok');
  assert.equal(ui.$('key-feedback-title').textContent, 'Deploy key added to deploy@openls.internal');
  assert.match(ui.$('key-feedback-detail').textContent, /not kept.*Save below/i);
});

test('Add key failure shows an inline alert right in the Deploy key card and returns focus to password', async () => {
  const ui = loadDeployWindow({
    state: baseState({ trusted: true }),
    async onInvoke(channel) {
      if (channel === '1904:deploy-install-key') {
        return { ok: false, error: 'The host refused that password, or does not accept passwords.' };
      }
      return { ok: true };
    },
  });
  await ui.flush();

  ui.$('install-password').value = 'wrong-pass';
  ui.$('form').dispatchEvent({ type: 'input' });
  ui.$('install-password').dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  await ui.flush();

  assert.equal(ui.$('key-added-badge').hidden, true);
  assert.equal(ui.$('key-feedback').hidden, false);
  assert.equal(ui.$('key-feedback').dataset.kind, 'error');
  assert.equal(ui.$('key-feedback').getAttribute('role'), 'alert');
  assert.equal(ui.$('key-feedback-title').textContent, 'Could not add the deploy key');
  assert.equal(ui.$('key-feedback-detail').textContent, 'The host refused that password, or does not accept passwords.');
  assert.equal(ui.$('install-password').focused, true, 'focus returns to password field for retry');
});

test('Deploy key card explains when Host identity must be trusted first and confirms Copy the command inline', async () => {
  const ui = loadDeployWindow({
    state: baseState({ trusted: false }),
    async onInvoke() { return { ok: true }; },
  });
  await ui.flush();

  assert.equal(ui.$('key-trust-note').hidden, false);
  assert.match(ui.$('key-trust-note').textContent, /Check and trust the host identity above/);
  assert.equal(ui.$('install-password').disabled, true);
  assert.equal(ui.$('install-key').disabled, true);

  ui.$('copy-install').click();
  assert.equal(ui.sent.at(-1).channel, '1904:deploy-copy-install');
  assert.equal(ui.$('copy-install').textContent, 'Copied to clipboard');
  assert.equal(ui.$('copy-install').dataset.copied, 'true');

  ui.runTimers();
  assert.equal(ui.$('copy-install').textContent, 'Copy the command');
  assert.equal(ui.$('copy-install').dataset.copied, undefined);
});

test('Run now and Dry run display captured error messages and stderr inline in the deploy window', async () => {
  const ui = loadDeployWindow({
    state: baseState({ trusted: true }),
    async onInvoke() { return { ok: true }; },
  });
  await ui.flush();

  ui.$('run').click();
  await ui.flush();
  assert.equal(ui.$('run-feedback').hidden, false);
  assert.equal(ui.$('run-feedback').dataset.kind, 'pending');

  ui.emit('1904:deploy-run-result', {
    appId: 'app_openls',
    ok: false,
    status: 'failed',
    exitCode: 128,
    message: 'The commands ended with exit code 128: fatal: not a git repository',
    output: 'Starting deploy\n\n[error output]\nfatal: not a git repository',
  });
  assert.equal(ui.$('run-feedback').dataset.kind, 'error');
  assert.equal(ui.$('run-feedback').getAttribute('role'), 'alert');
  assert.equal(ui.$('run-feedback-title').textContent, 'Deploy failed (exit code 128)');
  assert.match(ui.$('run-feedback-detail').textContent, /fatal: not a git repository/);
  assert.equal(ui.$('dry-output').hidden, false);
  assert.match(ui.$('dry-output').textContent, /\[error output\]\nfatal: not a git repository/);

  ui.$('dry-run').click();
  await ui.flush();
  ui.emit('1904:deploy-dry-run-result', {
    appId: 'app_openls',
    ok: false,
    status: 'failed',
    exitCode: 255,
    message: 'The host refused to sign in. Check the user name and that the key is installed there.',
    output: '[error output]\nPermission denied (publickey).',
  });
  assert.equal(ui.$('run-feedback').dataset.kind, 'error');
  assert.equal(ui.$('run-feedback-title').textContent, 'Dry run failed (exit code 255)');
  assert.match(ui.$('run-feedback-detail').textContent, /host refused to sign in/);
  assert.match(ui.$('dry-output').textContent, /Permission denied \(publickey\)/);
});

test('Deploy window pre-selects a requested app from initial state or 1904:deploy-select', async () => {
  const base = baseState({ trusted: true });
  base.apps.push({ id: 'app_realzy', name: 'Realzy' });
  base.selectedAppId = 'app_realzy';
  const ui = loadDeployWindow({ state: base, async onInvoke() { return { ok: true }; } });
  await ui.flush();
  assert.equal(ui.$('app').value, 'app_realzy');

  ui.emit('1904:deploy-select', 'app_openls');
  assert.equal(ui.$('app').value, 'app_openls');
  assert.equal(ui.$('host-name').value, 'openls.internal');
});
