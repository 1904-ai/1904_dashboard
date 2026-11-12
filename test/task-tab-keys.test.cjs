const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { TASK_TAB_COMMANDS, taskTabCommand } = require('../task-tab-keys.cjs');

const main = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');
const preload = readFileSync(join(__dirname, '..', 'dashboard-preload.cjs'), 'utf8');

function press(key, modifiers = {}, extra = {}) {
  const code = key === 'Tab' ? 'Tab' : /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : '';
  return {
    type: 'keyDown', key, code, isAutoRepeat: false, isComposing: false,
    shift: false, control: false, alt: false, meta: false, ...modifiers, ...extra,
  };
}

test('the four commands are the only ones', () => {
  assert.deepEqual([...TASK_TAB_COMMANDS], ['new', 'close', 'next', 'previous']);
});

test('macOS: Cmd+T, Cmd+W, Ctrl+Tab and Ctrl+Shift+Tab', () => {
  assert.equal(taskTabCommand(press('t', { meta: true }), 'darwin'), 'new');
  assert.equal(taskTabCommand(press('w', { meta: true }), 'darwin'), 'close');
  assert.equal(taskTabCommand(press('Tab', { control: true }), 'darwin'), 'next');
  assert.equal(taskTabCommand(press('Tab', { control: true, shift: true }), 'darwin'), 'previous');
  assert.equal(taskTabCommand(press('t', { control: true }), 'darwin'), undefined, 'Ctrl+T is not Cmd+T on a Mac');
  assert.equal(taskTabCommand(press('w', { control: true }), 'darwin'), undefined, 'Ctrl+W is not Cmd+W on a Mac');
  assert.equal(taskTabCommand(press('Tab', { meta: true }), 'darwin'), undefined, 'Cmd+Tab belongs to macOS');
  assert.equal(taskTabCommand(press('Tab', { meta: true, control: true }), 'darwin'), undefined);
});

test('Windows and Linux: Ctrl+T, Ctrl+W, Ctrl+Tab and Ctrl+Shift+Tab', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(taskTabCommand(press('t', { control: true }), platform), 'new', platform);
    assert.equal(taskTabCommand(press('w', { control: true }), platform), 'close', platform);
    assert.equal(taskTabCommand(press('Tab', { control: true }), platform), 'next', platform);
    assert.equal(taskTabCommand(press('Tab', { control: true, shift: true }), platform), 'previous', platform);
    assert.equal(taskTabCommand(press('t', { meta: true }), platform), undefined, `${platform}: the Windows key is not Ctrl`);
    assert.equal(taskTabCommand(press('w', { meta: true }), platform), undefined, platform);
  }
});

test('modifiers must match exactly', () => {
  for (const platform of ['darwin', 'win32']) {
    const command = platform === 'darwin' ? { meta: true } : { control: true };
    for (const key of ['t', 'w']) {
      assert.equal(taskTabCommand(press(key), platform), undefined, `${platform} ${key} alone`);
      assert.equal(taskTabCommand(press(key, { ...command, shift: true }), platform), undefined, `${platform} ${key} with Shift (reopen tab elsewhere)`);
      assert.equal(taskTabCommand(press(key, { ...command, alt: true }), platform), undefined, `${platform} ${key} with Alt`);
      assert.equal(taskTabCommand(press(key, { meta: true, control: true }), platform), undefined, `${platform} ${key} with Ctrl and Cmd`);
    }
    assert.equal(taskTabCommand(press('Tab'), platform), undefined, `${platform} Tab alone moves focus`);
    assert.equal(taskTabCommand(press('Tab', { shift: true }), platform), undefined, `${platform} Shift+Tab moves focus`);
    assert.equal(taskTabCommand(press('Tab', { control: true, alt: true }), platform), undefined, `${platform} Ctrl+Alt+Tab`);
    assert.equal(taskTabCommand(press('Tab', { control: true, shift: true, alt: true }), platform), undefined);
    assert.equal(taskTabCommand(press('Tab', { alt: true }), platform), undefined, `${platform} Alt+Tab`);
  }
  // AltGr on Windows reports Ctrl and Alt together; it types characters and is never a shortcut.
  assert.equal(taskTabCommand(press('t', { control: true, alt: true }), 'win32'), undefined);
});

test('a letter typed in another case or on a non-Latin layout still counts, a different letter does not', () => {
  assert.equal(taskTabCommand(press('T', { control: true }), 'win32'), 'new', 'Caps Lock');
  assert.equal(taskTabCommand({ ...press('t', { control: true }), key: 'е', code: 'KeyT' }, 'win32'), 'new', 'Russian layout: the T key');
  assert.equal(taskTabCommand({ ...press('w', { meta: true }), key: 'ц', code: 'KeyW' }, 'darwin'), 'close');
  // On another Latin layout the letter typed decides, as it does for menu shortcuts: AZERTY's W sits where QWERTY has Z.
  assert.equal(taskTabCommand({ ...press('w', { control: true }), code: 'KeyZ' }, 'win32'), 'close');
  assert.equal(taskTabCommand({ ...press('z', { control: true }), code: 'KeyW' }, 'win32'), undefined);
});

test('only a key press counts: never a release, and holding T or W does not repeat', () => {
  for (const [platform, mod] of [['darwin', { meta: true }], ['win32', { control: true }]]) {
    for (const key of ['t', 'w']) {
      for (const type of ['keyUp', 'rawKeyDown', 'char', undefined]) {
        assert.equal(taskTabCommand(press(key, mod, { type }), platform), undefined, `${platform} ${key} ${type}`);
      }
      assert.equal(taskTabCommand(press(key, mod, { isAutoRepeat: true }), platform), undefined, `${platform} ${key} held down`);
    }
    assert.equal(taskTabCommand(press('Tab', { control: true }, { type: 'keyUp' }), platform), undefined);
    assert.equal(taskTabCommand(press('Tab', { control: true }, { isAutoRepeat: true }), platform), 'next', 'holding Ctrl+Tab keeps moving');
    assert.equal(taskTabCommand(press('Tab', { control: true, shift: true }, { isAutoRepeat: true }), platform), 'previous');
  }
});

test('other keys and odd input are never a command', () => {
  for (const platform of ['darwin', 'win32']) {
    for (const mod of [{ meta: true }, { control: true }, { control: true, shift: true }]) {
      for (const key of ['n', 'q', 'r', 'a', '1', 'Enter', 'Escape', 'ArrowRight', 'PageDown', 'F4', 'Control', 'Meta', 'Shift', ' ', '']) {
        assert.equal(taskTabCommand(press(key, mod), platform), undefined, `${platform} ${JSON.stringify(mod)} ${key}`);
      }
    }
    for (const bad of [undefined, null, {}, 'keyDown', { type: 'keyDown' }, { type: 'keyDown', key: 't', control: 'yes' }, { type: 'keyDown', key: 'Tab', control: 1 }]) {
      assert.equal(taskTabCommand(bad, platform), undefined, `${platform} ${JSON.stringify(bad)}`);
    }
  }
});

test('main honours the tab-key flag only from the Agents page’s main frame, and resets it with the title bar', () => {
  assert.match(main, /const \{ taskTabCommand \} = require\('\.\/task-tab-keys\.cjs'\);/);
  assert.match(main, /^let taskTabKeys = false;$/m);
  const setters = [...main.matchAll(/taskTabKeys = (?!false;)/g)];
  assert.equal(setters.length, 1, 'set from one place only');
  assert.match(main, /ipcMain\.on\('1904:task-tab-keys', \(event, active\) => \{\n\s+if \(isTaskTitleBarSender\(event\) && typeof active === 'boolean'\) taskTabKeys = active;\n\s+\}\);/,
    'the same sender check as the title bar, booleans only');
  assert.equal([...main.matchAll(/'1904:task-tab-keys'/g)].length, 1, 'no other handler for it');
  // Every place the title bar is taken back, the tab keys go with it.
  assert.match(main, /contents\.on\('did-navigate', \(_event, url, httpResponseCode\) => \{\n\s+setTaskTitleBar\(false\);\n\s+taskTabKeys = false;/);
  assert.match(main, /if \(!isTaskTitleBarPage\(contents\.getURL\(\)\)\) \{\n\s+setTaskTitleBar\(false\);\n\s+taskTabKeys = false;\n\s+\}/);
  assert.match(main, /else if \(isMainFrame\) contents\.send\('1904:task-title-bar-replay'\);/);
  assert.match(main, /if \(!recovery\) \{\n\s+setTaskTitleBar\(false\);\n\s+taskTabKeys = false;/);
  assert.match(main, /\n\s+taskTitleBar = false;\n\s+taskTabKeys = false;\n/, 'and when the window closes');
  assert.equal([...main.matchAll(/setTaskTitleBar\(false\)/g)].length, [...main.matchAll(/(?<!let )taskTabKeys = false;/g)].length - 1,
    'one reset for each title bar reset, plus the window closing');
});

test('main keeps the input proof first and holds back a key only while the flag is on', () => {
  const proof = "contents.on('before-input-event', (_event, input) => computerInput.key(input));";
  assert.ok(main.includes(proof), 'the input proof line is unchanged');
  const tabs = main.indexOf("contents.on('before-input-event', (event, input) => {");
  assert.ok(tabs > main.indexOf(proof), 'the tab keys listen after the input proof, so every key still counts as input');
  const body = main.slice(tabs, main.indexOf('\n  });', tabs));
  assert.match(body, /^\s+if \(!taskTabKeys \|\| !isTaskTitleBarPage\(contents\.getURL\(\)\)\) return;$/m, 'nothing is held back while it is off');
  assert.match(body, /const command = taskTabCommand\(input, process\.platform\);\n\s+if \(!command\) return;/);
  assert.ok(body.indexOf('return;') < body.indexOf('event.preventDefault()'), 'preventDefault only after both checks');
  assert.equal([...body.matchAll(/event\.preventDefault\(\)/g)].length, 1);
  assert.match(body, /contents\.send\('1904:task-tab-command', command\);/);
  assert.equal([...main.matchAll(/'before-input-event'/g)].length, 2, 'no other key hook on the dashboard');
  assert.doesNotMatch(main, /setIgnoreMenuShortcuts/);
  assert.doesNotMatch(main, /accelerator: 'CmdOrCtrl\+(T|W|Tab)'/i, 'no menu items for the tab keys');
});

function loadPreload() {
  const sent = [];
  const handlers = new Map();
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'desktop1904'); exposed = value; } },
    ipcRenderer: {
      send: (channel, ...args) => sent.push([channel, ...args]),
      invoke: async () => undefined,
      on: (channel, handler) => handlers.set(channel, handler),
    },
  };
  const errors = [];
  vm.runInNewContext(preload, {
    require: name => { assert.equal(name, 'electron'); return electron; },
    process: { isMainFrame: true, platform: 'win32' },
    window: { location: { origin: 'https://1904.ai' }, addEventListener: () => {}, dispatchEvent: () => {} },
    console: { error: error => errors.push(error) },
  });
  const fromMain = (channel, ...args) => handlers.get(channel)({ sender: 'ipc event' }, ...args);
  return { api: exposed.taskTabs, sent, fromMain, errors };
}

test('the preload passes on only a boolean, and only the four commands with nothing from Electron', () => {
  const { api, sent, fromMain, errors } = loadPreload();
  assert.deepEqual(Object.keys(api).sort(), ['onCommand', 'setActive']);

  for (const bad of [1, 'true', null, undefined, {}]) api.setActive(bad);
  assert.deepEqual(sent, [], 'anything but a boolean is ignored');
  api.setActive(true);
  assert.deepEqual(sent, [['1904:task-tab-keys', true]]);

  const heard = [];
  const stop = api.onCommand((...args) => heard.push(args));
  api.onCommand(() => { throw new Error('a broken listener'); });
  const alsoHeard = [];
  api.onCommand(command => alsoHeard.push(command));
  for (const command of ['new', 'close', 'next', 'previous']) fromMain('1904:task-tab-command', command);
  for (const bad of ['reload', 'NEW', '', undefined, { command: 'new' }, ['new'], 1]) fromMain('1904:task-tab-command', bad);
  assert.deepEqual(heard, [['new'], ['close'], ['next'], ['previous']], 'one argument, the command, and nothing else');
  assert.deepEqual(alsoHeard, ['new', 'close', 'next', 'previous'], 'a listener that throws does not stop the others');
  assert.equal(errors.length, 4);

  stop();
  fromMain('1904:task-tab-command', 'next');
  assert.equal(heard.length, 4, 'unsubscribed');
  assert.equal(alsoHeard.length, 5);
  assert.equal(typeof api.onCommand('not a function'), 'function');
});

test('back on the Agents page in place, the preload asks again for both the title bar and the tab keys', () => {
  const { api, sent, fromMain } = loadPreload();
  fromMain('1904:task-title-bar-replay');
  assert.deepEqual(sent, [['1904:task-title-bar', false], ['1904:task-tab-keys', false]], 'nothing asked yet: both off');
  sent.length = 0;
  api.setActive(true);
  api.setActive(false);
  api.setActive(true);
  sent.length = 0;
  fromMain('1904:task-title-bar-replay');
  assert.deepEqual(sent, [['1904:task-title-bar', false], ['1904:task-tab-keys', true]], 'the last value the page set');
});
