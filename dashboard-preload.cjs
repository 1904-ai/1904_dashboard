const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame && window.location.origin === 'https://1904.ai') {
  contextBridge.exposeInMainWorld('desktop1904', {
    notifyTask: item => ipcRenderer.invoke('1904:task-notification', item),
    taskTitleBar: {
      platform: process.platform === 'darwin' ? 'macos' : 'windows',
      setActive: active => ipcRenderer.send('1904:task-title-bar', active),
      showAppMenu: () => ipcRenderer.send('1904:task-title-bar-menu'),
    },
    // Use My Computer: whether this computer is connected or paused, and ways to start connecting it
    // or start away mode for a task (the person answers every question natively). Nothing here can
    // run a command, answer a request, read output, or end the person's control.
    computer: {
      state: () => ipcRenderer.invoke('1904:computer-state'),
      connect: () => ipcRenderer.invoke('1904:computer-connect'),
      away: task => ipcRenderer.invoke('1904:computer-away', {
        taskId: task?.taskId, appId: task?.appId, taskTitle: task?.taskTitle,
      }),
      showActivity: () => ipcRenderer.send('1904:computer-activity'),
    },
  });
  ipcRenderer.on('1904:resume', () => window.dispatchEvent(new Event('shipt:retry-connection')));
  window.addEventListener('DOMContentLoaded', () => {
    let previousTheme;
    let scheduled = false;
    const readTheme = () => {
      scheduled = false;
      const value = document.querySelector('.shipt-product[data-dashboard-theme]')?.dataset.dashboardTheme;
      const theme = value === 'dark' || value === 'light' ? value : null;
      if (theme === previousTheme) return;
      previousTheme = theme;
      ipcRenderer.send('1904:dashboard-theme', theme);
    };
    new MutationObserver(() => {
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(readTheme);
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-dashboard-theme'] });
    readTheme();
  });
}
