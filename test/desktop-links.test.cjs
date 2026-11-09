const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { readLink, repositorySetupUrl, startSignIn, taskUrl } = require('../desktop-links.cjs');

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

test('repository import deep links open a fixed destination without parameters', () => {
  assert.deepEqual(readLink('app-1904://import', origin), { importRepository: true });
  for (const link of [
    'app-1904://import/other',
    'app-1904://import?url=https://example.com',
    'app-1904://import#other',
    'app-1904://user@import',
  ]) assert.equal(readLink(link, origin), null, link);
});

test('only the signed-state setup URL can open the import handoff in the browser', () => {
  const setup = 'payload.' + 's'.repeat(43);
  const route = '/desktop/repository-import?setup=' + setup;
  assert.equal(repositorySetupUrl(origin + route, origin).href, origin + route);
  for (const url of [
    'https://1904.ai.example.com' + route,
    'https://user@1904.ai' + route,
    origin + route + '&next=https://example.com',
    origin + route + '#other',
    origin + '/desktop/repository-import?github=connected',
    origin + '/desktop/repository-import?setup=invalid',
  ]) assert.equal(repositorySetupUrl(url, origin), null, url);
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
