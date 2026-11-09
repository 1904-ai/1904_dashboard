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

const config = { ...build, forceCodeSigning: true, publish };
if (windows) {
  for (const name of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) requireSetting(name);
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
