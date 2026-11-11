const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { contextMenuItems, installContextMenu } = require('../context-menu.cjs');

const allEdits = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true, canEditRichly: false };
const labels = items => items.map(entry => entry.type === 'separator' ? '-' : entry.label);

test('a text box gets undo, redo, cut, copy, paste and select all', () => {
  const items = contextMenuItems({ isEditable: true, editFlags: allEdits });
  assert.deepEqual(labels(items), ['Undo', 'Redo', '-', 'Cut', 'Copy', 'Paste', '-', 'Select All']);
  assert.ok(items.filter(entry => entry.label).every(entry => entry.enabled));
  assert.equal(items.find(entry => entry.label === 'Paste').accelerator, 'Ctrl+V');
});

test('edit commands Chromium says are unavailable are greyed out, not hidden', () => {
  const items = contextMenuItems({ isEditable: true, editFlags: { canPaste: true, canSelectAll: true } });
  const enabled = Object.fromEntries(items.filter(entry => entry.label).map(entry => [entry.label, entry.enabled]));
  assert.deepEqual(enabled, { Undo: false, Redo: false, Cut: false, Copy: false, Paste: true, 'Select All': true });
});

test('a rich text field also offers plain-text paste, named for the platform', () => {
  const flags = { ...allEdits, canEditRichly: true };
  assert.ok(labels(contextMenuItems({ isEditable: true, editFlags: flags })).includes('Paste as Plain Text'));
  const mac = contextMenuItems({ isEditable: true, editFlags: flags }, { mac: true });
  assert.ok(labels(mac).includes('Paste and Match Style'));
  assert.ok(mac.every(entry => !entry.accelerator), 'macOS context menus show no shortcuts');
});

test('selected page text can be copied; a blank spot shows nothing', () => {
  assert.deepEqual(labels(contextMenuItems({ selectionText: 'run 2657', editFlags: { canCopy: true } })), ['Copy']);
  assert.deepEqual(contextMenuItems({ selectionText: '  \n', editFlags: {} }), []);
  assert.deepEqual(contextMenuItems({}), []);
  assert.deepEqual(contextMenuItems(), []);
});

test('a misspelled word offers suggestions and Add to Dictionary above the edit commands', () => {
  const items = contextMenuItems({
    isEditable: true, editFlags: allEdits, misspelledWord: 'teh',
    dictionarySuggestions: ['the', 'ten', 'tech', 'tea', 'tee', 'Ted', 'eh'],
  });
  assert.deepEqual(labels(items).slice(0, 8), ['the', 'ten', 'tech', 'tea', 'tee', 'Add to Dictionary', '-', 'Undo']);
  assert.deepEqual(items[0], { label: 'the', action: 'replace', enabled: true, arg: 'the' });
  assert.equal(items[5].arg, 'teh');
  const none = contextMenuItems({ isEditable: true, editFlags: allEdits, misspelledWord: 'qzx', dictionarySuggestions: [] });
  assert.deepEqual(labels(none).slice(0, 2), ['No Guesses Found', 'Add to Dictionary']);
  assert.equal(none[0].enabled, false);
});

test('web links open in the browser or copy; email links copy the address; other schemes are ignored', () => {
  const web = contextMenuItems({ linkURL: 'https://1904.ai/agents?task=abc', selectionText: 'Open task', editFlags: { canCopy: true } });
  assert.deepEqual(labels(web), ['Open Link in Browser', 'Copy Link Address', '-', 'Copy']);
  assert.equal(web[1].arg, 'https://1904.ai/agents?task=abc');
  const email = contextMenuItems({ linkURL: 'mailto:support%401904.ai?subject=Hi' });
  assert.deepEqual(email, [{ label: 'Copy Email Address', action: 'copy-text', enabled: true, arg: 'support@1904.ai' }]);
  assert.equal(contextMenuItems({ linkURL: 'mailto:%E0%A4%A' })[0].arg, '%E0%A4%A');
  for (const linkURL of ['javascript:alert(1)', 'app-1904://task/abc', 'file:///C:/Windows', 'not a url']) {
    assert.deepEqual(contextMenuItems({ linkURL }), [], linkURL);
  }
});

test('images can be copied, and a web image address too', () => {
  assert.deepEqual(labels(contextMenuItems({ mediaType: 'image', hasImageContents: true, srcURL: 'https://1904.ai/a.png' })),
    ['Copy Image', 'Copy Image Address']);
  const inline = contextMenuItems({ mediaType: 'image', hasImageContents: false, srcURL: 'data:image/png;base64,AAAA' });
  assert.deepEqual(labels(inline), ['Copy Image']);
  assert.equal(inline[0].enabled, false);
});

test('every choice acts on the page that was right-clicked', () => {
  const contents = new EventEmitter();
  const calls = [];
  for (const name of ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'selectAll']) contents[name] = () => calls.push(name);
  contents.replaceMisspelling = word => calls.push(`replace:${word}`);
  contents.copyImageAt = (x, y) => calls.push(`image:${x},${y}`);
  contents.session = { addWordToSpellCheckerDictionary: word => calls.push(`learn:${word}`) };
  contents.isDestroyed = () => false;
  let shown;
  const Menu = { buildFromTemplate: template => ({ popup: options => { shown = { template, options }; } }) };
  const window = { id: 1 };
  installContextMenu(contents, {
    Menu, mac: false, windowFor: target => (target === contents ? window : null),
    clipboard: { writeText: text => calls.push(`clipboard:${text}`) },
    openBrowser: url => calls.push(`browser:${url}`),
  });

  const click = (params, label) => {
    shown = undefined;
    contents.emit('context-menu', {}, params);
    shown.template.find(entry => entry.label === label).click();
  };
  const frame = { url: 'https://1904.ai/agents' };
  click({ isEditable: true, editFlags: allEdits, frame }, 'Paste');
  assert.equal(shown.options.window, window);
  assert.equal(shown.options.frame, frame);
  assert.equal(shown.template.find(entry => entry.label === 'Paste').registerAccelerator, false);
  click({ isEditable: true, editFlags: allEdits }, 'Select All');
  click({ isEditable: true, editFlags: allEdits, misspelledWord: 'teh', dictionarySuggestions: ['the'] }, 'the');
  click({ isEditable: true, editFlags: allEdits, misspelledWord: 'teh', dictionarySuggestions: ['the'] }, 'Add to Dictionary');
  click({ linkURL: 'https://example.com/x' }, 'Open Link in Browser');
  click({ linkURL: 'https://example.com/x' }, 'Copy Link Address');
  click({ mediaType: 'image', hasImageContents: true, x: 10, y: 20 }, 'Copy Image');
  assert.deepEqual(calls, ['paste', 'selectAll', 'replace:the', 'learn:teh', 'browser:https://example.com/x',
    'clipboard:https://example.com/x', 'image:10,20']);

  shown = undefined;
  contents.emit('context-menu', {}, { editFlags: {} });
  assert.equal(shown, undefined, 'nothing to offer shows no menu');

  contents.isDestroyed = () => true;
  click({ isEditable: true, editFlags: allEdits }, 'Cut');
  assert.equal(calls.length, 7, 'a closed page is left alone');
});
