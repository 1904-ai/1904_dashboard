const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform;
  document.getElementById('app-menu').addEventListener('click', () => ipcRenderer.send('1904:show-menu', 'application'));
  document.getElementById('help-menu').addEventListener('click', () => ipcRenderer.send('1904:show-menu', 'help'));
});

ipcRenderer.on('1904:chrome-theme', (_event, theme) => {
  document.documentElement.dataset.theme = theme;
});
