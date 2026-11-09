const { createHash, randomBytes } = require('node:crypto');

const SCHEME = 'app-1904';
const TOKEN = /^[a-f0-9]{64}$/;
const token = () => randomBytes(32).toString('hex');

function taskUrl(value, origin) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password ||
        !['/agents', '/agents-beta2'].includes(url.pathname) ||
        !/^[a-f0-9]{32}$/i.test(url.searchParams.get('task') || '')) return null;
    url.pathname = '/agents';
    return url;
  } catch {
    return null;
  }
}

function readLink(value, origin) {
  if (typeof value !== 'string' || !value.startsWith(SCHEME + '://') || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.port || url.hash || (url.pathname && url.pathname !== '/')) return null;
    if (url.hostname === 'task') {
      const target = taskUrl(url.searchParams.get('url'), origin);
      return target ? { target: target.href } : null;
    }
    const code = url.searchParams.get('code'), state = url.searchParams.get('state');
    return url.hostname === 'auth' && TOKEN.test(code || '') && TOKEN.test(state || '') ? { code, state } : null;
  } catch {
    return null;
  }
}

function startSignIn(origin) {
  const state = token(), verifier = token();
  const challenge = createHash('sha256').update(verifier).digest('hex');
  const url = new URL('/desktop/sign-in', origin);
  url.search = new URLSearchParams({ state, challenge }).toString();
  return { state, verifier, url: url.href, expiresAt: Date.now() + 15 * 60_000 };
}

module.exports = { SCHEME, taskUrl, readLink, startSignIn };
