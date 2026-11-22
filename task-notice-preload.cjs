const { ipcRenderer } = require('electron');

// Bottom-right task notification drawer (Windows). Renders only via textContent so
// nothing from 1904 is parsed as HTML. Clicking Close or letting the timer expire only
// closes the drawer; only clicking Open Task asks the main process to open the task.

let currentNonce = '';
let totalDurationMs = 12_000;
let hovered = false;

const $ = id => document.getElementById(id);

function setQueued(count) {
  const pill = $('queued');
  if (!pill) return;
  if (Number.isInteger(count) && count > 0) {
    pill.textContent = `+${count} more`;
    pill.hidden = false;
  } else {
    pill.textContent = '';
    pill.hidden = true;
  }
}

function startProgress(remainingMs, paused) {
  const bar = $('progress');
  if (!bar) return;
  const fraction = totalDurationMs > 0 ? Math.max(0, Math.min(1, remainingMs / totalDurationMs)) : 0;
  bar.style.transition = 'none';
  bar.style.transform = `scaleX(${fraction})`;
  if (paused || remainingMs <= 0) return;
  void bar.offsetWidth;
  bar.style.transition = `transform ${Math.round(remainingMs)}ms linear`;
  bar.style.transform = 'scaleX(0)';
}

function sendAction(action) {
  if (!currentNonce) return;
  const nonce = currentNonce;
  currentNonce = '';
  $('drawer')?.setAttribute('data-state', 'closing');
  ipcRenderer.send('1904:task-notice-action', { nonce, action });
}

function reportSize() {
  const stage = document.querySelector('.stage');
  if (!stage) return;
  const height = Math.ceil(stage.getBoundingClientRect().height);
  if (Number.isFinite(height) && height > 0) {
    ipcRenderer.send('1904:task-notice-size', height);
  }
}

function render(payload) {
  if (!payload || typeof payload.nonce !== 'string' || !payload.notice) return;
  currentNonce = payload.nonce;
  totalDurationMs = Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0 ? payload.timeoutMs : 12_000;
  document.documentElement.dataset.theme = payload.theme === 'light' ? 'light' : 'dark';

  const logo = $('logo');
  if (typeof payload.icon === 'string' && payload.icon.startsWith('data:image/png;base64,')) {
    logo.src = payload.icon;
    logo.hidden = false;
  } else {
    logo.hidden = true;
  }

  const drawer = $('drawer');
  drawer.dataset.kind = payload.notice.kind === 'task_needs_you' ? 'task_needs_you' : 'task_ready';
  $('badge').textContent = payload.notice.badge || '';
  $('title').textContent = payload.notice.title || '';
  $('body').textContent = payload.notice.body || '';
  setQueued(payload.queuedCount);

  drawer.dataset.state = 'idle';
  requestAnimationFrame(() => {
    reportSize();
    drawer.dataset.state = 'open';
    startProgress(payload.remainingMs ?? totalDurationMs, hovered);
    if (hovered) {
      ipcRenderer.send('1904:task-notice-hover', { nonce: currentNonce, hovered: true });
    }
  });
}

ipcRenderer.on('1904:task-notice-show', (_event, payload) => render(payload));

ipcRenderer.on('1904:task-notice-hide', (_event, payload) => {
  if (payload?.nonce && currentNonce && payload.nonce !== currentNonce) return;
  currentNonce = '';
  $('drawer')?.setAttribute('data-state', 'closing');
});

ipcRenderer.on('1904:task-notice-timer', (_event, payload) => {
  if (!payload || payload.nonce !== currentNonce) return;
  setQueued(payload.queuedCount);
  startProgress(payload.remainingMs, Boolean(payload.paused));
});

ipcRenderer.on('1904:task-notice-theme', (_event, theme) => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
});

window.addEventListener('DOMContentLoaded', () => {
  $('open').addEventListener('click', () => sendAction('open'));
  $('close').addEventListener('click', () => sendAction('close'));
  $('dismiss-icon').addEventListener('click', () => sendAction('close'));
  const drawer = $('drawer');
  drawer.addEventListener('mouseenter', () => {
    hovered = true;
    if (currentNonce) ipcRenderer.send('1904:task-notice-hover', { nonce: currentNonce, hovered: true });
  });
  drawer.addEventListener('mouseleave', () => {
    hovered = false;
    if (currentNonce) ipcRenderer.send('1904:task-notice-hover', { nonce: currentNonce, hovered: false });
  });
  ipcRenderer.send('1904:task-notice-ready');
});
