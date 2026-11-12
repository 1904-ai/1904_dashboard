const { build, version } = require('../package.json');

function requireSetting(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for a signed desktop release`);
  return value;
}

function httpsSetting(name) {
  const url = new URL(requireSetting(name));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTPS URL without credentials, query parameters, or a fragment`);
  }
  return url.href.replace(/\/+$/, '');
}

if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Set a stable version before building this release');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) {
  throw new Error(`The release tag must match package.json (v${version})`);
}

const windows = process.platform === 'win32' && process.arch === 'x64';
const mac = process.platform === 'darwin' && ['x64', 'arm64'].includes(process.arch);
if (!windows && !mac) throw new Error('Use a native Windows x64, Intel Mac, or Apple Silicon Mac runner');

const publish = { provider: 'github', owner: '1904-ai', repo: '1904_dashboard' };

// Electron Builder flips these in each build right before signing it (on a universal Mac build, after
// merging both architectures); scripts/verify-release.cjs reads them back from the signed app.
// - No ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect: nothing can start the signed app as Node.js or
//   attach a debugger to the main process, which holds this computer's Use My Computer keys.
//   (startup-guard.cjs refuses Chromium's debugging switches, which have no fuse.)
// - Code only from the signed app.asar, checked against the hash embedded in the signed executable.
// - Cookies encrypted with the system key store, like the keys. One-way: a build without this fuse
//   cannot read cookies written with it, so its users would have to sign in again.
// - file:// keeps Electron's extra privileges for now: without them, loadFile cannot read the title bar
//   and other local pages from inside app.asar (ERR_FILE_NOT_FOUND). Turn it off once those pages are
//   served from a custom protocol instead; the release launch check fails if the title bar cannot load.
const electronFuses = {
  runAsNode: false,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
  enableCookieEncryption: true,
  grantFileProtocolExtraPrivileges: true,
};

const config = { ...build, forceCodeSigning: true, publish, electronFuses };
if (windows) {
  config.win = {
    ...build.win,
    verifyUpdateCodeSignature: true,
    azureSignOptions: {
      publisherName: requireSetting('DESKTOP_WINDOWS_PUBLISHER'),
      endpoint: httpsSetting('DESKTOP_SIGNING_ENDPOINT'),
      codeSigningAccountName: requireSetting('DESKTOP_SIGNING_ACCOUNT'),
      certificateProfileName: requireSetting('DESKTOP_SIGNING_PROFILE'),
    },
  };
} else {
  for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER']) {
    requireSetting(name);
  }
  config.mac = { ...build.mac, target: 'zip', hardenedRuntime: true, notarize: true };
}

module.exports = config;
