// Source selection stays in the main process. The page never receives a source list or an automatic grant.
function installScreenCapture(profile, { getContents, getWindow, desktopCapturer, Menu, is1904, onError }) {
  let picking = false;
  const allowed = (contents, origin, isMainFrame) => Boolean(
    contents && contents === getContents() && !contents.isDestroyed() &&
    isMainFrame && is1904(contents.getURL()) && is1904(origin),
  );
  profile.setDisplayMediaRequestHandler((request, callback) => {
    const contents = getContents();
    const frame = request.frame;
    const initialUrl = frame?.url;
    const current = () => allowed(contents, request.securityOrigin, frame && frame === contents?.mainFrame) &&
      frame.url === initialUrl;
    if (picking || !request.userGesture || !request.videoRequested || request.audioRequested || !current()) {
      callback(null);
      return;
    }
    picking = true;
    let answered = false;
    const finish = source => {
      if (answered) return;
      answered = true;
      picking = false;
      // A navigation or window close while the picker was open revokes the request.
      try { callback(source && current() ? { video: source } : null); } catch {}
    };
    void desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).then(sources => {
      if (!current()) { finish(); return; }
      const win = getWindow();
      if (!win || win.isDestroyed() || !sources.length) { finish(); return; }
      const group = (label, prefix) => ({
        label,
        submenu: sources.filter(source => source.id.startsWith(prefix)).map(source => ({
          label: source.name.replaceAll('&', '&&'), click: () => finish(source),
        })),
      });
      const groups = [group('Screens', 'screen:'), group('Windows', 'window:')].filter(item => item.submenu.length);
      Menu.buildFromTemplate([
        { label: 'Choose what to attach', enabled: false },
        ...groups, { type: 'separator' }, { label: 'Cancel', click: () => finish() },
      ]).popup({ window: win, callback: () => finish() });
    }).catch(() => {
      finish();
      onError();
    });
  }, { useSystemPicker: true });
  return allowed;
}

module.exports = { installScreenCapture };
