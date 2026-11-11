// What 1904 Desktop does when the dashboard cannot be shown: which failures count,
// how often to try again, where a retry goes, and what the window says meanwhile.
// No Electron in here, so every decision can be tested with plain Node.

const RETRY_CAP_MS = 30_000;
// A second renderer crash this soon after a silent reload is shown instead of retried.
const CRASH_WINDOW_MS = 60_000;

/** Automatic retries: 2 s, 4 s, 8 s, 16 s, then every 30 s. */
function retryDelay(attempts) {
  return Math.min(2000 * 2 ** Math.max(0, Number(attempts) || 0), RETRY_CAP_MS);
}

/** The server answered the page request with an error of its own (500, 502, 503, 52x…). */
function isServerFailure(code) {
  return Number.isInteger(code) && code >= 500 && code <= 599;
}

/** A retry reopens the page that failed, unless that was not a page on the dashboard origin. */
function retryTarget(failedUrl, origin, fallback) {
  try {
    const url = new URL(failedUrl);
    if (url.origin === origin && !url.username && !url.password && !url.pathname.startsWith('/api/')) return url.href;
  } catch {
    // Not a URL: use the fallback.
  }
  return fallback;
}

const COPY = {
  offline: {
    title: 'You’re offline',
    detail: '1904 Desktop reconnects as soon as your connection is back.',
  },
  unreachable: {
    title: 'Can’t reach 1904',
    detail: 'Your connection looks fine, but 1904 did not answer.',
  },
  unavailable: {
    title: '1904 isn’t responding',
    detail: 'This is on our side, not your connection.',
  },
  crashed: {
    title: 'This page stopped working',
    detail: 'Reloading it once did not help. Try again, or restart 1904 Desktop.',
  },
};

/** What the window shows for a recovery state; `null` when the dashboard is back. */
function recoveryView(state) {
  if (!state || !Object.hasOwn(COPY, state.kind)) return null;
  const manual = state.kind === 'crashed';
  return {
    ...COPY[state.kind],
    status: state.trying ? 'Reconnecting…' : manual ? '' : 'Trying again automatically.',
    action: manual ? 'Reload' : 'Try now',
    trying: Boolean(state.trying),
  };
}

module.exports = { CRASH_WINDOW_MS, retryDelay, isServerFailure, retryTarget, recoveryView };
