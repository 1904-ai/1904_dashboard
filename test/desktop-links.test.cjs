const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { readLink, startSignIn, taskUrl } = require('../desktop-links.cjs');

const origin = 'https://1904.ai';
const task = 'a'.repeat(32);
const taskPath = `/agents?task=${task}`;

test('task links resolve only to supported paths on the exact dashboard origin', () => {
  assert.equal(taskUrl(taskPath, origin).href, origin + taskPath);
  assert.equal(taskUrl(`/agents-beta2?task=${task}`, origin).href, origin + taskPath);
  for (const url of [
    `https://1904.ai.example.com${taskPath}`,
    `//example.com${taskPath}`,
    `http://1904.ai${taskPath}`,
    `https://1904.ai:444${taskPath}`,
    `https://name:password@1904.ai${taskPath}`,
    `/login?task=${task}`,
    '/agents?task=invalid',
    'javascript:alert(1)',
  ]) {
    assert.equal(taskUrl(url, origin), null, url);
  }
});

test('the desktop protocol applies the same task destination checks', () => {
  const deepLink = url => `app-1904://task?url=${encodeURIComponent(url)}`;
  assert.deepEqual(readLink(deepLink(origin + taskPath), origin), { target: origin + taskPath });
  assert.equal(readLink(deepLink(`https://example.com${taskPath}`), origin), null);
  assert.equal(readLink(deepLink(origin + taskPath) + '#unexpected', origin), null);
});

test('browser sign-in sends a challenge and accepts only well-formed callback tokens', () => {
  const attempt = startSignIn(origin);
  const signIn = new URL(attempt.url);
  assert.equal(signIn.origin + signIn.pathname, origin + '/desktop/sign-in');
  assert.equal(signIn.searchParams.get('state'), attempt.state);
  assert.equal(signIn.searchParams.get('challenge'), createHash('sha256').update(attempt.verifier).digest('hex'));
  assert.equal(signIn.searchParams.has('verifier'), false);

  const code = 'b'.repeat(64);
  const callback = `app-1904://auth?code=${code}&state=${attempt.state}`;
  assert.deepEqual(readLink(callback, origin), { code, state: attempt.state });
  assert.equal(readLink(`app-1904://auth?code=${code}&state=invalid`, origin), null);
});
