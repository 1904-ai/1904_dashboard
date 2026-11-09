const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform;
  document.getElementById('app-menu').addEventListener('click', () => ipcRenderer.send('1904:show-menu'));
});

ipcRenderer.on('1904:chrome-theme', (_event, theme) => {
  document.documentElement.dataset.theme = theme;
});

ipcRenderer.on('1904:chrome-task-title-bar', (_event, active) => {
  document.documentElement.toggleAttribute('data-task-title-bar', active);
});
