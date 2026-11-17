const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PAGE = path.join(__dirname, 'snippet-capture.html');
const PAGE_URL = pathToFileURL(PAGE).href;
const MAX_BYTES = 4 * 1024 * 1024;
const THUMBNAIL_SIZE = { width: 2048, height: 2048 };

// Crop the immutable snapshot in the main process. The hosted page never receives source IDs or frames.
function encodeSelection(image, rect) {
  if (!image || !rect) return null;
  const { x, y, width, height } = rect;
  const size = image.getSize();
  if (![x, y, width, height].every(Number.isSafeInteger) || x < 0 || y < 0 ||
      width < 2 || height < 2 || x + width > size.width || y + height > size.height) return null;

  const crop = image.crop({ x, y, width, height });
  if (crop.isEmpty()) return null;
  let bytes = crop.toPNG();
  let mime = 'image/png';
  if (bytes.length > MAX_BYTES) {
    bytes = crop.toJPEG(90);
    mime = 'image/jpeg';
  }
  if (!bytes.length || bytes.length > MAX_BYTES) return null;
  return { mime, data: bytes.toString('base64') };
}

function installSnippetCapture({ ipcMain, BrowserWindow, desktopCapturer, nativeImage, screen,
  getContents, getWindow, is1904, permission, theme }) {
  let active;
  const captureSources = type => desktopCapturer.getSources({ types: [type], thumbnailSize: THUMBNAIL_SIZE });
  const senderAllowed = (contents, frame) => contents && contents === getContents() &&
    !contents.isDestroyed() && frame && frame === contents.mainFrame && is1904(frame.url);

  ipcMain.handle('1904:snippet-start', (event, requestId) => {
    const { sender, senderFrame } = event;
    if (!senderAllowed(sender, senderFrame) || !getWindow()?.isFocused() ||
        typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) return null;
    if (active) return { error: 'busy' };

    return new Promise(resolve => {
      const url = senderFrame.url;
      const session = { sender, senderFrame, requestId, displaySources: [], windows: [], revision: 0 };
      const current = () => active === session && senderAllowed(sender, senderFrame) && senderFrame.url === url;
      const finish = result => {
        if (active !== session) return;
        const answer = current() ? result : null;
        active = undefined;
        clearTimeout(timer);
        sender.removeListener('did-start-navigation', navigate);
        sender.removeListener('render-process-gone', cancel);
        sender.removeListener('destroyed', cancel);
        screen.removeListener('display-removed', cancel);
        screen.removeListener('display-metrics-changed', cancel);
        session.displaySources = [];
        session.windows = [];
        session.image = undefined;
        if (session.window && !session.window.isDestroyed()) session.window.destroy();
        resolve(answer);
      };
      const cancel = () => finish(null);
      const navigate = details => { if (details.isMainFrame) cancel(); };
      const timer = setTimeout(cancel, 5 * 60 * 1000);
      active = Object.assign(session, { current, finish });
      sender.on('did-start-navigation', navigate);
      sender.once('render-process-gone', cancel);
      sender.once('destroyed', cancel);
      screen.on('display-removed', cancel);
      screen.on('display-metrics-changed', cancel);

      const prepare = async () => {
        if (['denied', 'restricted'].includes(permission())) return finish({ error: 'permission' });
        const displays = screen.getAllDisplays();
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
        const sources = await captureSources('screen');
        if (!current()) return cancel();
        if (permission() !== 'granted') return finish({ error: 'permission' });

        session.displaySources = displays.flatMap((item, index) => {
          const source = sources.find(row => row.display_id === String(item.id)) ??
            (displays.length === 1 && sources.length === 1 ? sources[0] : undefined);
          return source && !source.thumbnail.isEmpty() ?
            [{ display: item, title: `Display ${index + 1}`, thumbnail: source.thumbnail }] : [];
        });

        const initial = session.displaySources.findIndex(item => item.display.id === display.id);
        if (initial < 0) return finish({ error: 'unavailable' });

        session.displayIndex = initial;
        setImage(session, session.displaySources[initial].thumbnail);
        const window = new BrowserWindow({
          ...display.bounds, show: false, frame: false, skipTaskbar: true, resizable: false,
          movable: false, fullscreenable: false, alwaysOnTop: true, title: 'Take a snippet',
          backgroundColor: '#121416',
          webPreferences: {
            sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
            devTools: false, preload: path.join(__dirname, 'snippet-preload.cjs'),
          },
        });
        session.window = window;
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-frame-navigate', event => event.preventDefault());
        window.webContents.once('render-process-gone', () => finish({ error: 'unavailable' }));
        window.once('closed', cancel);
        await window.loadFile(PAGE);
        if (!current() || !getWindow()?.isFocused()) return cancel();
        window.show();
        window.focus();
      };

      void prepare().catch(() => finish({ error: permission() === 'granted' ? 'unavailable' : 'permission' }));
    });
  });

  function setImage(session, thumbnail) {
    // Normalize representations so the preview and crop use the same pixel grid on HiDPI displays.
    session.image = nativeImage.createFromBuffer(thumbnail.toPNG({ scaleFactor: 1 }));
    session.revision += 1;
  }

  function snapshot(session) {
    return {
      image: session.image.toDataURL(), ...session.image.getSize(), revision: session.revision,
      theme: theme(), displayIndex: session.displayIndex,
      displays: session.displaySources.map(item => item.title),
    };
  }

  ipcMain.on('1904:snippet-cancel', (event, requestId) => {
    if (active && active.sender === event.sender && active.senderFrame === event.senderFrame &&
        active.requestId === requestId) active.finish(null);
  });

  ipcMain.handle('1904:snippet-overlay', async (event, action, input) => {
    const session = active;
    if (!session?.window || session.window.isDestroyed() || event.sender !== session.window.webContents ||
        event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url !== PAGE_URL || !session.current()) return null;
    if (action === 'initial') return snapshot(session);
    if (action === 'cancel') return session.finish(null);
    if (action === 'attach') {
      if (input?.revision !== session.revision) return null;
      const answer = encodeSelection(session.image, input?.rect);
      if (!answer) return { error: 'Could not create the snippet. Reselect the area and try again.' };
      session.finish(answer);
      return null;
    }
    if (action === 'display') {
      const source = Number.isSafeInteger(input) && session.displaySources[input];
      if (!source) return null;
      session.displayIndex = input;
      setImage(session, source.thumbnail);
      session.window.setBounds(source.display.bounds);
      return snapshot(session);
    }
    if (action === 'windows') {
      const ownWindow = session.window.getMediaSourceId().split(':')[1];
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
      if (!session.current()) return null;
      session.windows = sources.filter(item => item.id.split(':')[1] !== ownWindow);
      return session.windows.map(item => item.name);
    }
    if (action === 'window') {
      const choice = Number.isSafeInteger(input) && session.windows[input];
      if (!choice) return null;
      const sources = await captureSources('window');
      if (!session.current()) return null;
      const source = sources.find(item => item.id === choice.id && item.name === choice.name);
      if (!source || source.thumbnail.isEmpty()) return { error: 'That window is unavailable. Choose another source.' };
      setImage(session, source.thumbnail);
      return snapshot(session);
    }
    return null;
  });
}

module.exports = { installSnippetCapture, encodeSelection };
