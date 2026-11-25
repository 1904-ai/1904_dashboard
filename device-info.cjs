const os = require('node:os');
const { execFile } = require('node:child_process');

/**
 * Non-sensitive OS and hardware model summary for 1904 Desktop's optional product usage tracking.
 * Deliberately excludes hostname, username, serial numbers, MAC addresses, and local paths.
 */
function friendlyOsName(platform = process.platform) {
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  if (platform === 'linux') return 'Linux';
  return String(platform || 'Desktop');
}

function cleanText(value, max = 80) {
  return typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
    : '';
}

function readHardwareModel(platform = process.platform, run = execFile) {
  return new Promise(resolve => {
    if (platform === 'darwin') {
      run('/usr/sbin/sysctl', ['-n', 'hw.model'], { timeout: 2000 }, (error, stdout) => {
        resolve(error ? '' : cleanText(String(stdout)));
      });
      return;
    }
    if (platform === 'win32') {
      run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystem).Model'],
        { timeout: 3000 },
        (error, stdout) => {
          resolve(error ? '' : cleanText(String(stdout)));
        },
      );
      return;
    }
    resolve('');
  });
}

function readOsVersion(platform = process.platform, run = execFile, fallbackRelease = os.release()) {
  if (platform === 'darwin') {
    return new Promise(resolve => {
      run('/usr/bin/sw_vers', ['-productVersion'], { timeout: 2000 }, (error, stdout) => {
        resolve(error ? cleanText(fallbackRelease, 40) : cleanText(String(stdout), 40));
      });
    });
  }
  return Promise.resolve(cleanText(fallbackRelease, 40));
}

function createDeviceInfoReader({ platform = process.platform, arch = process.arch, release = os.release(), run = execFile } = {}) {
  let cached;
  return () => {
    cached ??= Promise.all([
      readOsVersion(platform, run, release),
      readHardwareModel(platform, run),
    ]).then(([osVersion, deviceModel]) => ({
      osName: friendlyOsName(platform),
      ...(osVersion ? { osVersion } : {}),
      ...(arch ? { arch: cleanText(arch, 24) } : {}),
      ...(deviceModel ? { deviceModel } : {}),
    }));
    return cached;
  };
}

module.exports = { createDeviceInfoReader, friendlyOsName, cleanText };
