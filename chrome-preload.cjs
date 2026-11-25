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

// Multi-account summary shown in the native title bar.
let accountsState = null;

function accountInitials(account) {
  const source = String(account?.name || account?.email?.split('@')[0] || '').trim();
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return '+';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return ((parts[0][0] || '') + (parts[1][0] || '')).toUpperCase();
}

function showAccounts() {
  const button = document.getElementById('account-switcher');
  if (!button) return;
  const list = Array.isArray(accountsState?.accounts) ? accountsState.accounts : [];
  const active = list.find(entry => entry.active) || list[0];
  const hasSaved = list.some(entry => entry.signedIn || entry.email || entry.userId);
  button.hidden = !active || (!hasSaved && list.length <= 1);
  if (button.hidden) return;
  const avatar = document.getElementById('account-avatar');
  const label = document.getElementById('account-label');
  const count = document.getElementById('account-count');
  const isAdding = !active.signedIn && !active.email && !active.userId;
  const text = isAdding ? 'Add account' : (active.name || active.email || '1904 Account');
  avatar.textContent = isAdding ? '+' : accountInitials(active);
  label.textContent = text;
  const savedCount = list.filter(entry => entry.signedIn || entry.email || entry.userId).length;
  count.hidden = savedCount <= 1;
  count.textContent = savedCount > 1 ? `(${savedCount})` : '';
  const title = isAdding
    ? 'Sign in to add an account, or click to switch back'
    : `${text}${active.email && active.name ? ` · ${active.email}` : ''} — Switch or add account`;
  button.title = title;
  button.setAttribute('aria-label', title);
}

window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.platform = process.platform;
  document.getElementById('app-menu').addEventListener('click', () => ipcRenderer.send('1904:show-menu'));
  document.getElementById('recovery-retry').addEventListener('click', () => ipcRenderer.send('1904:recovery-retry'));
  document.getElementById('computer-activity').addEventListener('click', () => ipcRenderer.send('1904:show-computer-activity'));
  document.getElementById('account-switcher').addEventListener('click', event => {
    const rect = event.currentTarget.getBoundingClientRect();
    ipcRenderer.send('1904:chrome-account-menu', { x: Math.round(rect.left), y: Math.round(rect.bottom + 4) });
  });
  showRecovery();
  showComputerActivity();
  showAccounts();
});

ipcRenderer.on('1904:chrome-computer', (_event, running) => {
  computerRunning = Number.isInteger(running) && running > 0 ? running : 0;
  showComputerActivity();
});

ipcRenderer.on('1904:chrome-accounts', (_event, state) => {
  accountsState = state && typeof state === 'object' ? state : null;
  showAccounts();
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
