const { ipcRenderer } = require('electron');

// Guided Connect your browser window. The page runs no script; this preload renders main-process state with
// textContent only and asks main to copy the pairing code or open the staged extension folder, so the pairing
// secret never enters the DOM.

const timers = new Map();

function flash(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => { el.textContent = ''; }, 5000));
}

function hostLabel(site) {
  if (!site) return '';
  try { return new URL(site).host || site; } catch { return site; }
}

function render(view) {
  if (!view || typeof view !== 'object') return;
  if (view.theme) document.documentElement.dataset.theme = view.theme === 'light' ? 'light' : 'dark';
  const pill = document.getElementById('status-pill');
  const banner = document.getElementById('connected-banner');
  const heading = document.getElementById('connected-heading');
  const detail = document.getElementById('connected-detail');
  const close = document.getElementById('close');
  const connected = Boolean(view.available);
  const host = hostLabel(view.site);
  if (pill) {
    pill.dataset.connected = connected ? 'true' : 'false';
    pill.textContent = connected
      ? `${view.browser || 'Browser'} connected${host ? ` · ${host}` : ''}`
      : 'Not connected';
  }
  if (banner && heading && detail) {
    banner.hidden = !connected;
    if (connected) {
      heading.textContent = `${view.browser || 'Browser'} is connected`;
      detail.textContent = host
        ? `Sharing a tab on ${host}. You can close this window now, or share a different tab anytime using the pairing code below.`
        : 'Your shared browser tab is ready. You can close this window now, or share a different tab anytime using the pairing code below.';
    }
  }
  if (close) {
    close.textContent = connected ? 'Done' : 'Close';
    close.classList.toggle('primary', connected);
  }
  const preview = document.getElementById('code-preview');
  if (preview && view.codePreview) preview.textContent = String(view.codePreview);
  const folder = document.getElementById('folder-path');
  if (folder && view.folder) folder.textContent = String(view.folder);
}

ipcRenderer.on('1904:browser-connect-theme', (_event, theme) => {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
});

ipcRenderer.on('1904:browser-connect-state', (_event, view) => render(view));

window.addEventListener('DOMContentLoaded', () => {
  void ipcRenderer.invoke('1904:browser-connect-state').then(render);
  document.getElementById('copy-chrome-url').addEventListener('click', async () => {
    if (await ipcRenderer.invoke('1904:browser-connect-copy-url', 'chrome://extensions')) {
      flash('url-feedback', 'Copied chrome://extensions — paste it into Chrome’s address bar and press Enter.');
    }
  });
  document.getElementById('copy-edge-url').addEventListener('click', async () => {
    if (await ipcRenderer.invoke('1904:browser-connect-copy-url', 'edge://extensions')) {
      flash('url-feedback', 'Copied edge://extensions — paste it into Edge’s address bar and press Enter.');
    }
  });
  document.getElementById('open-folder').addEventListener('click', async () => {
    if (await ipcRenderer.invoke('1904:browser-connect-open-folder')) {
      flash('folder-feedback', 'Opened folder — select the 1904-browser-extension folder in Chrome or Edge’s Load unpacked dialog.');
    }
  });
  document.getElementById('copy-folder').addEventListener('click', async () => {
    if (await ipcRenderer.invoke('1904:browser-connect-copy-folder')) {
      flash('folder-feedback', 'Copied folder path — paste it in the Load unpacked file picker.');
    }
  });
  document.getElementById('copy-code').addEventListener('click', async () => {
    if (await ipcRenderer.invoke('1904:browser-connect-copy-code')) {
      flash('code-feedback', 'Pairing code copied — paste it into the 1904 Desktop Browser extension popup.');
    }
  });
  document.getElementById('close').addEventListener('click', () => window.close());
  window.addEventListener('keydown', event => { if (event.key === 'Escape') window.close(); });
});
