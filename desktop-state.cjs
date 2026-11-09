const { readFileSync, renameSync, writeFileSync } = require('node:fs');

function readState(file) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('1904 Desktop could not read window preferences.');
    return {};
  }
}

function saveState(file, state) {
  try {
    writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
    renameSync(file + '.tmp', file);
  } catch {
    console.warn('1904 Desktop could not save window preferences.');
  }
}

function windowOptions(saved, displays, primary, minimum) {
  const valid = saved && ['x', 'y', 'width', 'height'].every(key => Number.isSafeInteger(saved[key])) &&
    saved.width > 0 && saved.height > 0;
  const overlap = ({ workArea: area }) => Math.max(0, Math.min(area.x + area.width, saved.x + saved.width) - Math.max(area.x, saved.x)) *
    Math.max(0, Math.min(area.y + area.height, saved.y + saved.height) - Math.max(area.y, saved.y));
  const display = valid ? displays.reduce((best, current) => overlap(current) > overlap(best) ? current : best, primary) : primary;
  const { x, y, width, height } = display.workArea;
  const minWidth = Math.min(minimum.width, width);
  const minHeight = Math.min(minimum.height, height);
  const fittedWidth = Math.max(minWidth, Math.min(valid ? saved.width : 1440, width));
  const fittedHeight = Math.max(minHeight, Math.min(valid ? saved.height : 960, height));
  return {
    width: fittedWidth, height: fittedHeight, minWidth, minHeight,
    x: valid && overlap(display) > 0 ? Math.max(x, Math.min(saved.x, x + width - fittedWidth)) : x + Math.floor((width - fittedWidth) / 2),
    y: valid && overlap(display) > 0 ? Math.max(y, Math.min(saved.y, y + height - fittedHeight)) : y + Math.floor((height - fittedHeight) / 2),
  };
}

module.exports = { readState, saveState, windowOptions };
