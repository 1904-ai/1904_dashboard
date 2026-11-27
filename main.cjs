const { app, BrowserWindow, WebContentsView, clipboard, desktopCapturer, dialog, ipcMain, Menu, nativeImage, nativeTheme, net, Notification, powerMonitor, safeStorage, screen, session, shell, systemPreferences } = require('electron');
const { guardStartup, startSmokeReport } = require('./startup-guard.cjs');
// A packaged build started with a debugging switch exits here, before Chromium or Node.js can act on it.
guardStartup(app);
const { execFile, spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { existsSync, readFileSync, realpathSync } = require('node:fs');
const { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { startUpdater } = require('./updater.cjs');
const { SCHEME, IMPORT_PATH, taskUrl, repositorySetupUrl, readLink, startSignIn } = require('./desktop-links.cjs');
const { readState, saveState, windowOptions } = require('./desktop-state.cjs');
const {
  ACCOUNTS_FILE, DEFAULT_PARTITION, MAX_ACCOUNTS,
  accountLabel, createAccountStore, isAccountId, isEmptyPending,
} = require('./desktop-accounts.cjs');
const { CRASH_WINDOW_MS, retryDelay, isServerFailure, retryTarget, recoveryView } = require('./desktop-recovery.cjs');
const { installContextMenu } = require('./context-menu.cjs');
const { taskTabCommand } = require('./task-tab-keys.cjs');
const {
  TASK_NOTICE_DEFAULT_HEIGHT, TASK_NOTICE_HIDE_MS, TASK_NOTICE_WIDTH,
  createTaskNoticeController, normalizeTaskNotice, noticeBounds,
} = require('./task-notice.cjs');
const { installScreenCapture } = require('./screen-capture.cjs');
const { installSnippetCapture } = require('./snippet-capture.cjs');
const computerPolicy = require('./computer-policy.cjs');
const { connectPrompt, resumePrompt, createComputerLink, pairComputer } = require('./computer-link.cjs');
const { createDesktopBrowserBridge } = require('./browser-bridge.cjs');
const { createDeviceInfoReader } = require('./device-info.cjs');
const readDeviceInfo = createDeviceInfoReader();
const { createComputerBridge } = require('./computer-bridge.cjs');
const { createPromptAsk } = require('./computer-approval.cjs');
const computerProof = require('./computer-proof.cjs');
const { awayBudgetPrompt, awayConfirmPrompt, awayDurationPrompt, createAwayLeases } = require('./computer-away.cjs');
const { createActivityLog } = require('./computer-log.cjs');
const computerDeploy = require('./computer-deploy.cjs');
const deploySsh = require('./computer-deploy-ssh.cjs');

const ORIGIN = 'https://1904.ai';
const AGENTS = `${ORIGIN}/agents`;
const PARTITION = DEFAULT_PARTITION;
const ICON = path.join(__dirname, 'assets', 'icon.png');
const CHROME_HEIGHT = 44;
const PALETTE = {
  dark: { color: '#121416', symbolColor: '#e2e7ec' },
  light: { color: '#f6f8fa', symbolColor: '#20262d' },
};
const DASHBOARD_CSS = readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
const ACTIVITY_PAGE = path.join(__dirname, 'activity.html');
const APPROVAL_PAGE = path.join(__dirname, 'approval.html');
const DEPLOY_PAGE = path.join(__dirname, 'deploy.html');
const SECRET_PAGE = path.join(__dirname, 'secret.html');
const TASK_NOTICE_PAGE = path.join(__dirname, 'task-notice.html');
// The prompt takes no Run until it has been in front this long, and opens only after a pause in the
// person's typing and clicking in the dashboard (or after the longest wait), so no key press or click
// meant for something else can answer it.
const APPROVAL_ARM_MS = 900;
const APPROVAL_QUIET_MS = 1500;
const APPROVAL_QUIET_MAX_MS = 15_000;
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
let accountStore;
const configuredPartitions = new Set();
const partitionByContents = new WeakMap();
let taskTitleBar = false;
// Set by the Agents page while a task's tab strip is on screen: Ctrl/Cmd+T, Ctrl/Cmd+W and Ctrl+Tab then
// drive its tabs. Off, every key does what it always did, so Ctrl/Cmd+W closes the window.
let taskTabKeys = false;
// Set by the loaded 1904 dashboard once it can switch tasks in-place without a full page reload.
let taskNavigationReady = false;
let taskNoticeWindow;
let taskNoticeLoaded;
let taskNoticeHideTimer;
let taskNoticeHeight = TASK_NOTICE_DEFAULT_HEIGHT;
let taskNoticeController;
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
let menuUpdates;
let updateReady = false;
// Use My Computer (see the section below main's window code).
let computerLink;
let computerBridge;
let desktopBrowserBridge;
let computerConnecting;
let computerResuming;
let computerQuitting = false;
let computerMenuKey;
let activityWindow;
let deployWindow;
let deployRecipes;
let deployApps = new Map();
let deployMessage;
let deployFocusedAt = 0;
let deploySecrets;
let secretWindow;
let secretPending;
/** Save, Run now and Remove take no click until the deploy window has been in front this long, like the prompt's Run. */
const DEPLOY_ARM_MS = 800;
// The prompt window, and the request it is asking about: { nonce, resolve, shownAt, focusedAt }.
let approvalWindow;
let approvalPending;
let approvalIconUrl;
let approvalLoaded;
let activityStateTimer;
let activityStateDirty = false;
let activityOutputTimer;
let activityOutputSeq = 0;
const activityOutput = [];
const computerNotices = new Set();
let computerMessages;
let computerLog;
// webRequest id → the proof header for a message the dashboard is sending (see stampMessage).
const pendingProofs = new Map();
// The person's last real key press or click in the dashboard window: a message is stamped only right after one.
const computerInput = computerProof.createInputTracker();

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
    taskTabKeys = false;
    taskNavigationReady = false;
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
  const relative = task.pathname + task.search;
  loginReturnTo = relative;
  const existingWindow = Boolean(mainWindow && !mainWindow.isDestroyed());
  showDashboard();
  if (existingWindow && !recovery && taskNavigationReady &&
      dashboardContents && !dashboardContents.isDestroyed() && is1904(dashboardContents.getURL())) {
    dashboardContents.send('1904:open-task', relative);
    return;
  }
  loadPage(dashboardContents, task.href);
}

function openRepositoryImport() {
  loginReturnTo = IMPORT_PATH;
  showDashboard();
  loadPage(dashboardContents, ORIGIN + IMPORT_PATH);
}

function activePartition() {
  return accountStore ? accountStore.active().partition : PARTITION;
}

function windowPreferencesFor(partition = activePartition()) {
  return { ...SAFE_PREFERENCES, partition };
}

function clearPartitions(partitions) {
  for (const partition of partitions || []) {
    try {
      void session.fromPartition(partition).clearStorageData().catch(() => {});
    } catch { /* ignore invalid partition */ }
  }
}

function beginBrowserSignIn() {
  const accounts = accountStore?.snapshot().accounts ?? [];
  const addAccount = accounts.length > 1 || isEmptyPending(accountStore?.active());
  signInAttempt = { ...startSignIn(ORIGIN, { addAccount }), returnTo: loginReturnTo, accountId: accountStore?.active().id };
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
  // Always exchange inside the exact account slot that initiated browser sign-in.
  if (attempt.accountId && accountStore && accountStore.active().id !== attempt.accountId && accountStore.get(attempt.accountId)) {
    switchAccount(attempt.accountId, { load: false });
  }
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

// The main-process clipboard is asynchronous since Electron 45. Never rejects, so callers needn't wait.
async function openCopiedLink() {
  const copied = await Promise.resolve().then(() => clipboard.readText()).catch(() => '');
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const url = webUrl(String(copied ?? '').trim());
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
      const partition = partitionByContents.get(contents) || activePartition();
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, icon: ICON, webPreferences: windowPreferencesFor(partition) },
      };
    }
    const target = webUrl(url);
    if (contents === dashboardContents && target && SOCIAL_AUTH.has(target.origin + target.pathname)) {
      void explainSocialSignIn(contents);
    } else if (is1904(contents.getURL())) openBrowser(url);
    return { action: 'deny' };
  });
}

// Use My Computer, the origin rule: a request reaching the dashboard's own session from its own main frame.
function fromDashboard(details) {
  const frame = details.frame;
  const main = dashboardContents?.mainFrame;
  // Without a frame it cannot be shown to come from the dashboard's main frame: no. Only the agents
  // dashboard sends task messages, so no other 1904 page can get one stamped.
  return Boolean(dashboardContents) && !dashboardContents.isDestroyed() && details.webContentsId === dashboardContents.id &&
    isTaskTitleBarPage(dashboardContents.getURL()) && details.initiatorOrigin === ORIGIN &&
    Boolean(frame && main && frame.processId === main.processId && frame.routingId === main.routingId);
}

// A message the person sends from this window gets a proof only this process can make. The proof
// covers the exact bytes sent; the header is added in onBeforeSendHeaders, after the page let go.
async function stampMessage(profile, details) {
  const linkInfo = computerLink?.info();
  if (!linkInfo || !computerProof.stampableRequest({ method: details.method, url: details.url, origin: ORIGIN }) || !fromDashboard(details)) return;
  const activeEmail = accountStore?.active().email;
  if (linkInfo.account && activeEmail && linkInfo.account.toLowerCase() !== activeEmail.toLowerCase()) return;
  try {
    const body = await computerProof.uploadBody(details.uploadData, id => profile.getBlobData(id));
    const inBody = body && computerProof.messageInBody(body);
    const appId = computerProof.messageAppId(details.url);
    if (!inBody || !appId) return;
    const message = { ...inBody, appId };
    // A message the page sent with no key press or click just before is not the person's: it leaves unstamped.
    const decision = computerInput.decide({ focused: Boolean(mainWindow?.isFocused()) && dashboardContents.isFocused() });
    if (!decision.stamp) {
      computerLog?.note({ text: decision.reason, messageId: message.messageId, taskId: message.taskId });
      return;
    }
    const keys = await computerLink.proof();
    if (!keys) return;
    const now = Date.now();
    for (const [id, entry] of pendingProofs) if (now - entry.at > 60_000) pendingProofs.delete(id);
    pendingProofs.set(details.id, { header: computerProof.proofHeader({ ...keys, ms: now, body }), message, at: now });
  } catch {
    // An unstamped message simply cannot use this computer.
  }
}

function installPermissionRules(partition = activePartition()) {
  if (configuredPartitions.has(partition)) return;
  configuredPartitions.add(partition);
  const profile = session.fromPartition(partition);
  // One listener per event and session: the sign-in redirect and the message proof share it.
  profile.webRequest.onBeforeRequest({ urls: [`${ORIGIN}/login*`, `${ORIGIN}/api/apps/*`] }, (details, callback) => {
    const url = new URL(details.url);
    if (url.pathname.startsWith('/api/')) {
      void stampMessage(profile, details).finally(() => callback({}));
      return;
    }
    if (details.resourceType === 'mainFrame' && details.method === 'GET' &&
        url.pathname === '/login' && !url.searchParams.has('returnTo')) {
      url.searchParams.set('returnTo', loginReturnTo);
      callback({ redirectURL: url.href });
    } else {
      callback({});
    }
  });
  // No page can send a proof of its own; only a message stamped above leaves with one.
  profile.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/*`] }, (details, callback) => {
    const requestHeaders = computerProof.withoutProof(details.requestHeaders);
    const proof = pendingProofs.get(details.id);
    pendingProofs.delete(details.id);
    if (proof && fromDashboard(details)) {
      requestHeaders[computerPolicy.COMPUTER_PROOF_HEADER] = proof.header;
      computerMessages?.record(proof.message.messageId, proof.message.taskId, proof.message.appId);
      // A new message from here ends "Allow for this message" for the task's earlier messages.
      computerBridge?.messageSent(proof.message.messageId, proof.message.taskId);
    }
    callback({ requestHeaders });
  });
  profile.webRequest.onHeadersReceived({ urls: [`${ORIGIN}/*`], types: ['mainFrame'] }, (details, callback) => {
    if (details.webContentsId === dashboardContents?.id) {
      const challenged = Object.keys(details.responseHeaders ?? {}).some(name => name.toLowerCase() === 'cf-mitigated');
      challengeUrl = challenged ? details.url : undefined;
    }
    callback({});
  });
  const ordinaryPermissions = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications']);
  const screenCaptureAllowed = installScreenCapture(profile, {
    getContents: () => dashboardContents, getWindow: () => mainWindow, desktopCapturer, Menu, is1904,
    onError: () => dialog.showErrorBox('Could not capture your screen',
      'Check screen recording permissions for 1904 Desktop in your system settings, then try again. You can also attach an image file.'),
  });
  profile.setPermissionCheckHandler((contents, permission, origin, details) => {
    if (permission === 'display-capture') return screenCaptureAllowed(contents, origin, details.isMainFrame);
    if (!is1904(contents?.getURL()) || !is1904(origin) || !details.isMainFrame) return false;
    return ordinaryPermissions.has(permission) || (permission === 'media' && details.mediaType === 'audio');
  });
  profile.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'display-capture') {
      callback(screenCaptureAllowed(contents, details.requestingUrl, details.isMainFrame));
      return;
    }
    const trusted = is1904(contents?.getURL()) && is1904(details.requestingUrl) && details.isMainFrame;
    const audioOnly = permission === 'media' && details.mediaTypes?.length === 1 && details.mediaTypes[0] === 'audio';
    callback(Boolean(trusted && (ordinaryPermissions.has(permission) || audioOnly)));
  });
}

function activeTheme() {
  return dashboardTheme ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
}

function syncTitleBar() {
  const theme = activeTheme();
  const palette = PALETTE[theme];
  if (activityWindow && !activityWindow.isDestroyed()) {
    activityWindow.setBackgroundColor(palette.color);
    activityWindow.webContents.send('1904:activity-theme', theme);
  }
  if (deployWindow && !deployWindow.isDestroyed()) {
    deployWindow.webContents.send('1904:deploy-theme', theme);
  }
  if (approvalWindow && !approvalWindow.isDestroyed()) {
    approvalWindow.setBackgroundColor(palette.color);
    if (process.platform !== 'darwin') approvalWindow.setTitleBarOverlay({ ...palette, height: 40 });
    approvalWindow.webContents.send('1904:approval-theme', theme);
  }
  if (taskNoticeWindow && !taskNoticeWindow.isDestroyed()) {
    taskNoticeWindow.webContents.send('1904:task-notice-theme', theme);
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(palette.color);
  if (process.platform !== 'darwin') mainWindow.setTitleBarOverlay({ ...palette, height: CHROME_HEIGHT });
  mainWindow.webContents.send('1904:chrome-theme', theme);
  mainWindow.webContents.send('1904:chrome-task-title-bar', taskTitleBar);
}

// ── Windows bottom-right task notification drawer ─────────────────────────
// Replaces native Windows toast notifications for task alerts so Close only
// closes the popup, Open Task switches smoothly in-app, and alerts auto-dismiss.

function isTaskNoticePage(url) {
  try {
    const file = fileURLToPath(url);
    return process.platform === 'win32' ? file.toLowerCase() === TASK_NOTICE_PAGE.toLowerCase() : file === TASK_NOTICE_PAGE;
  } catch {
    return false;
  }
}

function isTaskNoticeSender(event) {
  return Boolean(taskNoticeWindow) && !taskNoticeWindow.isDestroyed() && event.sender === taskNoticeWindow.webContents &&
    event.senderFrame === event.sender.mainFrame && isTaskNoticePage(event.senderFrame?.url);
}

function taskNoticeDisplay() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { return screen.getDisplayMatching(mainWindow.getBounds()); } catch { /* fall back to primary */ }
  }
  return screen.getPrimaryDisplay();
}

function positionTaskNoticeWindow(height = taskNoticeHeight) {
  if (!taskNoticeWindow || taskNoticeWindow.isDestroyed()) return;
  const bounds = noticeBounds(taskNoticeDisplay().workArea, TASK_NOTICE_WIDTH, height);
  taskNoticeHeight = bounds.height;
  taskNoticeWindow.setBounds(bounds, false);
}

function taskNoticeWindowNow() {
  if (taskNoticeWindow && !taskNoticeWindow.isDestroyed()) return taskNoticeWindow;
  const bounds = noticeBounds(taskNoticeDisplay().workArea, TASK_NOTICE_WIDTH, taskNoticeHeight);
  const win = new BrowserWindow({
    title: '1904 Notification',
    ...bounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: { ...SAFE_PREFERENCES, preload: path.join(__dirname, 'task-notice-preload.cjs') },
  });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  taskNoticeWindow = win;
  win.on('closed', () => {
    if (taskNoticeWindow === win) {
      taskNoticeWindow = undefined;
      taskNoticeLoaded = undefined;
    }
  });
  taskNoticeLoaded = win.loadFile(TASK_NOTICE_PAGE).then(() => true, () => false);
  return win;
}

function closeTaskNoticeWindow() {
  clearTimeout(taskNoticeHideTimer);
  taskNoticeHideTimer = undefined;
  taskNoticeController?.dispose();
  taskNoticeController = undefined;
  if (taskNoticeWindow && !taskNoticeWindow.isDestroyed()) taskNoticeWindow.destroy();
  taskNoticeWindow = undefined;
  taskNoticeLoaded = undefined;
}

function ensureTaskNoticeController() {
  taskNoticeController ??= createTaskNoticeController({
    createNonce: () => randomUUID(),
    onShow: payload => {
      void (async () => {
        clearTimeout(taskNoticeHideTimer);
        taskNoticeHideTimer = undefined;
        const win = taskNoticeWindowNow();
        if (!(await taskNoticeLoaded) || win.isDestroyed()) return;
        if (taskNoticeController?.active()?.nonce !== payload.nonce) return;
        positionTaskNoticeWindow(taskNoticeHeight);
        win.webContents.send('1904:task-notice-show', {
          ...payload,
          theme: activeTheme(),
          icon: approvalIcon(),
        });
        win.showInactive();
      })().catch(() => {});
    },
    onHide: payload => {
      clearTimeout(taskNoticeHideTimer);
      taskNoticeHideTimer = undefined;
      if (!taskNoticeWindow || taskNoticeWindow.isDestroyed()) return;
      taskNoticeWindow.webContents.send('1904:task-notice-hide', payload);
      const win = taskNoticeWindow;
      taskNoticeHideTimer = setTimeout(() => {
        taskNoticeHideTimer = undefined;
        if (!win.isDestroyed() && !taskNoticeController?.active()) win.hide();
      }, TASK_NOTICE_HIDE_MS);
    },
    onTimer: payload => {
      if (taskNoticeWindow && !taskNoticeWindow.isDestroyed()) {
        taskNoticeWindow.webContents.send('1904:task-notice-timer', payload);
      }
    },
    onOpen: notice => {
      openTask(notice.href);
    },
  });
  return taskNoticeController;
}

function isTaskTitleBarPage(href) {
  const url = webUrl(href);
  return url?.origin === ORIGIN && ['/agents', '/agents-beta2'].includes(url.pathname);
}

// Settings overlays the mounted Agents page. Only its title bar may remain active there; task keys and
// computer access keep their existing, narrower route checks.
function isTaskTitleBarHost(href) {
  const url = webUrl(href);
  return isTaskTitleBarPage(href) || (url?.origin === ORIGIN &&
    (url.pathname === '/settings' || url.pathname.startsWith('/settings/')));
}

function isTaskTitleBarSender(event) {
  return mainWindow && event.sender === dashboardContents && event.senderFrame === event.sender.mainFrame &&
    isTaskTitleBarHost(event.senderFrame?.url);
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
  ipcMain.on('1904:task-tab-keys', (event, active) => {
    if (isTaskTitleBarSender(event) && isTaskTitleBarPage(event.senderFrame?.url) && typeof active === 'boolean') taskTabKeys = active;
  });
  ipcMain.on('1904:task-title-bar-menu', (event) => {
    if (!taskTitleBar || !isTaskTitleBarSender(event)) return;
    Menu.getApplicationMenu()?.popup({ window: mainWindow, x: process.platform === 'darwin' ? 82 : 12, y: CHROME_HEIGHT });
  });
  ipcMain.on('1904:task-navigation-ready', (event, ready) => {
    if (event.sender === dashboardContents && event.senderFrame === event.sender.mainFrame &&
        is1904(event.senderFrame?.url) && typeof ready === 'boolean') {
      taskNavigationReady = ready;
    }
  });
  ipcMain.on('1904:task-notice-action', (event, payload) => {
    if (!isTaskNoticeSender(event)) return;
    taskNoticeController?.act(payload?.nonce, payload?.action);
  });
  ipcMain.on('1904:task-notice-hover', (event, payload) => {
    if (!isTaskNoticeSender(event)) return;
    taskNoticeController?.setHovered(payload?.nonce, payload?.hovered);
  });
  ipcMain.on('1904:task-notice-size', (event, height) => {
    if (!isTaskNoticeSender(event) || !Number.isFinite(height)) return;
    positionTaskNoticeWindow(height);
  });
  ipcMain.handle('1904:task-notification', (event, item) => {
    if (event.sender !== dashboardContents || event.senderFrame !== event.sender.mainFrame ||
        !is1904(event.senderFrame?.url)) return false;
    const normalized = normalizeTaskNotice(item, ORIGIN);
    if (!normalized) return false;
    if (process.platform === 'win32') {
      return ensureTaskNoticeController().enqueue(normalized);
    }
    if (!Notification.isSupported()) return false;
    if (notified.has(normalized.id)) return true;
    notified.add(normalized.id);
    if (notified.size > 1024) notified.delete(notified.values().next().value);
    const notice = new Notification({
      title: normalized.title,
      body: normalized.body,
      timeoutType: 'default',
    });
    notices.set(normalized.id, notice);
    notice.once('click', () => openTask(normalized.href));
    notice.once('close', () => notices.delete(normalized.id));
    notice.once('failed', () => { notices.delete(normalized.id); console.warn('1904 Desktop could not display a task notification.'); });
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

function mountDashboardView(win, initialUrl) {
  if (!win || win.isDestroyed()) return null;
  const previousView = dashboardView;
  const previousContents = dashboardContents;
  if (previousView) {
    setTaskTitleBar(false);
    taskTabKeys = false;
    taskNavigationReady = false;
    dashboardTheme = undefined;
    challengeUrl = undefined;
    clearTimeout(recovery?.timer);
    recovery = undefined;
    sendRecovery();
    computerInput.reset();
    closeTaskNoticeWindow();
    for (const notice of notices.values()) { try { notice.close(); } catch { /* ignore */ } }
    notices.clear();
    notified.clear();
    desktopBrowserBridge?.resetLease();
    try { win.contentView.removeChildView(previousView); } catch { /* ignore */ }
    if (previousContents && !previousContents.isDestroyed()) {
      previousContents.removeAllListeners();
      previousContents.close();
    }
  }
  const partition = activePartition();
  installPermissionRules(partition);
  const palette = PALETTE[activeTheme()];
  const view = new WebContentsView({
    webPreferences: { ...windowPreferencesFor(partition), preload: path.join(__dirname, 'dashboard-preload.cjs') },
  });
  dashboardView = view;
  const contents = view.webContents;
  dashboardContents = contents;
  partitionByContents.set(contents, partition);
  // Real input reaches these from the operating system; events a page dispatches itself never do.
  contents.on('before-input-event', (_event, input) => computerInput.key(input));
  // Only while the Agents page has said a task's tabs are on screen; otherwise nothing is held back here.
  contents.on('before-input-event', (event, input) => {
    if (!taskTabKeys || !isTaskTitleBarPage(contents.getURL())) return;
    const command = taskTabCommand(input, process.platform);
    if (!command) return;
    // Also keeps the key from the menu, so Ctrl/Cmd+W closes the task's tab and not the window.
    event.preventDefault();
    contents.send('1904:task-tab-command', command);
  });
  contents.on('input-event', (_event, input) => computerInput.pointer(input));
  // A click that loaded a new page does not count as input on that page.
  contents.on('did-start-navigation', (details, _url, isInPlace, isMainFrame) => {
    if ((details?.isMainFrame ?? isMainFrame) && !(details?.isSameDocument ?? isInPlace)) computerInput.reset();
  });
  view.setBackgroundColor(palette.color);
  win.contentView.addChildView(view);
  sizeDashboard();
  syncTitleBar();

  contents.on('did-navigate', (_event, url, httpResponseCode) => {
    setTaskTitleBar(false);
    taskTabKeys = false;
    taskNavigationReady = false;
    if (!is1904(url)) return;
    // Not emitted for Chromium's own error pages, so this is always a real answer from 1904.
    if (isServerFailure(httpResponseCode) && url !== challengeUrl) startRecovery('unavailable', url);
    else endRecovery();
  });
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (!isMainFrame) return;
    const href = contents.getURL();
    if (!isTaskTitleBarPage(href)) taskTabKeys = false;
    if (!isTaskTitleBarHost(href)) setTaskTitleBar(false);
    // Keep the view at the same bounds through Settings; replay also supports older dashboard versions
    // that release their header while the overlay is open, and restores task keys on return to Agents.
    else contents.send('1904:task-title-bar-replay');
  });
  contents.on('dom-ready', () => {
    if (contents !== dashboardContents) return;
    if (is1904(contents.getURL())) void contents.insertCSS(DASHBOARD_CSS).catch(() => {});
    if (!recovery && win.isFocused()) contents.focus();
  });
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (contents === dashboardContents && isMainFrame && code !== -3 && is1904(url)) startRecovery(net.isOnline() ? 'unreachable' : 'offline', url);
  });
  contents.on('render-process-gone', (_event, details) => {
    if (contents !== dashboardContents || contents.isDestroyed() || details.reason === 'clean-exit') return;
    const repeated = Date.now() - lastCrashAt < CRASH_WINDOW_MS;
    lastCrashAt = Date.now();
    // The first crash is reloaded without a word; only a page that keeps crashing is shown as broken.
    if (repeated) startRecovery('crashed', contents.getURL());
    else loadPage(contents, retryTarget(contents.getURL(), ORIGIN, fallbackUrl()));
  });
  if (initialUrl) loadPage(contents, initialUrl);
  return contents;
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
  win.on('resize', sizeDashboard);
  if (saved.maximized === true) win.maximize();
  win.on('close', () => saveState(stateFile, { bounds: win.getNormalBounds(), maximized: win.isMaximized() }));

  win.on('closed', () => {
    if (dashboardContents && !dashboardContents.isDestroyed()) dashboardContents.close();
    if (mainWindow === win) {
      mainWindow = undefined;
      dashboardView = undefined;
      dashboardContents = undefined;
      dashboardTheme = undefined;
      taskTitleBar = false;
      taskTabKeys = false;
      taskNavigationReady = false;
      closeTaskNoticeWindow();
      clearTimeout(recovery?.timer);
      recovery = undefined;
    }
  });
  win.webContents.on('dom-ready', () => { syncTitleBar(); sendRecovery(); sendComputerIndicator(); sendAccountsToChrome(); });
  void win.loadFile(path.join(__dirname, 'chrome.html'));

  const contents = mountDashboardView(win, null);
  const link = queuedLink;
  queuedLink = undefined;
  const active = accountStore?.active();
  const initialTarget = isEmptyPending(active) ? `${ORIGIN}/login?returnTo=%2Fagents` : AGENTS;
  if (!handleLink(link)) loadPage(contents, initialTarget);
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

function computerMenu() {
  if (!computerBridge) return [];
  const info = computerLink.info();
  // A Windows menu label treats & as a shortcut marker.
  const menuText = text => process.platform === 'win32' ? String(text).replace(/&/g, '&&') : String(text);
  const paused = computerLink.paused();
  return [
    { type: 'separator' },
    info
      ? { label: 'Use My Computer', submenu: [
        { label: `Connected as ${menuText(info.name)}`, enabled: false },
        ...(info.account ? [{ label: `1904 account: ${menuText(info.account)}`, enabled: false }] : []),
        { type: 'separator' },
        { label: paused ? 'Resume Use My Computer' : 'Pause Use My Computer', click: () => setComputerPaused(!paused) },
        ...computerBridge.away().map(lease => ({
          label: `End Away Mode for ${menuText(computerPolicy.label(lease.taskTitle, 40))}`, click: () => computerBridge.endAway(lease.id),
        })),
        ...computerBridge.taskAllowances().map(entry => ({
          label: `Stop Allowing ${menuText(computerPolicy.label(entry.taskTitle, 40))}`, click: () => computerBridge.endTaskAllowance(entry.taskId),
        })),
        { type: 'separator' },
        { label: 'Disconnect This Computer…', click: () => { void disconnectComputer(); } },
      ] }
      : { label: 'Use My Computer…', click: () => { void connectComputer(); } },
    { label: 'Computer Activity', click: () => showActivity() },
    { label: 'Deploy From This Computer…', click: () => showDeploys() },
  ];
}

function menuEscape(text) {
  return process.platform === 'win32' ? String(text).replace(/&/g, '&&') : String(text);
}

function sendAccountsToChrome() {
  if (accountStore && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('1904:chrome-accounts', accountStore.snapshot());
  }
}

function broadcastAccounts() {
  if (!accountStore) return;
  const snapshot = accountStore.snapshot();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('1904:chrome-accounts', snapshot);
  if (dashboardContents && !dashboardContents.isDestroyed()) dashboardContents.send('1904:accounts-changed', snapshot);
  installMenu();
}

function switchAccount(id, { url = AGENTS, load = true } = {}) {
  if (!accountStore) return null;
  const result = accountStore.switchTo(id);
  if (!result.ok) return accountStore.snapshot();
  clearPartitions(result.removedPartitions);
  const win = showDashboard();
  if (result.changed) {
    loginReturnTo = '/agents';
    mountDashboardView(win, load ? (result.account.signedIn ? url : `${ORIGIN}/login?returnTo=%2Fagents`) : null);
  } else if (load && dashboardContents && !dashboardContents.isDestroyed()) {
    dashboardContents.focus();
  }
  broadcastAccounts();
  return accountStore.snapshot();
}

function addAccount() {
  if (!accountStore) return null;
  const result = accountStore.beginAdd();
  if (!result.ok) {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    void messageBox({
      type: 'info',
      title: '1904 Accounts',
      message: `Up to ${MAX_ACCOUNTS} accounts can be added`,
      detail: 'Remove an unused account from 1904 Desktop before adding another one.',
      buttons: ['OK'],
    }, parent);
    return accountStore.snapshot();
  }
  const win = showDashboard();
  loginReturnTo = '/agents';
  mountDashboardView(win, `${ORIGIN}/login?returnTo=%2Fagents`);
  broadcastAccounts();
  return accountStore.snapshot();
}

async function removeAccount(id, { confirm = true } = {}) {
  if (!accountStore) return null;
  const target = accountStore.get(id);
  if (!target) return accountStore.snapshot();
  if (confirm) {
    const label = target.email ? `${accountLabel(target)} (${target.email})` : accountLabel(target);
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const { response } = await messageBox({
      type: 'question',
      title: 'Remove 1904 Account',
      message: `Remove ${label} from 1904 Desktop?`,
      detail: 'This signs the account out of 1904 Desktop and clears its saved session on this computer. Your 1904 account and workspaces are not deleted.',
      buttons: ['Cancel', 'Remove'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    }, parent);
    if (response !== 1) return accountStore.snapshot();
  }
  const result = accountStore.remove(id);
  if (!result.ok) return accountStore.snapshot();
  clearPartitions(result.removedPartitions);
  if (result.switched && mainWindow && !mainWindow.isDestroyed()) {
    loginReturnTo = '/agents';
    const nextUrl = result.active.signedIn ? AGENTS : `${ORIGIN}/login?returnTo=%2Fagents`;
    mountDashboardView(mainWindow, nextUrl);
  }
  broadcastAccounts();
  return accountStore.snapshot();
}

function accountMenuLabel(account) {
  const title = accountLabel(account);
  const parts = [];
  if (account.email && account.email !== title) parts.push(account.email);
  if (account.workspaceName && account.workspaceName !== title) parts.push(account.workspaceName);
  if (!account.signedIn && (account.email || account.userId)) parts.push('Signed out');
  return menuEscape(parts.length ? `${title} — ${parts.join(' · ')}` : title);
}

function accountsMenuItems() {
  if (!accountStore) return [];
  const snap = accountStore.snapshot();
  const saved = snap.accounts.filter(account => !isEmptyPending(account));
  const items = snap.accounts.map((account, index) => ({
    label: accountMenuLabel(account),
    type: 'radio',
    checked: account.active,
    accelerator: index < 8 ? `CmdOrCtrl+Alt+${index + 1}` : undefined,
    click: () => { switchAccount(account.id); },
  }));
  if (items.length) items.push({ type: 'separator' });
  items.push({
    label: 'Add Account…',
    enabled: snap.canAdd,
    click: () => { addAccount(); },
  });
  if (saved.length > 0) {
    items.push({
      label: 'Remove Account',
      submenu: saved.map(account => ({
        label: accountMenuLabel(account),
        click: () => { void removeAccount(account.id, { confirm: true }); },
      })),
    });
  }
  return items;
}

function showAccountMenu(coords) {
  if (!mainWindow || mainWindow.isDestroyed() || !accountStore) return;
  const menu = Menu.buildFromTemplate(accountsMenuItems());
  const options = { window: mainWindow };
  if (Number.isFinite(coords?.x) && Number.isFinite(coords?.y)) {
    options.x = Math.max(0, Math.round(coords.x));
    options.y = Math.max(0, Math.round(coords.y));
  }
  menu.popup(options);
}

function isDashboardAccountSender(event) {
  return Boolean(dashboardContents) && !dashboardContents.isDestroyed() &&
    event.sender === dashboardContents && event.senderFrame === event.sender.mainFrame &&
    is1904(event.senderFrame?.url);
}

function installAccountHandlers() {
  ipcMain.handle('1904:accounts-state', event => (isDashboardAccountSender(event) && accountStore ? accountStore.snapshot() : null));
  ipcMain.handle('1904:accounts-sync', (event, profile) => {
    if (!isDashboardAccountSender(event) || !accountStore) return null;
    const result = accountStore.syncActive(profile);
    if (result.removedPartitions.length) clearPartitions(result.removedPartitions);
    if (result.deduplicated && mainWindow && !mainWindow.isDestroyed()) {
      mountDashboardView(mainWindow, AGENTS);
    }
    if (result.changed) broadcastAccounts();
    return accountStore.snapshot();
  });
  ipcMain.on('1904:accounts-signed-out', (event) => {
    if (!isDashboardAccountSender(event) || !accountStore) return;
    if (accountStore.markSignedOut().changed) broadcastAccounts();
  });
  ipcMain.handle('1904:accounts-switch', (event, id) => {
    if (!isDashboardAccountSender(event) || !accountStore || !isAccountId(id)) return null;
    if (!computerInput.decide({ focused: Boolean(mainWindow?.isFocused()) && Boolean(dashboardContents?.isFocused()) }).stamp) {
      return accountStore.snapshot();
    }
    return switchAccount(id);
  });
  ipcMain.handle('1904:accounts-add', (event) => {
    if (!isDashboardAccountSender(event) || !accountStore) return null;
    if (!computerInput.decide({ focused: Boolean(mainWindow?.isFocused()) && Boolean(dashboardContents?.isFocused()) }).stamp) {
      return accountStore.snapshot();
    }
    return addAccount();
  });
  ipcMain.handle('1904:accounts-remove', (event, id) => {
    if (!isDashboardAccountSender(event) || !accountStore || !isAccountId(id)) return null;
    if (!computerInput.decide({ focused: Boolean(mainWindow?.isFocused()) && Boolean(dashboardContents?.isFocused()) }).stamp) {
      return accountStore.snapshot();
    }
    return removeAccount(id, { confirm: true });
  });
  ipcMain.on('1904:chrome-account-menu', (event, coords) => {
    if (mainWindow && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame) {
      showAccountMenu(coords);
    }
  });
}

function installMenu() {
  const mac = process.platform === 'darwin';
  const updates = menuUpdates;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(mac ? [{ role: 'appMenu' }] : []),
    { label: '1904', submenu: [
      { label: 'Open Agents', accelerator: 'CmdOrCtrl+Shift+A', click: () => { loginReturnTo = '/agents'; showDashboard(); loadPage(dashboardContents, AGENTS); } },
      { label: 'Open Copied 1904 Link', accelerator: 'CmdOrCtrl+Shift+O', click: () => { showDashboard(); openCopiedLink(); } },
      ...(accountStore ? [{ label: 'Accounts', submenu: accountsMenuItems() }] : []),
      { label: 'Sign In with Browser…', click: beginBrowserSignIn },
      { label: 'Open in Browser', click: () => openBrowser(AGENTS) },
      ...computerMenu(),
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
        { label: 'Restart to Update…', id: '1904-restart-update', visible: updateReady, click: updates.install },
      ] : []),
      { type: 'separator' },
      { label: '1904 Website', click: () => openBrowser(`${ORIGIN}/`) },
      { label: 'Documentation', click: () => openBrowser(`${ORIGIN}/documentation`) },
      { label: 'Contact Support', click: () => openBrowser(`${ORIGIN}/contact`) },
      { label: 'Import repository…', click: openRepositoryImport },
    ] },
  ]));
}

// ── Use My Computer ────────────────────────────────────────────────────────
// A task's agent can ask to run a command on this computer. Once the person connects the
// computer, this main process polls 1904 for those requests, answers only those for messages
// this window sent (or inside away mode started here), asks the person natively, runs what they
// approve in the sandbox, shows it in Computer Activity and sends the output back. The dashboard
// page can only read whether this computer is connected and start connecting it or start away
// mode (the person confirms each); it can never run, approve or read anything. The token and the
// proof key never leave this process.

function computerPlatform() {
  return computerPolicy.computerPlatform(process.platform);
}

function computerState() {
  const info = computerLink?.info();
  return info
    ? { connected: true, id: info.id, name: info.name, platform: computerPlatform(), paused: computerLink.paused() }
    : { connected: false, paused: false };
}

// Why a folder cannot be an app's folder here, for a new choice and for every saved one read back.
function computerFolderProblem(folder) {
  return computerPolicy.folderChoiceProblem(folder, {
    platform: computerPlatform(), home: os.homedir(), userData: app.getPath('userData'), realpath: realpathSync,
  });
}

// The person's git name and email, read once outside the sandbox (which cannot read ~/.gitconfig), for the
// minimal git config each sandboxed run gets. Never /usr/bin/git: without the developer tools it opens an
// install dialog. cwd '/' keeps any repository's own settings out of it.
let gitIdentityRead;
function gitIdentity() {
  if (process.platform !== 'darwin') return Promise.resolve({});
  gitIdentityRead ??= (async () => {
    const git = ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/Library/Developer/CommandLineTools/usr/bin/git',
      '/Applications/Xcode.app/Contents/Developer/usr/bin/git'].find(file => existsSync(file));
    if (!git) return {};
    const get = key => new Promise(resolve => execFile(git, ['config', '--global', '--get', key],
      { cwd: '/', env: { HOME: os.homedir(), PATH: '/usr/bin:/bin' }, timeout: 5000 },
      (error, stdout) => resolve(error ? '' : String(stdout).trim())));
    const [name, email, lfs] = await Promise.all([get('user.name'), get('user.email'), get('filter.lfs.process')]);
    return { name, email, lfs: Boolean(lfs) };
  })();
  return gitIdentityRead;
}

function setComputerPaused(paused) {
  computerBridge?.setPaused(paused);
  computerChanged();
}

// Touch ID where the Mac has it; otherwise the dialogs the person just answered are the confirmation.
async function confirmWithTouchId(reason) {
  if (process.platform !== 'darwin' || !systemPreferences.canPromptTouchID?.()) return undefined;
  try {
    await systemPreferences.promptTouchID(reason);
    return true;
  } catch {
    return false;
  }
}

// Full access: Touch ID where the Mac has it. Elsewhere the prompt itself is the confirmation: its Run
// says "Run with full access" and takes no answer until it has been in front for a moment.
async function confirmFullAccess() {
  return (await confirmWithTouchId('run a command with full access')) !== false;
}

// Away mode's questions: how long and whether with internet, then the command budget.
async function awayChoice({ taskTitle }) {
  const parent = computerParent();
  const duration = awayDurationPrompt(taskTitle);
  const first = await messageBox(duration, parent);
  const minutes = duration.minutes[first.response];
  if (!minutes) return undefined;
  const budget = awayBudgetPrompt();
  const second = await messageBox(budget, parent);
  const maxCommands = budget.budgets[second.response];
  if (!maxCommands) return undefined;
  return { minutes, network: first.checkboxChecked === true, maxCommands };
}

// Started from the dashboard's own page: the person still answers every question here.
async function startAwayFromDashboard(input) {
  if (!computerBridge || !computerLink.info()) return computerState();
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  if (computerPlatform() !== 'macos') {
    await messageBox({
      type: 'info', title: 'Away mode', message: 'Away mode isn’t available on this computer yet',
      detail: 'Away mode runs commands in a sandbox, which 1904 Desktop has only on macOS for now.', buttons: ['OK'],
    }, parent);
    return computerState();
  }
  const taskId = typeof input?.taskId === 'string' && /^[a-f0-9]{32}$/.test(input.taskId) ? input.taskId : undefined;
  const appId = typeof input?.appId === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(input.appId) ? input.appId : undefined;
  if (!taskId || !appId) return computerState();
  // Like a stamped message: only right after the person typed or clicked in the window, with it in front.
  if (!computerInput.decide({ focused: Boolean(mainWindow?.isFocused()) && Boolean(dashboardContents?.isFocused()) }).stamp) return computerState();
  const started = await computerBridge.startAway({ taskId, appId, taskTitle: computerPolicy.label(input.taskTitle, 200) || 'Task' });
  if (!started.ok && started.message) {
    await messageBox({ type: 'info', title: 'Away mode', message: 'Away mode didn’t start', detail: started.message, buttons: ['OK'] }, parent);
  }
  computerChanged();
  return computerState();
}

function computerNotice(title, body) {
  if (!Notification.isSupported()) return;
  const notice = new Notification({ title, body });
  computerNotices.add(notice);
  const forget = () => computerNotices.delete(notice);
  notice.once('click', () => { forget(); showActivity(); });
  notice.once('close', forget);
  notice.once('failed', forget);
  notice.show();
}

// What the person hears about away mode while they may not be at the computer. Text from 1904 or the
// agent is spelled out the way the prompt shows it, and marked where it was cut.
function onComputerNotice(notice) {
  const task = computerPolicy.shortLine(notice.lease?.taskTitle ?? notice.request?.task.title ?? 'a task', 60);
  if (notice.kind === 'away-run') {
    computerNotice(`Ran a command for “${task}”`, `${computerPolicy.shortLine(notice.request.command, 120)}\nAway mode: ${notice.lease.maxCommands - notice.lease.used} commands left.`);
  } else if (notice.kind === 'away-started') {
    const until = new Date(notice.lease.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    computerNotice('Away mode is on', `“${task}” can run sandboxed commands here until ${until}.`);
  } else if (notice.kind === 'away-ended') {
    const why = { time: 'Its time is up.', budget: 'It used its command budget.', elsewhere: 'It was ended from 1904.', desktop: 'You ended it.' }[notice.reason] || '';
    computerNotice('Away mode ended', `“${task}”. ${why}`.trim());
  } else if (notice.kind === 'deploy-run') {
    // A deploy that runs without asking is always announced, so it never runs unseen.
    const name = computerPolicy.shortLine(notice.request.app.name, 60);
    computerNotice(`Deploying ${name}`, 'Running the deploy commands you saved on this computer, without asking. Open Computer Activity to watch or stop it.');
  } else if (notice.kind === 'deploy-finished') {
    const name = computerPolicy.shortLine(notice.request.app.name, 60);
    if (notice.status === 'done') computerNotice(`Deployed ${name}`, 'The deploy commands finished.');
    else computerNotice(`${name} did not deploy`, Number.isInteger(notice.exitCode) ? `The commands ended with exit code ${notice.exitCode}. Open Computer Activity for the output.` : 'Open Computer Activity for what happened.');
    sendDeployState();
  } else if (notice.kind === 'dry-run-finished') {
    // Shown in the deploy window, where the person is: what the host said, and whether anything would stop a deploy.
    if (deployWindow && !deployWindow.isDestroyed()) {
      const checked = deployRecipes?.all().find(recipe => recipe.appId === notice.request.app.id);
      deployWindow.webContents.send('1904:deploy-dry-run-result', {
        appId: notice.request.app.id, ok: notice.status === 'done', output: computerPolicy.visibleText(String(notice.output ?? '').slice(-8000)),
        // Build commands that usually go with what the folder holds, for the person to read and save themselves.
        suggested: checked ? computerDeploy.suggestCommands(notice.output, checked.commands) : undefined,
      });
    }
    // The checklist in the window shows what this dry run found.
    sendDeployState();
  }
  computerChanged();
}

// Through the active account's session, so these requests carry its sign-in and its Cloudflare clearance.
function sessionFetch(url, init) {
  return session.fromPartition(activePartition()).fetch(url, init);
}

// Use My Computer polls with its own bearer token; stay on its paired account's partition when present.
function computerFetch(url, init) {
  const partition = accountStore?.partitionForEmail(computerLink?.info()?.account) || activePartition();
  return session.fromPartition(partition).fetch(url, init);
}

function messageBox(options, parent) {
  return parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options);
}

// Prompts belong to the dashboard window; without one they sit on Computer Activity. A parentless
// prompt on macOS would block this process, and with it every running command's output.
function computerParent() {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow;
  return showActivity({ focus: false });
}

function isActivityPage(url) {
  try {
    const file = fileURLToPath(url);
    return process.platform === 'win32' ? file.toLowerCase() === ACTIVITY_PAGE.toLowerCase() : file === ACTIVITY_PAGE;
  } catch {
    return false;
  }
}

function isActivitySender(event) {
  return Boolean(activityWindow) && !activityWindow.isDestroyed() && event.sender === activityWindow.webContents &&
    event.senderFrame === event.sender.mainFrame && isActivityPage(event.senderFrame?.url);
}

// The pages that use Use My Computer: the agents dashboard, and 1904 Settings → Computers and → 1904 Desktop.
// No other 1904 page can reach it, so content 1904 might show on another page never can either.
const COMPUTER_SETTINGS_PAGES = ['/settings/computers', '/settings/desktop'];
function isComputerPage(href) {
  const url = webUrl(href);
  return isTaskTitleBarPage(href) || (url?.origin === ORIGIN && COMPUTER_SETTINGS_PAGES.includes(url.pathname.replace(/\/$/, '')));
}

function isComputerDashboardSender(event) {
  return Boolean(dashboardContents) && event.sender === dashboardContents && event.senderFrame === event.sender.mainFrame &&
    isComputerPage(event.senderFrame?.url);
}

function showActivity({ focus = true } = {}) {
  if (activityWindow && !activityWindow.isDestroyed()) {
    if (focus) {
      if (activityWindow.isMinimized()) activityWindow.restore();
      activityWindow.show();
      activityWindow.focus();
    } else if (!activityWindow.isVisible()) {
      activityWindow.showInactive();
    }
    return activityWindow;
  }
  const win = new BrowserWindow({
    title: 'Computer Activity', icon: ICON, width: 760, height: 680, minWidth: 420, minHeight: 320,
    backgroundColor: PALETTE[activeTheme()].color, autoHideMenuBar: true, show: false,
    webPreferences: { ...SAFE_PREFERENCES, preload: path.join(__dirname, 'activity-preload.cjs') },
  });
  activityWindow = win;
  win.on('closed', () => { if (activityWindow === win) activityWindow = undefined; });
  win.webContents.on('dom-ready', () => win.webContents.send('1904:activity-theme', activeTheme()));
  void win.loadFile(ACTIVITY_PAGE);
  if (focus) win.show();
  else win.showInactive();
  return win;
}

// ── The prompt window ──────────────────────────────────────────────────────
// One request at a time (the bridge's queue). A local page with no script of its own; its preload
// renders the view and answers with the nonce of the request it shows. Closing it declines.

function isApprovalPage(url) {
  try {
    const file = fileURLToPath(url);
    return process.platform === 'win32' ? file.toLowerCase() === APPROVAL_PAGE.toLowerCase() : file === APPROVAL_PAGE;
  } catch {
    return false;
  }
}

function isApprovalSender(event) {
  return Boolean(approvalWindow) && !approvalWindow.isDestroyed() && event.sender === approvalWindow.webContents &&
    event.senderFrame === event.sender.mainFrame && isApprovalPage(event.senderFrame?.url);
}

function approvalIcon() {
  if (approvalIconUrl === undefined) {
    try { approvalIconUrl = nativeImage.createFromPath(ICON).resize({ width: 40, height: 40 }).toDataURL(); } catch { approvalIconUrl = ''; }
  }
  return approvalIconUrl;
}

function settleApproval(answer) {
  const pending = approvalPending;
  approvalPending = undefined;
  pending?.resolve(answer);
}

function approvalWindowNow() {
  if (approvalWindow && !approvalWindow.isDestroyed()) return approvalWindow;
  const mac = process.platform === 'darwin';
  const palette = PALETTE[activeTheme()];
  const parent = computerParent();
  const win = new BrowserWindow({
    title: 'Use My Computer', icon: ICON, width: 580, height: 640, minWidth: 460, minHeight: 360,
    parent: parent && !parent.isDestroyed() ? parent : undefined, modal: false, show: false,
    minimizable: false, maximizable: false, fullscreenable: false, backgroundColor: palette.color,
    titleBarStyle: 'hidden',
    ...(mac ? { trafficLightPosition: { x: 14, y: 13 } } : { titleBarOverlay: { ...palette, height: 40 } }),
    webPreferences: { ...SAFE_PREFERENCES, preload: path.join(__dirname, 'approval-preload.cjs') },
  });
  approvalWindow = win;
  win.on('focus', () => { if (approvalPending) approvalPending.focusedAt = Date.now(); });
  win.on('closed', () => {
    if (approvalWindow === win) approvalWindow = undefined;
    // Closing the window is a Decline.
    settleApproval({ action: 'decline' });
  });
  approvalLoaded = win.loadFile(APPROVAL_PAGE).then(() => true, () => false);
  return win;
}

// Waits for a pause in the person's typing and clicking in the dashboard, so the prompt never opens
// under a key press or click meant for something else.
async function quietInput(signal) {
  const until = Date.now() + APPROVAL_QUIET_MAX_MS;
  while (!signal?.aborted && computerInput.idleMs() < APPROVAL_QUIET_MS && Date.now() < until) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

function showApprovalPrompt(view, signal) {
  return new Promise(resolve => {
    void (async () => {
      if (signal?.aborted) return resolve({ action: 'decline' });
      await quietInput(signal);
      if (signal?.aborted) return resolve({ action: 'decline' });
      const win = approvalWindowNow();
      if (!(await approvalLoaded) || win.isDestroyed() || signal?.aborted) return resolve({ action: 'decline' });
      settleApproval({ action: 'decline' });
      const nonce = randomUUID();
      approvalPending = { nonce, resolve, shownAt: Date.now(), focusedAt: 0 };
      signal?.addEventListener('abort', () => {
        if (approvalPending?.nonce === nonce) settleApproval({ action: 'decline' });
      }, { once: true });
      win.webContents.send('1904:approval-show', { nonce, view, theme: activeTheme(), platform: computerPlatform(), icon: approvalIcon() });
      // In front only when the person is already in 1904 Desktop; otherwise it waits behind, and
      // computerAttention says so. Either way Run waits until the window has been in front a moment.
      const inDesktop = BrowserWindow.getFocusedWindow() !== null;
      if (inDesktop) {
        win.show();
        win.focus();
        approvalPending.focusedAt = Date.now();
      } else {
        win.showInactive();
        if (process.platform === 'win32') win.flashFrame(true);
      }
    })().catch(() => resolve({ action: 'decline' }));
  });
}

function closeApprovalPrompt() {
  settleApproval({ action: 'decline' });
  if (approvalWindow && !approvalWindow.isDestroyed()) approvalWindow.close();
}

// The window's answer, for the request it shows now. Run and away mode count only once the window has
// been in front for APPROVAL_ARM_MS; the preload holds Run back the same way.
function onApprovalAnswer(event, answer) {
  if (!isApprovalSender(event) || !approvalPending || answer?.nonce !== approvalPending.nonce) return;
  const action = ['run', 'decline', 'folder', 'away'].includes(answer.action) ? answer.action : 'decline';
  if (action === 'run' || action === 'away') {
    const since = Math.max(approvalPending.shownAt, approvalPending.focusedAt || Infinity);
    if (!approvalWindow.isFocused() || !(Date.now() - since >= APPROVAL_ARM_MS)) return;
  }
  settleApproval({
    action,
    scope: ['once', 'message', 'task'].includes(answer.scope) ? answer.scope : 'once',
    minutes: Number.isInteger(answer.minutes) ? answer.minutes : undefined,
    network: answer.network === true,
  });
}

function onApprovalSize(event, height) {
  if (!isApprovalSender(event) || !Number.isFinite(height)) return;
  const area = screen.getDisplayMatching(approvalWindow.getBounds()).workArea;
  const [width] = approvalWindow.getContentSize();
  approvalWindow.setContentSize(width, Math.round(Math.min(area.height * 0.9, Math.max(360, height))));
}

function computerFolders() {
  if (!computerBridge) return [];
  const chosen = computerLink.folders.all();
  const apps = new Map(computerBridge.apps().map(appRef => [appRef.id, appRef]));
  for (const [id, entry] of Object.entries(chosen)) {
    if (!apps.has(id)) apps.set(id, { id, name: entry.name || 'App', repo: entry.repo || '' });
  }
  return [...apps.values()].map(appRef => ({
    appId: appRef.id, name: computerPolicy.visibleLine(appRef.name), repo: appRef.repo,
    path: computerPolicy.visibleLine(computerBridge.describe({ app: appRef }).root), chosen: Object.hasOwn(chosen, appRef.id),
  }));
}

function activityState(output) {
  if (!computerBridge) {
    return { connection: { connected: false, text: 'Use My Computer is available in 1904 Desktop for macOS and Windows.' }, runs: [], history: [], away: [], allowances: [], folders: [] };
  }
  return { ...computerBridge.snapshot({ output }), folders: computerFolders() };
}

function sendActivityState() {
  clearTimeout(activityStateTimer);
  activityStateTimer = undefined;
  if (!activityStateDirty) return;
  activityStateDirty = false;
  if (activityWindow && !activityWindow.isDestroyed()) activityWindow.webContents.send('1904:activity-state', activityState(false));
}

// Output goes to the window in small batches. Each batch is numbered, so the window can skip
// what its first full snapshot already contained.
function flushActivityOutput() {
  clearTimeout(activityOutputTimer);
  activityOutputTimer = undefined;
  sendActivityState();
  if (!activityOutput.length) return;
  const chunks = [];
  for (const chunk of activityOutput.splice(0)) {
    const last = chunks[chunks.length - 1];
    if (last?.id === chunk.id && last.stream === chunk.stream) last.text += chunk.text;
    else chunks.push({ ...chunk });
  }
  activityOutputSeq++;
  if (activityWindow && !activityWindow.isDestroyed()) activityWindow.webContents.send('1904:activity-output', { seq: activityOutputSeq, chunks });
}

function queueComputerOutput(id, stream, text) {
  activityOutput.push({ id, stream, text });
  activityOutputTimer ??= setTimeout(flushActivityOutput, 100);
}

function sendComputerIndicator() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('1904:chrome-computer', computerBridge?.running() ?? 0);
}

function computerChanged() {
  sendComputerIndicator();
  const key = JSON.stringify([computerState(), computerBridge?.away().map(lease => lease.id), computerBridge?.taskAllowances().map(entry => entry.taskId)]);
  if (key !== computerMenuKey) {
    computerMenuKey = key;
    installMenu();
  }
  activityStateDirty = true;
  activityStateTimer ??= setTimeout(sendActivityState, 50);
  sendDeployState();
}

function focusComputerPrompt() {
  if (mainWindow && !mainWindow.isDestroyed()) showDashboard();
  else showActivity();
}

// The prompt is up but the person may be elsewhere: say so where they will see it.
function computerAttention(request) {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : activityWindow;
  if (parent && !parent.isDestroyed() && parent.isFocused()) return;
  if (process.platform === 'win32' && parent && !parent.isDestroyed()) parent.flashFrame(true);
  if (!Notification.isSupported()) return;
  const sender = computerPolicy.shortLine(request.sender.name || 'Someone', 60);
  const notice = new Notification({ title: `${sender} wants to run a command on this computer`, body: 'Open 1904 Desktop to review it.' });
  computerNotices.add(notice);
  const forget = () => computerNotices.delete(notice);
  notice.once('click', () => { forget(); focusComputerPrompt(); });
  notice.once('close', forget);
  notice.once('failed', forget);
  notice.show();
}

async function chooseComputerFolder(appRef, parent) {
  if (!computerBridge || !appRef?.id) return false;
  const current = computerBridge.describe({ app: appRef }).root;
  const options = {
    title: `Choose a folder for ${appRef.name}`, buttonLabel: 'Use This Folder',
    defaultPath: existsSync(current) ? current : path.dirname(current),
    properties: ['openDirectory', 'createDirectory'],
  };
  const { canceled, filePaths } = parent && !parent.isDestroyed() ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
  const folder = filePaths?.[0];
  if (canceled || !folder) return false;
  const problem = computerFolderProblem(folder);
  if (problem) {
    await messageBox({ type: 'warning', title: 'Use My Computer', message: 'Choose another folder', detail: problem, buttons: ['OK'] }, parent);
    return false;
  }
  computerLink.folders.set(appRef.id, folder, appRef);
  computerChanged();
  return true;
}

function connectComputer() {
  if (!computerBridge) return Promise.resolve(computerState());
  computerConnecting ??= (async () => {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    try {
      const platform = computerPlatform();
      const connected = await pairComputer({
        link: computerLink, fetch: sessionFetch, origin: ORIGIN,
        computer: {
          name: computerPolicy.defaultComputerName(os.hostname()), platform, appVersion: app.getVersion(),
          shell: computerPolicy.computerShell({ platform, env: process.env, exists: existsSync }).name,
        },
        confirm: async (name, person) => (await messageBox(connectPrompt(name, person), parent)).response === 1,
        notice: ({ message, detail }) => messageBox({ type: 'info', title: 'Use My Computer', message, detail, buttons: ['OK'] }, parent),
      });
      if (connected) computerBridge.start();
    } catch (error) {
      console.warn('1904 Desktop could not connect this computer:', error?.message);
    } finally {
      computerConnecting = undefined;
      computerChanged();
    }
    return computerState();
  })();
  return computerConnecting;
}

async function disconnectComputer() {
  if (!computerBridge || !computerLink.info()) return;
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  const { response } = await messageBox({
    type: 'question', title: 'Use My Computer', message: 'Disconnect this computer from 1904?',
    detail: 'Tasks can no longer ask to run commands here, a command that is running now is stopped, ' +
      'and 1904 stops accepting this computer’s key.',
    buttons: ['Cancel', 'Disconnect'], defaultId: 0, cancelId: 0, noLink: true,
  }, parent);
  if (response !== 1) return;
  const confirmed = await computerBridge.disconnect();
  computerChanged();
  if (!confirmed) {
    await messageBox({
      type: 'info', title: 'Use My Computer', message: 'This computer is disconnected',
      detail: '1904 couldn’t be reached, so this computer may still be listed in 1904 Settings. Its key is gone from here; remove it under Computers in 1904 Settings when you can.',
      buttons: ['OK'],
    }, mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined);
  }
}

function startComputer() {
  const platform = computerPlatform();
  if (!platform) return;
  const userData = app.getPath('userData');
  computerLink = createComputerLink({ dir: userData, safeStorage, folderProblem: computerFolderProblem });
  computerMessages = computerProof.createMessageLog({ file: path.join(userData, 'computer-messages.json') });
  let username = '';
  try { username = os.userInfo().username; } catch { /* left empty */ }
  computerBridge = createComputerBridge({
    origin: ORIGIN, fetch: computerFetch, link: computerLink, platform, home: os.homedir(), user: username, env: process.env,
    messages: computerMessages,
    leases: createAwayLeases({ file: path.join(userData, 'computer-away.json') }),
    log: computerLog = createActivityLog({ file: path.join(userData, 'computer-activity.jsonl') }),
    deploys: deployRecipes = computerDeploy.createDeployRecipes({ file: path.join(userData, computerDeploy.RECIPES_FILE) }),
    deploySecrets: deploySecrets = deploySsh.createDeploySecrets({ file: path.join(userData, deploySsh.SECRETS_FILE), vault: deploySsh.createVault(safeStorage) }),
    askSecret: askDeployPassword,
    userData, tmpRoot: os.tmpdir(), exists: existsSync, realpathSync,
    fs: { mkdir, stat, mkdtemp, rm, realpath, writeFile }, spawn, kill: (pid, signal) => process.kill(pid, signal), gitIdentity,
    clock: { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer) },
    ask: createPromptAsk({
      computerName: () => computerLink.info()?.name || computerPolicy.defaultComputerName(os.hostname()),
      showPrompt: showApprovalPrompt,
      closePrompt: closeApprovalPrompt,
      chooseFolder: appRef => chooseComputerFolder(appRef, approvalWindow && !approvalWindow.isDestroyed() ? approvalWindow : computerParent()),
      attention: computerAttention,
      confirmFull: confirmFullAccess,
    }),
    awayChoice,
    // true, false, or undefined where there is no Touch ID; then confirmLease asks once more.
    confirmPresence: confirmWithTouchId,
    confirmLease: async lease => (await messageBox(awayConfirmPrompt(lease), computerParent())).response === 1,
    onChange: computerChanged,
    onOutput: queueComputerOutput,
    onDisconnected: computerChanged,
    onNotice: onComputerNotice,
  });
  powerMonitor.on('suspend', () => computerBridge.suspend());
  powerMonitor.on('resume', () => computerBridge.resume());
  // No pairing at startup (never connected, or its file is gone): nothing saved earlier may run without asking once
  // this computer is connected again, whatever id the new pairing is given.
  if (!computerLink.info()) { try { deployRecipes.disarm(); } catch { /* it cannot run without a pairing anyway */ } }
  computerBridge.start();
}

function startDesktopBrowser() {
  desktopBrowserBridge = createDesktopBrowserBridge({
    file: path.join(app.getPath('userData'), 'browser-settings.json'), fetch: sessionFetch, origin: ORIGIN,
    confirm: async ({site}) => (await messageBox({type:'question',title:'Use your browser',message:'Share this browser tab with the task?',detail:`Website: ${site}\nOnly this selected tab is shared. Its page and screenshots go to the task; cookies stay on this computer. Browser actions still use the task’s approval controls.`,buttons:['Cancel','Share tab'],defaultId:0,cancelId:0,noLink:true},computerParent())).response === 1,
  });
  powerMonitor.on('suspend', () => desktopBrowserBridge.pause());
  powerMonitor.on('resume', () => desktopBrowserBridge.resume());
  app.on('will-quit', () => desktopBrowserBridge.close());
}
async function setupDesktopBrowser() {
  const code = await desktopBrowserBridge.setup();
  const {response} = await messageBox({type:'info',title:'Connect your browser',message:'Connect Chrome or Edge',detail:'Load the 1904 browser extension, then open it on the tab you want to share. Paste a connection code from here and select Share this tab. You approve each task separately. Safari and Firefox are not supported yet.',buttons:['Cancel','Copy connection code','Open extension folder'],defaultId:0,cancelId:0,noLink:true},computerParent());
  if(response===1)clipboard.writeText(code);
  if(response===2){
    const folder=path.join(app.getPath('userData'),'browser-extension');
    await mkdir(folder,{recursive:true});
    for(const name of ['manifest.json','popup.html','popup.js','worker.js'])await writeFile(path.join(folder,name),await require('node:fs/promises').readFile(path.join(app.getAppPath(),'browser-extension',name)));
    await shell.openPath(folder);
  }
  return desktopBrowserBridge.state();
}
function installDesktopBrowserHandlers() {
  ipcMain.handle('1904:browser-state', event => isComputerDashboardSender(event) ? desktopBrowserBridge.state() : null);
  ipcMain.handle('1904:browser-preference', (event,value) => {
    if(!isComputerDashboardSender(event)||!['auto','desktop','cloud'].includes(value))return null;
    return desktopBrowserBridge.setPreference(value);
  });
  ipcMain.handle('1904:browser-setup', event => {
    if(!isComputerDashboardSender(event)||!computerInput.decide({focused:Boolean(mainWindow?.isFocused())&&Boolean(dashboardContents?.isFocused())}).stamp)return null;
    return setupDesktopBrowser();
  });
  ipcMain.handle('1904:browser-execute', (event,input) => {
    if(!isComputerDashboardSender(event)||!isTaskTitleBarPage(event.senderFrame?.url))return null;
    return desktopBrowserBridge.execute(input);
  });
  ipcMain.handle('1904:browser-focus', (event,input) => {
    if(!isComputerDashboardSender(event)||!isTaskTitleBarPage(event.senderFrame?.url))return null;
    return desktopBrowserBridge.focus(input);
  });
  ipcMain.handle('1904:browser-release', (event,input) => {
    if(isComputerDashboardSender(event))desktopBrowserBridge.release(input||{});
  });
}

// ── Deploy From This Computer ──────────────────────────────────────────────
// The person saves an app's deploy commands in this window; 1904 can then ask this computer to run them
// when a change of theirs merges. The commands, the connect line and "Submit without approval" live only
// here (computer-deploy.cjs): the dashboard page can open this window and nothing else, and 1904 is told
// only that an app has commands, in what order it deploys, and whether it asks first.

function isDeployPage(url) {
  try {
    const file = fileURLToPath(url);
    return process.platform === 'win32' ? file.toLowerCase() === DEPLOY_PAGE.toLowerCase() : file === DEPLOY_PAGE;
  } catch {
    return false;
  }
}

function isDeploySender(event) {
  return Boolean(deployWindow) && !deployWindow.isDestroyed() && event.sender === deployWindow.webContents &&
    event.senderFrame === event.sender.mainFrame && isDeployPage(event.senderFrame?.url);
}

// A key or click meant for another window must not land on Save or Run now the moment this one is brought forward:
// the window has to have been in front for a moment first.
function deployArmed() {
  return Boolean(deployWindow) && !deployWindow.isDestroyed() && deployWindow.isFocused() && deployFocusedAt > 0 && Date.now() - deployFocusedAt >= DEPLOY_ARM_MS;
}
const DEPLOY_NOT_ARMED = { ok: false, error: 'Try that again: the window had only just come to the front.' };

function showDeploys() {
  if (deployWindow && !deployWindow.isDestroyed()) {
    if (deployWindow.isMinimized()) deployWindow.restore();
    deployWindow.show();
    deployWindow.focus();
    return deployWindow;
  }
  const win = new BrowserWindow({
    title: 'Deploy From This Computer', icon: ICON, width: 900, height: 800, minWidth: 520, minHeight: 440,
    backgroundColor: PALETTE[activeTheme()].color, autoHideMenuBar: true, show: false,
    webPreferences: { ...SAFE_PREFERENCES, preload: path.join(__dirname, 'deploy-preload.cjs') },
  });
  deployWindow = win;
  win.on('closed', () => { if (deployWindow === win) deployWindow = undefined; });
  win.on('focus', () => { deployFocusedAt = Date.now(); });
  win.on('blur', () => { deployFocusedAt = 0; });
  win.webContents.on('dom-ready', () => win.webContents.send('1904:deploy-theme', activeTheme()));
  void win.loadFile(DEPLOY_PAGE);
  win.show();
  return win;
}

/** What the window shows, from what this computer has saved and the app list 1904 last answered. */
function deployState() {
  const info = computerLink?.info();
  const connection = computerBridge?.connection() ?? { connected: false, text: 'Deploy From This Computer is available in 1904 Desktop for macOS and Windows.' };
  return {
    platform: computerPlatform(),
    connection: { connected: Boolean(info), text: info ? `Connected to 1904 as ${info.name}.${connection.paused ? ' Use My Computer is paused, so nothing from 1904 runs until you resume it.' : ''}` : connection.text },
    // The repository's name goes along so the window can say which checkout the app folder should be. Only a plain name is shown.
    apps: [...deployApps.values()].map(appRef => ({ id: appRef.id, name: computerPolicy.visibleLine(appRef.name), repo: /^[A-Za-z0-9._-]{1,100}$/.test(appRef.repo ?? '') ? appRef.repo : '' })),
    recipes: (deployRecipes?.all() ?? []).map(recipe => computerDeploy.recipeView(recipe, info?.id)),
    // Whether a password or a deploy key is kept for each app, and the key's public half. Never a secret.
    kept: Object.fromEntries([...new Set([...deployApps.keys(), ...(deployRecipes?.all() ?? []).map(recipe => recipe.appId)])].map(appId => {
      const summary = deploySecrets?.summary(appId, info?.id) ?? { password: false };
      return [appId, { password: summary.password, publicKey: summary.publicKey ?? '', installCommand: deploySsh.installKeyCommand(summary.publicKey) }];
    })),
    ...(deployMessage ? { message: deployMessage } : {}),
  };
}

// ── Reaching a host ────────────────────────────────────────────────────────
// Setting up a host from the deploy window: reading its identity, making a deploy key, and installing that key with a
// password typed once. Each is a short run of the system's own ssh or ssh-keygen, started here with its arguments as
// separate words and nothing of 1904 Desktop's environment but what a command gets.

/** Runs one program to its end: `{ code, stdout, stderr }`, never throwing. Its own session, so ssh has no terminal to ask on. */
function runSetup(file, args, { env, timeoutMs = deploySsh.SETUP_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    let child;
    const out = { stdout: '', stderr: '' };
    try {
      child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    } catch (error) {
      resolve({ code: null, stdout: '', stderr: String(error?.message ?? error) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    for (const stream of ['stdout', 'stderr']) child[stream]?.on('data', chunk => { out[stream] = (out[stream] + chunk).slice(-16 * 1024); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, ...out, stderr: out.stderr || String(error?.message ?? error) }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, ...out }); });
  });
}

/** A folder of this app's own for one setup job, removed when the job is done. */
async function withSetupFolder(job) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), '1904-deploy-setup-')));
  try { return await job(dir); } finally { rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

function setupEnvironment(tempDir) {
  const platform = computerPlatform();
  const shell = computerPolicy.computerShell({ platform, env: process.env, exists: existsSync });
  return computerPolicy.commandEnvironment({ platform, env: process.env, searchPath: process.env.PATH || process.env.Path, tempDir, shellFile: shell.file });
}

const NO_SSH = { ok: false, error: 'This computer has no ssh program. Install OpenSSH, then try again.' };
/** The host as typed, before its identity is known: checked like a saved one, with a stand-in for the keys it does not have yet. */
function typedHost(input) {
  const auth = deploySsh.DEPLOY_AUTH.includes(input?.auth) ? input.auth : 'key';
  const checked = deploySsh.cleanHost({ ...input, auth: 'ssh', user: input?.user });
  if (!checked.ok) return checked;
  if (!checked.host.user) return { ok: false, error: 'Enter the user name to sign in as on the host.' };
  return { ok: true, host: { ...checked.host, port: checked.host.port ?? 22, auth } };
}

/** Check host: what the host shows as its identity, for the person to compare and trust. Nothing is signed in to. */
async function checkDeployHost(input) {
  const typed = typedHost(input);
  if (!typed.ok) return typed;
  const ssh = deploySsh.sshProgram('ssh', { platform: computerPlatform(), env: process.env, exists: existsSync });
  if (!ssh) return NO_SSH;
  return withSetupFolder(async dir => {
    const knownHosts = path.join(dir, 'known_hosts');
    const ran = await runSetup(ssh, deploySsh.hostKeyArgs({ host: typed.host, knownHosts }), { env: setupEnvironment(dir) });
    let text = '';
    try { text = await readFile(knownHosts, 'utf8'); } catch { /* the host never answered */ }
    const keys = deploySsh.readHostKeys(text, typed.host);
    return keys.length ? { ok: true, keys } : { ok: false, error: deploySsh.sshProblem(ran.stderr) };
  });
}

/** Create deploy key: a new key pair for this app, its private half sealed with the system's key store at once. */
async function makeDeployKey(appId) {
  const info = computerLink?.info();
  const appRef = deployApps.get(appId) ?? deployRecipes?.all().find(recipe => recipe.appId === appId);
  if (!info || !appRef || !deploySecrets) return { ok: false, error: 'Connect this computer and choose one of your apps first.' };
  const keygen = deploySsh.sshProgram('ssh-keygen', { platform: computerPlatform(), env: process.env, exists: existsSync });
  if (!keygen) return NO_SSH;
  try {
    return await withSetupFolder(async dir => {
      const file = path.join(dir, 'key');
      const ran = await runSetup(keygen, deploySsh.keygenArgs({ file, comment: appRef.name ?? appRef.appName }), { env: setupEnvironment(dir) });
      if (ran.code !== 0) return { ok: false, error: 'Could not make a key on this computer.' };
      await deploySecrets.setKey(appId, info.id, { privateKey: await readFile(file, 'utf8'), publicKey: await readFile(file + '.pub', 'utf8') });
      return { ok: true, state: deployState() };
    });
  } catch (error) {
    return { ok: false, error: computerPolicy.label(error?.message, 300) || 'Could not keep the new key on this computer.' };
  }
}

/** Install the key: signs in once with the password just typed, adds the public key on the host, and keeps no password. */
async function installDeployKey(appId, input, password) {
  const info = computerLink?.info();
  const typed = deploySsh.cleanHost({ ...input, auth: 'password-ask' });
  if (!typed.ok) return typed;
  const key = info && deploySecrets?.summary(appId, info.id).publicKey;
  if (!key) return { ok: false, error: 'Create the deploy key first.' };
  const secret = deploySsh.cleanPassword(password);
  if (!secret) return { ok: false, error: 'Enter the password for the host.' };
  const ssh = deploySsh.sshProgram('ssh', { platform: computerPlatform(), env: process.env, exists: existsSync });
  if (!ssh) return NO_SSH;
  return withSetupFolder(async dir => {
    const knownHosts = path.join(dir, 'known_hosts');
    await writeFile(knownHosts, typed.host.keys.join('\n') + '\n', { mode: 0o600 });
    const helper = deploySsh.askpass({ platform: computerPlatform() });
    const helperFile = path.join(dir, helper.name);
    await writeFile(helperFile, helper.text, { mode: helper.mode ?? 0o600 });
    const nonce = randomBytes(8).toString('hex');
    const ran = await runSetup(ssh, deploySsh.sshArgs({ host: typed.host, files: { knownHosts }, word: computerDeploy.scriptWord(deploySsh.installKeyScript(key, nonce)) }),
      { env: { ...setupEnvironment(dir), ...deploySsh.passwordEnvironment({ helper: helperFile, password: secret, env: process.env }) } });
    const done = computerDeploy.readDeployOutput(ran.stdout, nonce);
    if (ran.code === 0 && done.confirmed) return { ok: true };
    return { ok: false, error: ran.code === 0 ? 'The host did not confirm that the key was added.' : deploySsh.sshProblem(ran.stderr, { password: true }) };
  });
}

// ── A password typed for one deploy ────────────────────────────────────────
// For a host whose password the person chose not to save: a small window of this app's own asks for it when a deploy
// is about to start. What is typed goes to ssh for that one run and is not kept.

function isSecretSender(event) {
  if (!secretWindow || secretWindow.isDestroyed() || event.sender !== secretWindow.webContents || event.senderFrame !== event.sender.mainFrame) return false;
  try {
    const file = fileURLToPath(event.senderFrame?.url);
    return process.platform === 'win32' ? file.toLowerCase() === SECRET_PAGE.toLowerCase() : file === SECRET_PAGE;
  } catch {
    return false;
  }
}

function settleSecret(value) {
  const pending = secretPending;
  secretPending = undefined;
  if (secretWindow && !secretWindow.isDestroyed()) secretWindow.close();
  secretWindow = undefined;
  pending?.resolve(value);
}

function askDeployPassword({ request, host }) {
  if (secretPending) settleSecret(undefined);
  return new Promise(resolve => {
    const nonce = randomBytes(16).toString('hex');
    // Nobody at the computer: the deploy is given up rather than left holding the ones behind it.
    const timer = setTimeout(() => { if (secretPending?.nonce === nonce) settleSecret(undefined); }, 10 * 60_000);
    secretPending = { nonce, resolve: value => { clearTimeout(timer); resolve(value); } };
    const win = new BrowserWindow({
      title: 'Deploy From This Computer', icon: ICON, width: 460, height: 260, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      backgroundColor: PALETTE[activeTheme()].color, autoHideMenuBar: true, show: false,
      webPreferences: { ...SAFE_PREFERENCES, preload: path.join(__dirname, 'secret-preload.cjs') },
    });
    secretWindow = win;
    win.on('closed', () => { if (secretPending?.nonce === nonce) settleSecret(undefined); });
    win.webContents.on('dom-ready', () => win.webContents.send('1904:secret-view', {
      nonce, theme: activeTheme(),
      heading: `Password to deploy ${computerPolicy.visibleLine(request.app.name)}`,
      detail: `For ${computerPolicy.visibleLine(`${host.user}@${host.name}`)}. It is used for this deploy only and is not saved.`,
    }));
    void win.loadFile(SECRET_PAGE);
    win.show();
    if (Notification.isSupported() && !win.isFocused()) computerNotice('A deploy needs your password', `Open 1904 Desktop to deploy ${computerPolicy.shortLine(request.app.name, 60)}.`);
  });
}

function sendDeployState() {
  if (deployWindow && !deployWindow.isDestroyed()) deployWindow.webContents.send('1904:deploy-state', deployState());
}

/**
 * Tells 1904 which apps have commands here (never the commands), and reads the apps it lists. Sent whole each
 * time, so a save or a removal that did not reach 1904 is put right by the next one.
 */
async function syncDeploys() {
  const info = computerLink?.info();
  if (!computerBridge || !deployRecipes || !info) { deployMessage = undefined; return false; }
  const recipes = deployRecipes.all().filter(recipe => recipe.computerId === info.id).map(recipe => {
    const { action: _action, ...registration } = computerDeploy.recipeRegistration(recipe);
    return registration;
  });
  const sent = await computerBridge.deployCall({ action: 'sync', recipes });
  if (sent.ok && Array.isArray(sent.body?.apps)) {
    deployApps = new Map(sent.body.apps.flatMap(entry => {
      const id = typeof entry?.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(entry.id) ? entry.id : undefined;
      return id ? [[id, { id, name: computerPolicy.label(entry.name) || 'Untitled app', repo: computerPolicy.label(entry.repo) || '' }]] : [];
    }));
    deployMessage = sent.body.enabled === false ? computerPolicy.label(sent.body.message, 300) || 'Use My Computer is turned off for your workspace.' : undefined;
    return true;
  }
  deployMessage = sent.status === 404
    ? '1904 has not been updated for deploys from a computer yet. Your commands are saved here and will work once it is.'
    : 'Could not reach 1904 just now. Your commands are saved on this computer; 1904 hears about them the next time this window opens.';
  return false;
}

async function saveDeployRecipe(appId, input) {
  const info = computerLink?.info();
  if (!computerBridge || !deployRecipes || !info) return { ok: false, error: 'Connect this computer first: choose Use My Computer… in the 1904 menu.' };
  const appRef = deployApps.get(appId) ?? deployRecipes.all().find(recipe => recipe.appId === appId && recipe.computerId === info.id);
  if (!appRef) return { ok: false, error: 'Choose one of your apps.' };
  const checked = computerDeploy.cleanRecipe(input);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (computerPlatform() === 'windows' && !computerDeploy.isRemote(checked.recipe) && checked.recipe.log.mode !== 'output') {
    return { ok: false, error: 'A log file needs a connect line on Windows. Choose “What the commands print”, or add how to connect.' };
  }
  const appName = appRef.name ?? appRef.appName;
  const previous = deployRecipes.get(appId, info.id);
  const { host } = checked.recipe;
  const typedPassword = deploySsh.cleanPassword(input?.password);
  if (host?.auth === 'key' && !deploySecrets?.summary(appId, info.id).publicKey) return { ok: false, error: 'Create the deploy key first, and add it on the host.' };
  if (host?.auth === 'password-saved' && !typedPassword && !deploySecrets?.summary(appId, info.id).password) return { ok: false, error: 'Enter the password to save for this host.' };
  // Running without asking is granted for exactly these commands: turning it on, or changing them while it is on, asks.
  if (checked.recipe.noApproval && (!previous?.noApproval || previous.hash !== computerDeploy.recipeHash(checked.recipe))) {
    const { response } = await messageBox(computerDeploy.noApprovalPrompt({ ...checked.recipe, appName }, info.name), deployWindow);
    if (response !== 1) return { ok: false, cancelled: true };
    if ((await confirmWithTouchId('let these deploy commands run without asking')) === false) return { ok: false, cancelled: true };
  }
  let saved;
  try {
    // The password goes to the system's key store before anything that would use it is saved; one that is no longer wanted is forgotten.
    if (host?.auth === 'password-saved' && typedPassword) await deploySecrets.setPassword(appId, info.id, typedPassword);
    else if (host?.auth !== 'password-saved') deploySecrets?.forget(appId, 'password');
    saved = deployRecipes.save({ appId, appName, repo: appRef.repo, computerId: info.id }, checked.recipe);
  } catch (error) {
    return { ok: false, error: computerPolicy.label(error?.message, 300) || 'Could not save on this computer.' };
  }
  if (!saved.ok) return { ok: false, error: saved.error };
  const told = await syncDeploys();
  computerChanged();
  return { ok: true, ...(told ? {} : { warning: `Saved on this computer. ${deployMessage}` }), state: deployState() };
}

async function removeDeployRecipe(appId) {
  if (!deployRecipes) return { ok: false, error: 'Nothing to remove.' };
  const recipe = deployRecipes.all().find(entry => entry.appId === appId);
  if (!recipe) return { ok: false, error: 'This app has no deploy commands on this computer.' };
  const { response } = await messageBox({
    type: 'question', title: 'Deploy From This Computer', message: `Remove ${computerPolicy.visibleLine(computerPolicy.label(recipe.appName, 80) || 'this app')}’s deploy commands from this computer?`,
    detail: '1904 can no longer ask this computer to deploy this app.', buttons: ['Cancel', 'Remove'], defaultId: 0, cancelId: 0, noLink: true,
  }, deployWindow);
  if (response !== 1) return { ok: false, cancelled: true };
  try {
    deployRecipes.remove(appId);
    // Its deploy key and saved password go with it.
    deploySecrets?.forget(appId);
  } catch { return { ok: false, error: 'Could not remove it from this computer.' }; }
  await syncDeploys();
  computerChanged();
  return { ok: true, state: deployState() };
}

function installDeployHandlers() {
  ipcMain.handle('1904:deploy-state', async (event) => {
    if (!isDeploySender(event)) return null;
    await syncDeploys().catch(() => false);
    return deployState();
  });
  ipcMain.handle('1904:deploy-save', (event, appId, input) => {
    if (!isDeploySender(event) || typeof appId !== 'string') return null;
    return deployArmed() ? saveDeployRecipe(appId, input) : DEPLOY_NOT_ARMED;
  });
  ipcMain.handle('1904:deploy-remove', (event, appId) => {
    if (!isDeploySender(event) || typeof appId !== 'string') return null;
    return deployArmed() ? removeDeployRecipe(appId) : DEPLOY_NOT_ARMED;
  });
  // Run now: the person's own click in this window, for commands they saved in it. The window only offers it while the
  // form shows exactly what is saved, so what runs is what they are looking at.
  ipcMain.handle('1904:deploy-run', (event, appId) => {
    if (!isDeploySender(event) || typeof appId !== 'string' || !computerBridge) return null;
    if (!deployArmed()) return DEPLOY_NOT_ARMED;
    const started = computerBridge.runDeployNow(appId);
    if (started.ok) showActivity({ focus: false });
    return started.ok ? { ok: true, state: deployState() } : { ok: false, error: started.message };
  });
  ipcMain.handle('1904:deploy-dry-run', (event, appId) => {
    if (!isDeploySender(event) || typeof appId !== 'string' || !computerBridge) return null;
    if (!deployArmed()) return DEPLOY_NOT_ARMED;
    const started = computerBridge.runDeployNow(appId, { dryRun: true });
    return started.ok ? { ok: true, state: deployState() } : { ok: false, error: started.message };
  });
  ipcMain.handle('1904:deploy-check-host', (event, input) => isDeploySender(event) ? checkDeployHost(input).catch(() => ({ ok: false, error: 'Could not check the host.' })) : null);
  ipcMain.handle('1904:deploy-make-key', (event, appId) => {
    if (!isDeploySender(event) || typeof appId !== 'string') return null;
    return deployArmed() ? makeDeployKey(appId) : DEPLOY_NOT_ARMED;
  });
  ipcMain.handle('1904:deploy-install-key', (event, appId, input, password) => {
    if (!isDeploySender(event) || typeof appId !== 'string') return null;
    return deployArmed() ? installDeployKey(appId, input, password).catch(() => ({ ok: false, error: 'Could not add the key on the host.' })) : DEPLOY_NOT_ARMED;
  });
  // Copy the command that adds this app's public key on the host by hand. The key is public; nothing secret is copied.
  ipcMain.on('1904:deploy-copy-install', (event, appId) => {
    if (!isDeploySender(event) || typeof appId !== 'string') return;
    const command = deploySsh.installKeyCommand(deploySecrets?.summary(appId, computerLink?.info()?.id).publicKey);
    if (command) clipboard.writeText(command);
  });
  ipcMain.on('1904:secret-answer', (event, nonce, value) => {
    if (!isSecretSender(event) || !secretPending || nonce !== secretPending.nonce) return;
    settleSecret(deploySsh.cleanPassword(value));
  });
  // The dashboard can open the window, nothing more, and only right after the person typed or clicked in the dashboard
  // with it in front: a page cannot raise this window at a moment of its own choosing.
  ipcMain.on('1904:computer-deploys', (event) => {
    if (!dashboardContents || event.sender !== dashboardContents || event.senderFrame !== event.sender.mainFrame) return;
    if (webUrl(event.senderFrame?.url)?.origin !== ORIGIN) return;
    if (!computerInput.decide({ focused: Boolean(mainWindow?.isFocused()) && Boolean(dashboardContents?.isFocused()) }).stamp) return;
    showDeploys();
  });
}

function installComputerHandlers() {
  ipcMain.handle('1904:computer-state', event => isComputerDashboardSender(event) ? computerState() : null);
  ipcMain.handle('1904:device-info', event => isComputerDashboardSender(event) ? readDeviceInfo() : null);
  // Connecting asks 1904 for a pairing before its question, so the page may start it only right after
  // the person typed or clicked in the window, with it in front.
  ipcMain.handle('1904:computer-connect', event => {
    if (!isComputerDashboardSender(event)) return null;
    if (!computerInput.decide({ focused: Boolean(mainWindow?.isFocused()) && Boolean(dashboardContents?.isFocused()) }).stamp) return computerState();
    return connectComputer();
  });
  ipcMain.handle('1904:computer-away', (event, input) => isComputerDashboardSender(event) ? startAwayFromDashboard(input) : null);
  // Pause from Settings → 1904 Desktop. Pausing only takes access away, so the page may do it at once. Turning
  // Pause off lets requests in again, so that is the person's answer in a dialog of ours, and only right after
  // they typed or clicked in the window with it in front.
  ipcMain.handle('1904:computer-pause', (event, paused) => {
    if (!isComputerDashboardSender(event)) return null;
    if (typeof paused !== 'boolean' || !computerBridge || !computerLink.info() || paused === computerLink.paused()) return computerState();
    if (paused) {
      setComputerPaused(true);
      return computerState();
    }
    if (!computerInput.decide({ focused: Boolean(mainWindow?.isFocused()) && Boolean(dashboardContents?.isFocused()) }).stamp) return computerState();
    computerResuming ??= (async () => {
      try {
        const { response } = await messageBox(resumePrompt(computerLink.info()?.name), computerParent());
        if (response === 1 && computerLink.info() && computerLink.paused()) setComputerPaused(false);
      } catch (error) {
        console.warn('1904 Desktop could not ask about resuming:', error?.message);
      } finally {
        computerResuming = undefined;
      }
      return computerState();
    })();
    return computerResuming;
  });
  // 1904 Desktop itself, for the same Settings page: its version and whether an update is waiting. The check is
  // the one in the Help menu, and its answer is our own dialog; the page hears nothing back.
  ipcMain.handle('1904:app-info', event => isComputerDashboardSender(event)
    ? { version: app.getVersion(), updates: Boolean(menuUpdates), updateReady: Boolean(menuUpdates) && updateReady } : null);
  ipcMain.on('1904:app-check-updates', (event) => {
    if (!isComputerDashboardSender(event) || !menuUpdates) return;
    if (!computerInput.decide({ focused: Boolean(mainWindow?.isFocused()) && Boolean(dashboardContents?.isFocused()) }).stamp) return;
    void menuUpdates.check();
  });
  ipcMain.on('1904:computer-activity', (event) => {
    if (isComputerDashboardSender(event)) showActivity();
  });
  ipcMain.on('1904:show-computer-activity', (event) => {
    if (mainWindow && event.sender === mainWindow.webContents && event.senderFrame === event.sender.mainFrame) showActivity();
  });
  ipcMain.handle('1904:activity-snapshot', (event) => {
    if (!isActivitySender(event)) return null;
    flushActivityOutput();
    return { seq: activityOutputSeq, ...activityState(true) };
  });
  ipcMain.on('1904:activity-stop', (event, id) => {
    if (isActivitySender(event) && computerPolicy.computerId(id)) computerBridge?.stopRun(id);
  });
  ipcMain.on('1904:activity-end-away', (event, id) => {
    if (isActivitySender(event) && computerPolicy.computerId(id)) computerBridge?.endAway(id);
  });
  ipcMain.on('1904:activity-end-allowance', (event, taskId) => {
    if (isActivitySender(event) && typeof taskId === 'string' && /^[a-f0-9]{32}$/.test(taskId)) computerBridge?.endTaskAllowance(taskId);
  });
  ipcMain.on('1904:approval-answer', onApprovalAnswer);
  ipcMain.on('1904:approval-size', onApprovalSize);
  ipcMain.on('1904:activity-pause', (event, paused) => {
    if (isActivitySender(event) && typeof paused === 'boolean' && computerLink?.info()) setComputerPaused(paused);
  });
  ipcMain.handle('1904:activity-folder', async (event, appId, action) => {
    if (!isActivitySender(event) || typeof appId !== 'string') return false;
    const folder = computerFolders().find(entry => entry.appId === appId);
    if (!folder) return false;
    if (action === 'reset') {
      const reset = computerLink.folders.reset(appId);
      computerChanged();
      return reset;
    }
    if (action === 'change') return chooseComputerFolder({ id: appId, name: folder.name, repo: folder.repo }, activityWindow);
    return false;
  });
}

app.setName('1904 Desktop');
if (process.platform === 'win32') app.setAppUserModelId('ai.1904.desktop');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (app.isPackaged) app.setAsDefaultProtocolClient(SCHEME);
  const fromArgs = args => args.map(value => readLink(value, ORIGIN)).find(Boolean);
  queuedLink = fromArgs(process.argv);
  app.on('web-contents-created', (_event, contents) => {
    installNavigationRules(contents);
    installContextMenu(contents, {
      Menu, clipboard, openBrowser,
      windowFor: (target) => (target === dashboardContents ? mainWindow : BrowserWindow.fromWebContents(target)),
    });
  });
  app.on('open-url', (event, url) => { event.preventDefault(); handleLink(readLink(url, ORIGIN)); });
  app.on('second-instance', (_event, args) => { if (!handleLink(fromArgs(args)) && desktopReady) showDashboard(); });
  app.on('activate', () => { if (desktopReady) showDashboard(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  // Commands still running on this computer are stopped, and 1904 told, before the app goes.
  app.on('before-quit', (event) => {
    closeTaskNoticeWindow();
    if (computerQuitting || !computerBridge?.busy()) return;
    event.preventDefault();
    computerQuitting = true;
    void computerBridge.shutdown().finally(() => app.quit());
  });
  void app.whenReady().then(() => {
    accountStore = createAccountStore({ file: path.join(app.getPath('userData'), ACCOUNTS_FILE) });
    installPermissionRules(activePartition());
    menuUpdates = startUpdater(() => mainWindow, () => {
      updateReady = true;
      installMenu();
    });
    startComputer();
    startDesktopBrowser();
    installMenu();
    installChromeHandlers();
    installAccountHandlers();
    installComputerHandlers();
    installDeployHandlers();
    installDesktopBrowserHandlers();
    installSnippetCapture({
      ipcMain, BrowserWindow, desktopCapturer, nativeImage, screen,
      getContents: () => dashboardContents, getWindow: () => mainWindow, is1904: isTaskTitleBarPage,
      permission: () => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
      theme: activeTheme,
    });
    desktopReady = true;
    showDashboard();
    startSmokeReport({ file: process.env.DESKTOP_SMOKE_REPORT, origin: ORIGIN, chrome: () => mainWindow?.webContents, dashboard: () => dashboardContents });
  });
}
