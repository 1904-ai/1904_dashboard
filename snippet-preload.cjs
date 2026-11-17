const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame) {
  const request = (action, input) => ipcRenderer.invoke('1904:snippet-overlay', action, input);
  contextBridge.exposeInMainWorld('snippetOverlay', {
    initial: () => request('initial'),
    displays: index => request('display', index),
    windows: () => request('windows'),
    window: index => request('window', index),
    attach: (revision, rect) => request('attach', { revision, rect }),
    cancel: () => request('cancel'),
  });
}
