const { contextBridge, ipcRenderer } = require('electron');

if (process.isMainFrame && window.location.origin === 'https://1904.ai') {
  // What the mounted page last asked for. In-page navigation replays it, including Settings overlays;
  // the main process still restricts task keys to Agents routes.
  let titleBarWanted = false;
  // The same for the tab keys: whether Ctrl/Cmd+T, Ctrl/Cmd+W and Ctrl+Tab should drive the task's tabs now.
  let tabKeysWanted = false;
  const TAB_COMMANDS = ['new', 'close', 'next', 'previous'];
  const tabCommandListeners = new Set();
  contextBridge.exposeInMainWorld('desktop1904', {
    snippet: {
      capture: requestId => navigator.userActivation.isActive
        ? ipcRenderer.invoke('1904:snippet-start', requestId) : Promise.resolve(null),
      cancel: requestId => ipcRenderer.send('1904:snippet-cancel', requestId),
    },
    notifyTask: item => ipcRenderer.invoke('1904:task-notification', item),
    taskTitleBar: {
      platform: process.platform === 'darwin' ? 'macos' : 'windows',
      setActive: active => {
        if (typeof active !== 'boolean') return;
        titleBarWanted = active;
        ipcRenderer.send('1904:task-title-bar', active);
      },
      showAppMenu: () => ipcRenderer.send('1904:task-title-bar-menu'),
    },
    // Task tabs: the page says when the tab keys apply, and hears which of four commands was pressed.
    // Nothing else crosses: no key events, no other keys, nothing from Electron.
    taskTabs: {
      setActive: active => {
        if (typeof active !== 'boolean') return;
        tabKeysWanted = active;
        ipcRenderer.send('1904:task-tab-keys', active);
      },
      onCommand: listener => {
        if (typeof listener !== 'function') return () => {};
        const entry = { listener };
        tabCommandListeners.add(entry);
        return () => { tabCommandListeners.delete(entry); };
      },
    },
    // Use My Computer: whether this computer is connected or paused, and ways to start connecting it
    // or start away mode for a task (the person answers every question natively). Nothing here can
    // run a command, answer a request, read output, or end the person's control.
    browser: {
      state: () => ipcRenderer.invoke('1904:browser-state'),
      setPreference: value => ipcRenderer.invoke('1904:browser-preference', value),
      setup: () => ipcRenderer.invoke('1904:browser-setup'),
      execute: input => ipcRenderer.invoke('1904:browser-execute', {appId:input?.appId,taskId:input?.taskId,taskTab:input?.taskTab,session:input?.session,requestId:input?.requestId}),
      focus: input => ipcRenderer.invoke('1904:browser-focus', {appId:input?.appId,taskId:input?.taskId,taskTab:input?.taskTab,session:input?.session}),
      release: input => ipcRenderer.invoke('1904:browser-release', {appId:input?.appId,taskId:input?.taskId,taskTab:input?.taskTab,session:input?.session}),
    },
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
  ipcRenderer.on('1904:task-title-bar-replay', () => {
    ipcRenderer.send('1904:task-title-bar', titleBarWanted);
    ipcRenderer.send('1904:task-tab-keys', tabKeysWanted);
  });
  ipcRenderer.on('1904:task-tab-command', (_event, command) => {
    if (!TAB_COMMANDS.includes(command)) return;
    for (const { listener } of [...tabCommandListeners]) {
      try {
        listener(command);
      } catch (error) {
        console.error(error);
      }
    }
  });
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
