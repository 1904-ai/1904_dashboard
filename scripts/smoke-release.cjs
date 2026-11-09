const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { _electron: electron } = require('playwright');

async function smoke(executablePath) {
  assert.ok(executablePath, 'Pass the packaged application executable');
  const profile = mkdtempSync(join(tmpdir(), '1904-desktop-smoke-'));
  let desktop;
  try {
    desktop = await electron.launch({ executablePath, args: [`--user-data-dir=${profile}`], timeout: 30000 });
    let chrome;
    let dashboard;
    for (let i = 0; i < 60; i++) {
      const views = desktop.windows();
      chrome = views.find(page => page.url().endsWith('/chrome.html'));
      dashboard = views.find(page => page.url().startsWith('https://1904.ai/'));
      if (chrome && dashboard) break;
      await sleep(500);
    }
    assert.ok(chrome && dashboard, 'The title bar and hosted dashboard must both open');
    await chrome.getByRole('button', { name: 'Application menu' }).waitFor({ timeout: 15000 });
    await dashboard.waitForURL(url => url.pathname === '/login' && url.searchParams.get('returnTo') === '/agents');
    await dashboard.locator('input[type=email]').first().waitFor({ timeout: 15000 });
    assert.equal(await dashboard.evaluate(() => typeof globalThis.require), 'undefined');
    console.log('Packaged app opened its title bar and the live 1904 sign-in page.');
  } finally {
    await desktop?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
  }
}

smoke(process.argv[2]).catch(error => { console.error(error); process.exitCode = 1; });
