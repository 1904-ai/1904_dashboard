const { app, dialog } = require('electron');
const { existsSync, unlinkSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

function startUpdater(getWindow, onReady) {
  if (!app.isPackaged || !existsSync(join(process.resourcesPath, 'app-update.yml'))) return;

  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;

  let downloadedVersion;
  let checkingManually = false;
  // Remember only that we should check immediately. The updater revalidates
  // the cached payload before exposing it to the installer.
  const pendingFile = join(app.getPath('userData'), 'update-pending');
  autoUpdater.on('update-downloaded', ({ version }) => {
    downloadedVersion = version;
    try { writeFileSync(pendingFile, version, { mode: 0o600 }); }
    catch { console.warn('1904 Desktop could not save its pending update status.'); }
    onReady();
  });
  autoUpdater.on('update-not-available', () => {
    try { unlinkSync(pendingFile); }
    catch (error) { if (error.code !== 'ENOENT') console.warn('1904 Desktop could not clear its pending update status.'); }
  });
  autoUpdater.on('error', (error) => console.warn('1904 Desktop update failed:', error.message));

  function checkInBackground() {
    void autoUpdater.checkForUpdates().catch(() => {
      // The updater emits an error event for failed background checks.
    });
  }

  setTimeout(checkInBackground, existsSync(pendingFile) ? 0 : 15000 + Math.random() * 45000).unref();
  setInterval(checkInBackground, 6 * 60 * 60 * 1000 + Math.random() * 1200000).unref();

  function show(options) {
    const win = getWindow();
    return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
  }

  async function checkForUpdates() {
    if (checkingManually) return;
    checkingManually = true;
    try {
      if (!downloadedVersion) {
        const result = await autoUpdater.checkForUpdates();
        await result?.downloadPromise;
      }
      if (!downloadedVersion) {
        await show({ type: 'info', message: '1904 Desktop is up to date', detail: `Version ${app.getVersion()}` });
        return;
      }
      const { response } = await show({
        type: 'info', message: `1904 Desktop ${downloadedVersion} is ready`,
        detail: 'Restart the app to update, or install the update the next time you quit.',
        buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      });
      if (response === 0) autoUpdater.quitAndInstall();
    } catch {
      await show({ type: 'warning', message: 'Could not update 1904 Desktop', detail: 'Check your connection and try again.' });
    } finally {
      checkingManually = false;
    }
  }
  return { check: checkForUpdates, install: checkForUpdates };
}

module.exports = { startUpdater };
