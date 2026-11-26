const { ipcRenderer } = require('electron');

// The password prompt for one deploy to a host whose password the person chose not to save. The page
// runs no script; this preload shows what the main process says with textContent and sends back what
// was typed, with the nonce of the question it answers. Closing the window, or Cancel, sends nothing.

let nonce;

ipcRenderer.on('1904:secret-view', (_event, view) => {
  nonce = view?.nonce;
  document.documentElement.dataset.theme = view?.theme === 'light' ? 'light' : 'dark';
  document.getElementById('heading').textContent = String(view?.heading ?? '');
  document.getElementById('detail').textContent = String(view?.detail ?? '');
  document.getElementById('password').focus();
});

window.addEventListener('DOMContentLoaded', () => {
  const password = document.getElementById('password');
  const go = document.getElementById('continue');
  password.addEventListener('input', () => { go.disabled = password.value.length === 0; });
  document.getElementById('form').addEventListener('submit', event => {
    event.preventDefault();
    if (!nonce || !password.value) return;
    ipcRenderer.send('1904:secret-answer', nonce, password.value);
    password.value = '';
  });
  document.getElementById('cancel').addEventListener('click', () => window.close());
  window.addEventListener('keydown', event => { if (event.key === 'Escape') window.close(); });
});
