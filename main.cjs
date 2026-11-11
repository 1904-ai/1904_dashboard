const { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, Menu, nativeTheme, net, Notification, powerMonitor, screen, session, shell } = require('electron');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { startUpdater } = require('./updater.cjs');
const { SCHEME, IMPORT_PATH, taskUrl, repositorySetupUrl, readLink, startSignIn } = require('./desktop-links.cjs');
const { readState, saveState, windowOptions } = require('./desktop-state.cjs');
const { CRASH_WINDOW_MS, retryDelay, isServerFailure, retryTarget, recoveryView } = require('./desktop-recovery.cjs');

const ORIGIN = 'https://1904.ai';
const AGENTS = `${ORIGIN}/agents`;
const PARTITION = 'persist:1904-agents';
const ICON = path.join(__dirname, 'assets', 'icon.png');
const CHROME_HEIGHT = 44;
const PALETTE = {
  dark: { color: '#121416', symbolColor: '#e2e7ec' },
  light: { color: '#f6f8fa', symbolColor: '#20262d' },
};
const DASHBOARD_CSS = readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
const SOCIAL_AUTH = new Set([
  'https://accounts.google.com/o/oauth2/v2/auth',
  'https://github.com/login/oauth/authorize',
  'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
]);
const SAFE_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  webviewTag: false,
};
const WINDOW_PREFERENCES = { ...SAFE_PREFERENCES, partition: PARTITION };

let mainWindow;
let dashboardView;
let dashboardContents;
let dashboardTheme;
let taskTitleBar = false;
let signInPromptOpen = false;
let signInAttempt;
let queuedLink;
let desktopReady = false;
let loginReturnTo = '/agents';
// Set while the dashboard cannot be shown: { kind, url, attempts, trying, timer }.
let recovery;
let lastCrashAt = 0;
// A Cloudflare challenge answers with an error status but is a page the person must see.
let challengeUrl;
const notices = new Map();
const notified = new Set();

function webUrl(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

function is1904(value) {
  return webUrl(value)?.origin === ORIGIN;
}

function openBrowser(url) {
  const target = webUrl(url);
  if (target) void shell.openExternal(target.href).catch(() => {
    dialog.showErrorBox('Could not open your browser', 'Open 1904.ai in your browser and try again.');
  });
}

function loadPage(contents, url) {
  if (contents && !contents.isDestroyed() && is1904(url)) {
    // Opening anything while the dashboard is down is itself the next attempt.
    if (recovery && contents === dashboardContents) {
      clearTimeout(recovery.timer);
      recovery = { ...recovery, url, attempts: recovery.attempts + 1, trying: true, timer: undefined };
      sendRecovery();
    }
    // Chromium reports main-frame load errors through did-fail-load below.
    void contents.loadURL(url).catch(() => {});
  }
}

function fallbackUrl() {
  return loginReturnTo === IMPORT_PATH ? ORIGIN + IMPORT_PATH : taskUrl(loginReturnTo, ORIGIN)?.href || AGENTS;
}

function sendRecovery() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('1904:chrome-recovery', recoveryView(recovery));
}

// The dashboard could not be loaded. Hide its view (an error page helps nobody), say what is
// happening in the window itself, and keep trying behind it until a page loads.
function startRecovery(kind, failedUrl) {
  if (!mainWindow || mainWindow.isDestroyed() || !dashboardContents || dashboardContents.isDestroyed()) return;
  clearTimeout(recovery?.timer);
  const attempts = recovery?.attempts ?? 0;
  if (!recovery) {
    setTaskTitleBar(false);
    dashboardTheme = undefined;
    syncTitleBar();
    dashboardView.setVisible(false);
    if (mainWindow.isFocused()) mainWindow.webContents.focus();
  }
  recovery = {
    kind, attempts, trying: false,
    url: retryTarget(failedUrl, ORIGIN, fallbackUrl()),
    // A page that crashes twice is not retried on a timer: it would crash in a loop.
    timer: kind === 'crashed' ? undefined : setTimeout(retryNow, retryDelay(attempts)),
  };
  sendRecovery();
}

function retryNow() {
  if (recovery) loadPage(dashboardContents, recovery.url);
}

function endRecovery() {
  if (!recovery) return;
  clearTimeout(recovery.timer);
  recovery = undefined;
  if (dashboardView) dashboardView.setVisible(true);
  sendRecovery();
  if (mainWindow?.isFocused() && dashboardContents && !dashboardContents.isDestroyed()) dashboardContents.focus();
}

function openTask(target) {
  const task = taskUrl(target, ORIGIN);
  if (!task) return;
  loginReturnTo = task.pathname + task.search;
  showDashboard();
  loadPage(dashboardContents, task.href);
}

function openRepositoryImport() {
  loginReturnTo = IMPORT_PATH;
  showDashboard();
  loadPage(dashboardContents, ORIGIN + IMPORT_PATH);
}

function beginBrowserSignIn() {
  signInAttempt = { ...startSignIn(ORIGIN), returnTo: loginReturnTo };
  openBrowser(signInAttempt.url);
}

function handleLink(link) {
  if (!link) return false;
  if (!desktopReady) {
    queuedLink = link;
    return true;
  }
  if (link.importRepository) {
    openRepositoryImport();
    return true;
  }
  if (link.target) {
    openTask(link.target);
    return true;
  }
  const attempt = signInAttempt;
  if (!attempt || attempt.state !== link.state || attempt.expiresAt <= Date.now()) return false;
  signInAttempt = undefined;
  showDashboard();
  // A pending retry must not navigate away from the sign-in exchange.
  clearTimeout(recovery?.timer);
  const data = new URLSearchParams({ code: link.code, state: link.state, verifier: attempt.verifier, returnTo: attempt.returnTo });
  void dashboardContents.loadURL(ORIGIN + '/api/auth/desktop/exchange', {
    postData: [{ type: 'rawData', bytes: Buffer.from(data.toString()) }],
    extraHeaders: 'Content-Type: application/x-www-form-urlencoded\r\nX-1904-Desktop-Exchange: 1\r\n',
  }).catch(() => {
    // Main-frame network failures are handled by did-fail-load.
  });
  return true;
}

async function explainSocialSignIn(contents) {
  const win = contents === dashboardContents ? mainWindow : BrowserWindow.fromWebContents(contents);
  if (!win || win.isDestroyed() || signInPromptOpen) return;
  signInPromptOpen = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Continue sign-in in your browser',
      detail: 'Sign in to 1904 in your browser, then choose Open 1904 Desktop. You can also sign in here with email.',
      buttons: ['Use email here', 'Continue in browser'],
      defaultId: 0,
      cancelId: 0,
    });
    loadPage(contents, ORIGIN + '/login?' + new URLSearchParams({ returnTo: loginReturnTo }));
    if (response === 1) beginBrowserSignIn();
  } finally {
    signInPromptOpen = false;
  }
}

function openCopiedLink() {
  const url = webUrl(clipboard.readText().trim());
  const isTaskLink = url?.pathname === '/agents' || url?.pathname === '/agents-beta2';
  const isEmailLink = url?.pathname === '/api/auth/magic/verify' && url.searchParams.has('token');
  if (url?.origin !== ORIGIN || !(isTaskLink || isEmailLink)) {
    dialog.showMessageBoxSync(mainWindow, {
      type: 'info',
      message: 'Copy a 1904 task or email sign-in link first',
      detail: 'Copy the link address from your browser or the sign-in email, then choose Open Copied 1904 Link again.',
    });
    return;
  }
  if (taskUrl(url.href, ORIGIN)) openTask(url.href);
  else loadPage(dashboardContents, url.href);
}

function installNavigationRules(contents) {
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('will-navigate', (event) => {
    if (is1904(event.url)) return;
    event.preventDefault();
    if (contents === dashboardContents && is1904(contents.getURL()) && (!event.initiator || is1904(event.initiator.url))) {
      const link = readLink(event.url, ORIGIN);
      if (link?.target || link?.importRepository) { handleLink(link); return; }
    }
    const target = webUrl(event.url);
    if (!target || !is1904(contents.getURL())) return;
    if (event.initiator && !is1904(event.initiator.url)) return;
    if (SOCIAL_AUTH.has(target.origin + target.pathname)) {
      void explainSocialSignIn(contents);
      return;
    }
    openBrowser(target.href);
  });
  contents.on('will-redirect', (event) => {
    if (!event.isMainFrame) return;
    const setup = contents === dashboardContents && is1904(contents.getURL()) && repositorySetupUrl(event.url, ORIGIN);
    if (setup) {
      event.preventDefault();
      openBrowser(setup.href);
      return;
    }
    if (is1904(event.url)) return;
    event.preventDefault();
    const target = webUrl(event.url);
    if (target && contents === dashboardContents && SOCIAL_AUTH.has(target.origin + target.pathname)) {
      void explainSocialSignIn(contents);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (is1904(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, webPreferences: WINDOW_PREFERENCES },
      };
    }
    const target = webUrl(url);
    if (contents === dashboardContents && target && SOCIAL_AUTH.has(target.origin + target.pathname)) {
      void explainSocialSignIn(contents);
    } else if (is1904(contents.getURL())) openBrowser(url);
    return { action: 'deny' };
  });
}

function installPermissionRules() {
  const profile = session.fromPartition(PARTITION);
  profile.webRequest.onBeforeRequest({ urls: [`${ORIGIN}/login*`] }, (details, callback) => {
    const url = new URL(details.url);
    if (details.resourceType === 'mainFrame' && details.method === 'GET' &&
        url.pathname === '/login' && !url.searchParams.has('returnTo')) {
      url.searchParams.set('returnTo', loginReturnTo);
      callback({ redirectURL: url.href });
    } else {
      callback({});
    }
  });
  profile.webRequest.onHeadersReceived({ urls: [`${ORIGIN}/*`], types: ['mainFrame'] }, (details, callback) => {
    if (details.webContentsId === dashboardContents?.id) {
      const challenged = Object.keys(details.responseHeaders ?? {}).some(name => name.toLowerCase() === 'cf-mitigated');
      challengeUrl = challenged ? details.url : undefined;
    }
    callback({});
  });
  const ordinaryPermissions = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications']);
  profile.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (!is1904(contents?.getURL()) || !is1904(origin) || !details.isMainFrame) return false;
    return ordinaryPermissions.has(permission) || (permission === 'media' && details.mediaType === 'audio');
  });
  profile.setPermissionRequestHandler((contents, permission, callback, details) => {
    const trusted = is1904(contents?.getURL()) && is1904(details.requestingUrl) && details.isMainFrame;
    const audioOnly = permission === 'media' && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio';
    callback(Boolean(trusted && (ordinaryPermissions.has(permission) || audioOnly)));
  });
}

function activeTheme() {
  return dashboardTheme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
}

function syncTitleBar() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const theme = activeTheme();
  const palette = PALETTE[theme];
  mainWindow.setBackgroundColor(palette.color);
  if (process.platform !== 'darwin') mainWindow.setTitleBarOverlay({ ...palette, height: CHROME_HEIGHT });
  mainWindow.webContents.send('1904:chrome-theme', theme);
  mainWindow.webContents.send('1904:chrome-task-title-bar', taskTitleBar);
}

function isTaskTitleBarPage(href) {
  const url = webUrl(href);
  return url?.origin === ORIGIN && ['/agents', '/agents-beta2'].includes(url.pathname);
}

function isTaskTitleBarSender(event) {
  return mainWindow && event.sender === dashboardContents && event.senderFrame === event.sender.mainFrame &&
    isTaskTitleBarPage(event.senderFrame?.url);
}

function setTaskTitleBar(active) {
  if (!mainWindow || mainWindow.isDestroyed() || taskTitleBar === active) return;
  taskTitleBar = active;
  mainWindow.webContents.send('1904:chrome-task-title-bar', active);
  sizeDashboard();
}

function sizeDashboard() {
  const [width, height] = mainWindow.getContentSize();
  const y = taskTitleBar ? 0 : CHROME_HEIGHT;
  dashboardView.setBounds({ x: 0, y, width, height: Math.max(0, height - y) });
}

function installChromeHandlers() {
  nativeTheme.on('updated', syncTitleBar);
  ipcMain.on('1904:dashboard-theme', (event, theme) => {
    if (event.sender !== dashboardContents || event.senderFrame !== event.sender.mainFrame ||
        !is1904(event.senderFrame?.url) || ![null, 'dark', 'light'].includes(theme)) return;
    dashboardTheme = theme;
    syncTitleBar();
  });
  ipcMain.on('1904:show-menu', (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) return;
    Menu.getApplicationMenu()?.popup({ window: mainWindow });
  });
  ipcMain.on('1904:task-title-bar', (event, active) => {
    if (isTaskTitleBarSender(event) && typeof active === 'boolean') setTaskTitleBar(active);
  });
  ipcMain.on('1904:task-title-bar-menu', (event) => {
    if (!taskTitleBar || !isTaskTitleBarSender(event)) return;
    Menu.getApplicationMenu()?.popup({ window: mainWindow, x: process.platform === 'darwin' ? 82 : 12, y: CHROME_HEIGHT });
  });
  ipcMain.handle('1904:task-notification', (event, item) => {
    if (event.sender !== dashboardContents || event.senderFrame !== event.sender.mainFrame ||
        !is1904(event.senderFrame?.url) || !Notification.isSupported()) return false;
    const target = taskUrl(item?.href, ORIGIN);
    if (!target || typeof item?.id !== 'string' || !/^[a-z0-9:_-]{1,128}$/i.test(item.id) ||
        !['task_needs_you', 'task_ready'].includes(item.kind)) return false;
    if (notified.has(item.id)) return true;
    notified.add(item.id);
    if (notified.size > 1024) notified.delete(notified.values().next().value);
    const notice = new Notification({
      title: item.kind === 'task_needs_you' ? 'A task needs your input' : 'A task is ready for review',
      body: 'Open 1904 Desktop to view the task.',
      timeoutType: item.kind === 'task_needs_you' ? 'never' : 'default',
    });
    notices.set(item.id, notice);
    notice.once('click', () => openTask(target.href));
    notice.once('close', () => notices.delete(item.id));
    notice.once('failed', () => { notices.delete(item.id); console.warn('1904 Desktop could not display a task notification.'); });
    notice.show();
    return true;
  });
  ipcMain.on('1904:recovery-retry', (event) => {
    if (mainWindow && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame) retryNow();
  });
  powerMonitor.on('resume', () => {
    if (recovery) { if (recovery.kind !== 'crashed') retryNow(); }
    else if (is1904(dashboardContents?.getURL())) dashboardContents.send('1904:resume');
  });
}

function createWindow() {
  const mac = process.platform === 'darwin';
  const palette = PALETTE[activeTheme()];
  const stateFile = path.join(app.getPath('userData'), 'window-state.json');
  const saved = readState(stateFile);
  const bounds = windowOptions(saved.bounds, screen.getAllDisplays(), screen.getPrimaryDisplay(), { width: 640, height: 500 });
  const win = new BrowserWindow({
    title: '1904 Desktop', icon: ICON,
    ...bounds,
    backgroundColor: palette.color,
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    ...(mac ? { trafficLightPosition: { x: 14, y: 15 } } : {
      titleBarOverlay: { ...palette, height: CHROME_HEIGHT }, autoHideMenuBar: true,
    }),
    webPreferences: { ...SAFE_PREFERENCES, preload: path.join(__dirname, 'chrome-preload.cjs') },
  });
  mainWindow = win;
  const view = new WebContentsView({
    webPreferences: { ...WINDOW_PREFERENCES, preload: path.join(__dirname, 'dashboard-preload.cjs') },
  });
  dashboardView = view;
  const contents = view.webContents;
  dashboardContents = contents;
  view.setBackgroundColor(palette.color);
  win.contentView.addChildView(view);
  win.on('resize', sizeDashboard);
  sizeDashboard();
  if (saved.maximized === true) win.maximize();
  win.on('close', () => saveState(stateFile, { bounds: win.getNormalBounds(), maximized: win.isMaximized() }));

  win.on('closed', () => {
    if (!contents.isDestroyed()) contents.close();
    if (mainWindow === win) {
      mainWindow = undefined;
      dashboardView = undefined;
      dashboardContents = undefined;
      dashboardTheme = undefined;
      taskTitleBar = false;
      clearTimeout(recovery?.timer);
      recovery = undefined;
    }
  });
  win.webContents.on('dom-ready', () => { syncTitleBar(); sendRecovery(); });
  void win.loadFile(path.join(__dirname, 'chrome.html'));

  contents.on('did-navigate', (_event, url, httpResponseCode) => {
    setTaskTitleBar(false);
    if (!is1904(url)) return;
    // Not emitted for Chromium's own error pages, so this is always a real answer from 1904.
    if (isServerFailure(httpResponseCode) && url !== challengeUrl) startRecovery('unavailable', url);
    else endRecovery();
  });
  contents.on('did-navigate-in-page', () => {
    if (!isTaskTitleBarPage(contents.getURL())) setTaskTitleBar(false);
  });
  contents.on('dom-ready', () => {
    if (is1904(contents.getURL())) void contents.insertCSS(DASHBOARD_CSS).catch(() => {});
    if (!recovery && win.isFocused()) contents.focus();
  });
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && is1904(url)) startRecovery(net.isOnline() ? 'unreachable' : 'offline', url);
  });
  contents.on('render-process-gone', (_event, details) => {
    if (contents.isDestroyed() || details.reason === 'clean-exit') return;
    const repeated = Date.now() - lastCrashAt < CRASH_WINDOW_MS;
    lastCrashAt = Date.now();
    // The first crash is reloaded without a word; only a page that keeps crashing is shown as broken.
    if (repeated) startRecovery('crashed', contents.getURL());
    else loadPage(contents, retryTarget(contents.getURL(), ORIGIN, fallbackUrl()));
  });
  const link = queuedLink;
  queuedLink = undefined;
  if (!handleLink(link)) loadPage(contents, AGENTS);
  return win;
}

function showDashboard() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

function showAbout() {
  const options = {
    type: 'info', title: 'About 1904 Desktop', message: '1904 Desktop',
    detail: `Version ${app.getVersion()}\n1904.ai`, buttons: ['OK'],
  };
  if (mainWindow && !mainWindow.isDestroyed()) void dialog.showMessageBox(mainWindow, options);
  else void dialog.showMessageBox(options);
}

function showReleaseNotes() {
  void dialog.showMessageBox(showDashboard(), {
    type: 'info', title: 'What’s New', message: `1904 Desktop ${app.getVersion()}`,
    detail: 'Open the title bar’s … menu and choose Help for version info, release notes, documentation, and support.',
    buttons: ['OK'],
  });
}

function installMenu(updates) {
  const mac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: '1904', submenu: [
      { label: 'Open Agents', accelerator: 'CmdOrCtrl+Shift+A', click: () => { loginReturnTo = '/agents'; showDashboard(); loadPage(dashboardContents, AGENTS); } },
      { label: 'Open Copied 1904 Link', accelerator: 'CmdOrCtrl+Shift+O', click: () => { showDashboard(); openCopiedLink(); } },
      { label: 'Sign In with Browser…', click: beginBrowserSignIn },
      { label: 'Open in Browser', click: () => openBrowser(AGENTS) },
      ...(mac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
    ] },
    { role: 'editMenu' },
    { label: 'View', submenu: [
      { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: (_item, win) => {
        const contents = win && win !== mainWindow ? win.webContents : dashboardContents;
        if (recovery && contents === dashboardContents) retryNow();
        else if (contents && is1904(contents.getURL())) contents.reload();
        else { showDashboard(); loadPage(dashboardContents, AGENTS); }
      } },
      { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => dashboardContents?.setZoomLevel(0) },
      { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => dashboardContents?.setZoomLevel(Math.min(3, dashboardContents.getZoomLevel() + 0.5)) },
      { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => dashboardContents?.setZoomLevel(Math.max(-2, dashboardContents.getZoomLevel() - 0.5)) },
      { role: 'togglefullscreen' },
    ] },
    { role: 'windowMenu' },
    { role: 'help', label: 'Help', submenu: [
      { label: 'About 1904 Desktop', click: showAbout },
      { label: 'What’s New', click: showReleaseNotes },
      ...(updates ? [
        { label: 'Check for Updates…', click: updates.check },
        { label: 'Restart to Update…', id: '1904-restart-update', visible: false, click: updates.install },
      ] : []),
      { type: 'separator' },
      { label: '1904 Website', click: () => openBrowser(`${ORIGIN}/`) },
      { label: 'Documentation', click: () => openBrowser(`${ORIGIN}/documentation`) },
      { label: 'Contact Support', click: () => openBrowser(`${ORIGIN}/contact`) },
      { label: 'Import repository…', click: openRepositoryImport },
    ] },
  ]));
}

app.setName('1904 Desktop');
if (process.platform === 'win32') app.setAppUserModelId('ai.1904.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (app.isPackaged) app.setAsDefaultProtocolClient(SCHEME);
  const fromArgs = args => args.map(value => readLink(value, ORIGIN)).find(Boolean);
  queuedLink = fromArgs(process.argv);
  app.on('web-contents-created', (_event, contents) => installNavigationRules(contents));
  app.on('open-url', (event, url) => { event.preventDefault(); handleLink(readLink(url, ORIGIN)); });
  app.on('second-instance', (_event, args) => { if (!handleLink(fromArgs(args)) && desktopReady) showDashboard(); });
  app.on('activate', () => { if (desktopReady) showDashboard(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  void app.whenReady().then(() => {
    installPermissionRules();
    installMenu(startUpdater(() => mainWindow, () => {
      const restart = Menu.getApplicationMenu()?.getMenuItemById('1904-restart-update');
      if (restart) restart.visible = true;
    }));
    installChromeHandlers();
    desktopReady = true;
    showDashboard();
  });
}
