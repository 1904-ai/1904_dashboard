const { ipcRenderer } = require('electron');

// The recovery panel can be asked for before this page has loaded.
let recovery = null;

function showRecovery() {
  const panel = document.getElementById('recovery');
  if (!panel) return;
  panel.hidden = !recovery;
  if (!recovery) return;
  document.getElementById('recovery-title').textContent = recovery.title;
  document.getElementById('recovery-detail').textContent = recovery.detail;
  document.getElementById('recovery-status').textContent = recovery.status;
  const retry = document.getElementById('recovery-retry');
  retry.textContent = recovery.action;
  retry.disabled = recovery.trying;
  panel.toggleAttribute('data-trying', recovery.trying);
}

// How many commands are running on this computer (Use My Computer).
let computerRunning = 0;

function showComputerActivity() {
  const button = document.getElementById('computer-activity');
  if (!button) return;
  button.hidden = computerRunning === 0;
  const text = computerRunning > 1
    ? `${computerRunning} commands are running on this computer. Open Computer Activity.`
    : 'A command is running on this computer. Open Computer Activity.';
  button.title = text;
  button.setAttribute('aria-label', text);
}

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform;
  document.getElementById('app-menu').addEventListener('click', () => ipcRenderer.send('1904:show-menu'));
  document.getElementById('recovery-retry').addEventListener('click', () => ipcRenderer.send('1904:recovery-retry'));
  document.getElementById('computer-activity').addEventListener('click', () => ipcRenderer.send('1904:show-computer-activity'));
  showRecovery();
  showComputerActivity();
});

ipcRenderer.on('1904:chrome-computer', (_event, running) => {
  computerRunning = Number.isInteger(running) && running > 0 ? running : 0;
  showComputerActivity();
});

ipcRenderer.on('1904:chrome-theme', (_event, theme) => {
  document.documentElement.dataset.theme = theme;
});

ipcRenderer.on('1904:chrome-task-title-bar', (_event, active) => {
  document.documentElement.toggleAttribute('data-task-title-bar', active);
});

ipcRenderer.on('1904:chrome-recovery', (_event, state) => {
  recovery = state;
  showRecovery();
});
