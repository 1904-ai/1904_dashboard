// The right-click menu. A browser draws this itself; Electron only reports the click, so without
// this nothing appears at all. contextMenuItems decides what the menu holds from what was clicked
// and has no Electron in it, so it can be tested with plain Node. installContextMenu wires it up.

const MAX_SUGGESTIONS = 5;

function parsed(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isWeb(value) {
  return ['http:', 'https:'].includes(parsed(value)?.protocol);
}

/** Links worth copying: web pages and email addresses, never script or internal URLs. */
function isCopyableLink(value) {
  return isWeb(value) || parsed(value)?.protocol === 'mailto:';
}

function emailAddress(link) {
  try {
    return decodeURIComponent(link.pathname);
  } catch {
    return link.pathname;
  }
}

function item(label, action, enabled, arg, accelerator) {
  return { label, action, enabled: Boolean(enabled), ...(arg === undefined ? {} : { arg }), ...(accelerator ? { accelerator } : {}) };
}

/**
 * The menu for one right-click, as plain items: { label, action, enabled, arg?, accelerator? }
 * or { type: 'separator' }. An empty list means show nothing.
 */
function contextMenuItems(params = {}, { mac = false } = {}) {
  const flags = params.editFlags ?? {};
  const key = (shortcut) => (mac ? undefined : shortcut);
  const groups = [];

  if (params.isEditable && params.misspelledWord) {
    const suggestions = (params.dictionarySuggestions ?? []).slice(0, MAX_SUGGESTIONS);
    groups.push([
      ...(suggestions.length
        ? suggestions.map(word => item(word, 'replace', true, word))
        : [item('No Guesses Found', 'none', false)]),
      item('Add to Dictionary', 'learn', true, params.misspelledWord),
    ]);
  }

  const link = isCopyableLink(params.linkURL) ? parsed(params.linkURL) : null;
  if (link?.protocol === 'mailto:') {
    groups.push([item('Copy Email Address', 'copy-text', true, emailAddress(link))]);
  } else if (link) {
    groups.push([
      item('Open Link in Browser', 'open-link', true, params.linkURL),
      item('Copy Link Address', 'copy-text', true, params.linkURL),
    ]);
  }

  if (params.mediaType === 'image') {
    groups.push([
      item('Copy Image', 'copy-image', params.hasImageContents !== false),
      ...(isWeb(params.srcURL) ? [item('Copy Image Address', 'copy-text', true, params.srcURL)] : []),
    ]);
  }

  if (params.isEditable) {
    groups.push([item('Undo', 'undo', flags.canUndo, undefined, key('Ctrl+Z')), item('Redo', 'redo', flags.canRedo, undefined, key('Ctrl+Y'))]);
    groups.push([
      item('Cut', 'cut', flags.canCut, undefined, key('Ctrl+X')),
      item('Copy', 'copy', flags.canCopy, undefined, key('Ctrl+C')),
      item('Paste', 'paste', flags.canPaste, undefined, key('Ctrl+V')),
      ...(flags.canEditRichly ? [item(mac ? 'Paste and Match Style' : 'Paste as Plain Text', 'pasteAndMatchStyle', flags.canPaste, undefined, key('Ctrl+Shift+V'))] : []),
    ]);
    groups.push([item('Select All', 'selectAll', flags.canSelectAll, undefined, key('Ctrl+A'))]);
  } else if (params.selectionText?.trim()) {
    groups.push([item('Copy', 'copy', flags.canCopy !== false, undefined, key('Ctrl+C'))]);
  }

  return groups.filter(group => group.length).flatMap((group, index) => (index ? [{ type: 'separator' }, ...group] : group));
}

/**
 * Shows the menu for every right-click in `contents`. A page that handles right-click itself
 * (and calls preventDefault) never reaches here, so its own menu still wins.
 */
function installContextMenu(contents, { Menu, clipboard, openBrowser, windowFor, mac = process.platform === 'darwin' }) {
  contents.on('context-menu', (_event, params) => {
    const items = contextMenuItems(params, { mac });
    if (!items.length) return;
    const run = ({ action, arg }) => {
      if (contents.isDestroyed()) return;
      switch (action) {
        case 'replace': contents.replaceMisspelling(arg); break;
        case 'learn': contents.session.addWordToSpellCheckerDictionary(arg); break;
        case 'open-link': openBrowser(arg); break;
        // Asynchronous since Electron 45.
        case 'copy-text': void Promise.resolve(clipboard.writeText(arg)).catch(() => {}); break;
        case 'copy-image': contents.copyImageAt(params.x, params.y); break;
        case 'undo': case 'redo': case 'cut': case 'copy': case 'paste': case 'pasteAndMatchStyle': case 'selectAll':
          contents[action]();
          break;
        default: break;
      }
    };
    const template = items.map(entry => (entry.type === 'separator' ? entry : {
      label: entry.label,
      enabled: entry.enabled,
      ...(entry.accelerator ? { accelerator: entry.accelerator, registerAccelerator: false } : {}),
      click: () => run(entry),
    }));
    Menu.buildFromTemplate(template).popup({ window: windowFor(contents), frame: params.frame ?? undefined });
  });
}

module.exports = { contextMenuItems, installContextMenu };
