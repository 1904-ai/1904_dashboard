// Keyboard shortcuts for a task's tabs. A browser keeps Ctrl+T, Ctrl+W and Ctrl+Tab for its own tabs,
// so the dashboard cannot use them there; 1904 Desktop has no tabs of its own, so while the Agents page
// says a task's tab strip is on screen, these keys drive that strip instead. taskTabCommand has no
// Electron in it, so it can be tested with plain Node; main.cjs wires it to 'before-input-event'.

const TASK_TAB_COMMANDS = Object.freeze(['new', 'close', 'next', 'previous']);

/** The letter a key press names: the typed letter, or on a non-Latin layout the physical key, as menu shortcuts do. */
function letter(input) {
  const key = typeof input.key === 'string' ? input.key : '';
  if (/^[a-z]$/i.test(key)) return key.toLowerCase();
  const code = typeof input.code === 'string' ? /^Key([A-Z])$/.exec(input.code) : null;
  return code ? code[1].toLowerCase() : '';
}

/**
 * The tab command an Electron input event asks for, or undefined. Modifiers must match exactly:
 * - new: Cmd+T on macOS, Ctrl+T elsewhere
 * - close: Cmd+W on macOS, Ctrl+W elsewhere
 * - next: Ctrl+Tab everywhere
 * - previous: Ctrl+Shift+Tab everywhere
 * Only key presses count, never releases. Holding T or W down opens or closes one tab, not one per repeat;
 * holding Tab keeps moving.
 */
function taskTabCommand(input, platform) {
  if (!input || input.type !== 'keyDown' || input.alt === true) return undefined;
  const control = input.control === true;
  const meta = input.meta === true;
  const shift = input.shift === true;
  if (input.key === 'Tab') {
    if (!control || meta) return undefined;
    return shift ? 'previous' : 'next';
  }
  if (shift || input.isAutoRepeat === true) return undefined;
  const mac = platform === 'darwin';
  if (mac ? !meta || control : !control || meta) return undefined;
  const pressed = letter(input);
  if (pressed === 't') return 'new';
  if (pressed === 'w') return 'close';
  return undefined;
}

module.exports = { TASK_TAB_COMMANDS, taskTabCommand };
