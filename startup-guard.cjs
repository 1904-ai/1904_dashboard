// Startup checks for a packaged 1904 Desktop.
//
// Release builds switch off ELECTRON_RUN_AS_NODE, NODE_OPTIONS and Node's --inspect flags with Electron
// fuses, but Chromium's own switches have no fuse. Started with --remote-debugging-port, for example, the
// signed app would let any program on this computer drive the dashboard as that app and read its session.
// So a packaged build refuses to start with any switch below. `npm start` runs it unpackaged, which allows
// them for development.

const { writeFileSync, writeSync } = require('node:fs');

// Exit status of a refused start. scripts/smoke-release.cjs expects it.
const REFUSED_EXIT_CODE = 78;

const REFUSED = new Set([
  // Debuggers and the DevTools protocol
  'remote-debugging-port', 'remote-debugging-pipe', 'remote-debugging-address', 'remote-debugging-io-pipes',
  'remote-allow-origins', 'inspect', 'inspect-brk', 'inspect-brk-node', 'inspect-port', 'inspect-publish-uid',
  'inspect-wait', 'debug', 'debug-brk', 'debug-port', 'js-flags', 'auto-open-devtools-for-tabs',
  'wait-for-debugger', 'wait-for-debugger-children',
  // Starting the app's own processes through another program
  'renderer-cmd-prefix', 'gpu-launcher', 'utility-cmd-prefix', 'browser-subprocess-path',
  // Recording or intercepting its traffic, or keeping its secrets under a key that is not this computer's
  'log-net-log', 'net-log-capture-mode', 'ssl-key-log-file', 'ignore-certificate-errors',
  'ignore-certificate-errors-spki-list', 'use-mock-keychain',
]);
// Whole families, so a variant such as --inspect-anything is refused too.
const REFUSED_PREFIXES = ['inspect', 'remote-debugging', 'wait-for-debugger'];

// The switch name in one command-line argument, the way Chromium and Node.js read it: `-` or `--`
// (and `/` on Windows) before it, any case on Windows, `_` the same as `-` for Node.js.
function switchName(arg, platform) {
  if (typeof arg !== 'string') return null;
  const lead = (platform === 'win32' ? /^(?:--?|\/)/ : /^--?/).exec(arg);
  if (!lead) return null;
  return arg.slice(lead[0].length).split('=')[0].trim().toLowerCase().replaceAll('_', '-') || null;
}

const refused = name => REFUSED.has(name) || REFUSED_PREFIXES.some(prefix => name.startsWith(prefix));

// The refused switch this start was given, or null. Every argument counts, even after `--`.
function refusedSwitch({ argv = [], commandLine, platform = process.platform }) {
  for (const arg of argv.slice(1)) {
    const name = switchName(arg, platform);
    if (name && refused(name)) return name;
  }
  // Chromium's own reading of the command line, in case it differs from process.argv.
  for (const name of REFUSED) {
    if (commandLine?.hasSwitch(name)) return name;
  }
  return null;
}

// Why this start must be refused, or null. Names the switch, never its value.
function startupRefusal({ argv, commandLine, packaged, platform = process.platform }) {
  if (!packaged) return null;
  const name = refusedSwitch({ argv, commandLine, platform });
  return name && `1904 Desktop does not start with --${name}. Release builds refuse debugging and traffic-capture switches; run it from source with npm start to debug it.`;
}

// Call first thing in main.cjs, before Chromium or Node.js can act on a switch. Exits a refused start.
function guardStartup(app, { argv = process.argv, platform = process.platform, write = text => writeSync(2, text) } = {}) {
  const reason = startupRefusal({ argv, commandLine: app.commandLine, packaged: app.isPackaged, platform });
  if (!reason) return false;
  // Before the app is ready, app.exit ends the process at once. Removing the switches as well means
  // Chromium never opens a debugging port even if it did not.
  for (const name of REFUSED) {
    if (app.commandLine.hasSwitch(name)) app.commandLine.removeSwitch(name);
  }
  try { write(`${reason}\n`); } catch { /* no console */ }
  app.exit(REFUSED_EXIT_CODE);
  return true;
}

// The release check (scripts/smoke-release.cjs) cannot attach a debugger to a build that refuses one.
// Instead it starts the app with DESKTOP_SMOKE_REPORT naming a new file, and the app writes there what it
// shows: whether the title bar's menu button is on screen, which dashboard page is open, whether its
// sign-in form shows, and what `typeof require` is on that page. Nothing else is read, and an existing
// file is never replaced. Writes once everything is in place, or what it saw after `timeout` ms.
const MENU_BUTTON = `(() => {
  const button = document.querySelector('button[aria-label="Application menu"]');
  return !!button && button.getClientRects().length > 0;
})()`;
const EMAIL_INPUT = `(() => {
  const input = document.querySelector('input[type=email]');
  return !!input && input.getClientRects().length > 0;
})()`;

function writeReport(file, report) {
  writeFileSync(file, `${JSON.stringify(report)}\n`, { flag: 'wx' });
}

async function smokeState({ origin, chrome, dashboard }) {
  const live = contents => contents && !contents.isDestroyed();
  const run = async (contents, code) => {
    try { return await contents.executeJavaScript(code); } catch { return null; }
  };
  const state = { ok: false, titleBar: false, dashboard: null, returnTo: null, signIn: false, pageRequire: null };
  if (live(chrome) && /\/chrome\.html$/.test(chrome.getURL())) state.titleBar = await run(chrome, MENU_BUTTON) === true;
  if (live(dashboard)) {
    let url;
    try { url = new URL(dashboard.getURL()); } catch { url = null; }
    if (url?.origin === origin) {
      state.dashboard = url.origin + url.pathname;
      state.returnTo = url.searchParams.get('returnTo');
      if (url.pathname === '/login') {
        state.signIn = await run(dashboard, EMAIL_INPUT) === true;
        state.pageRequire = await run(dashboard, 'typeof globalThis.require');
      }
    } else if (url) {
      state.dashboard = url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : url.protocol;
    }
  }
  state.ok = state.titleBar && state.signIn && state.pageRequire === 'undefined' && state.returnTo === '/agents';
  return state;
}

function startSmokeReport({ file, origin, chrome, dashboard, timeout = 60000, interval = 500, write = writeReport }) {
  if (!file) return null;
  const deadline = Date.now() + timeout;
  let timer;
  let stopped = false;
  const tick = async () => {
    const state = await smokeState({ origin, chrome: chrome(), dashboard: dashboard() });
    if (stopped) return;
    if (state.ok || Date.now() >= deadline) {
      try { write(file, state); } catch (error) { console.warn(`1904 Desktop could not write the smoke report: ${error.message}`); }
      return;
    }
    timer = setTimeout(tick, interval);
  };
  timer = setTimeout(tick, 0);
  return { stop: () => { stopped = true; clearTimeout(timer); } };
}

module.exports = { REFUSED_EXIT_CODE, guardStartup, refusedSwitch, startupRefusal, startSmokeReport, switchName };
