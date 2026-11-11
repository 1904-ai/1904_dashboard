const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const { CRASH_WINDOW_MS, retryDelay, isServerFailure, retryTarget, recoveryView } = require('../desktop-recovery.cjs');

const origin = 'https://1904.ai';
const agents = `${origin}/agents`;

test('automatic retries back off and settle at thirty seconds', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 50].map(retryDelay), [2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(retryDelay(undefined), 2000);
  assert.equal(retryDelay(-3), 2000);
  assert.ok(CRASH_WINDOW_MS >= 30000);
});

test('only an error answered by the server counts as a server failure', () => {
  for (const code of [500, 502, 503, 504, 520, 524, 530]) assert.equal(isServerFailure(code), true, String(code));
  for (const code of [-1, 0, 200, 204, 302, 401, 403, 404, 429, 600, '503', undefined]) assert.equal(isServerFailure(code), false, String(code));
});

test('a retry reopens the failed page, and never an endpoint or another origin', () => {
  const task = `${agents}?task=${'a'.repeat(32)}`;
  assert.equal(retryTarget(task, origin, agents), task);
  assert.equal(retryTarget(`${origin}/settings/billing`, origin, agents), `${origin}/settings/billing`);
  for (const url of [
    `${origin}/api/auth/desktop/exchange`,
    'https://1904.ai.example.com/agents',
    'https://name:password@1904.ai/agents',
    'http://1904.ai/agents',
    'data:text/html,offline',
    'chrome-error://chromewebdata/',
    '',
    undefined,
  ]) {
    assert.equal(retryTarget(url, origin, agents), agents, String(url));
  }
});

test('the window says what is wrong, whose side it is on, and what happens next', () => {
  assert.equal(recoveryView(undefined), null);
  assert.equal(recoveryView({ kind: 'constructor' }), null);
  const offline = recoveryView({ kind: 'offline', trying: false });
  assert.match(offline.title, /offline/);
  assert.equal(offline.status, 'Trying again automatically.');
  assert.equal(offline.action, 'Try now');
  const down = recoveryView({ kind: 'unavailable', trying: false });
  assert.match(down.detail, /on our side/);
  assert.doesNotMatch(down.detail, /Check your connection/i);
  assert.notEqual(recoveryView({ kind: 'unreachable' }).title, down.title);
  const trying = recoveryView({ kind: 'unavailable', trying: true });
  assert.deepEqual([trying.status, trying.trying], ['Reconnecting…', true]);
  const crashed = recoveryView({ kind: 'crashed', trying: false });
  assert.deepEqual([crashed.status, crashed.action], ['', 'Reload'], 'a page that keeps crashing waits for the person');
});

test('the main process recovers in place instead of loading an error page', () => {
  const main = readFileSync(join(__dirname, '..', 'main.cjs'), 'utf8');
  assert.doesNotMatch(main, /data:text\/html/, 'no stand-in page replaces the dashboard');
  assert.match(main, /isServerFailure\(httpResponseCode\) && url !== challengeUrl/, 'a server error on the page is recovered, a challenge is shown');
  assert.match(main, /if \(repeated\) startRecovery\('crashed'/, 'the first renderer crash reloads silently');
  assert.match(main, /kind === 'crashed' \? undefined : setTimeout\(retryNow/, 'a crash loop is never retried on a timer');
  const page = readFileSync(join(__dirname, '..', 'chrome.html'), 'utf8');
  assert.match(page, /<main id="recovery" hidden>/);
  assert.doesNotMatch(page, /<script/, 'the title bar page stays script-free under its content security policy');
});
