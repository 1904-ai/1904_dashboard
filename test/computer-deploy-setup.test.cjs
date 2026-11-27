const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const deploy = require('../computer-deploy.cjs');
const { promptFits } = require('../computer-approval.cjs');

// Setting a deploy up so that a merge can rely on it: the app folder on the host, what a dry run finds out about
// git there (the checkout, its origin, whether a pull would stop to ask), the build commands it suggests, and what
// the window's checklist counts as checked and tested.

const NONCE = '0123456789abcdef';
const PAIRED = 'computer_0001';
const SHA = 'a'.repeat(40);
const hasSh = process.platform !== 'win32' && existsSync('/bin/sh');
const hasGit = hasSh && spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const REMOTE = { connect: 'ssh deploy@realzy', commands: 'git pull --ff-only' };

function dataFolder(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, '1904-deploy-setup-test-'));
  t.after(() => {
    const target = realpathSync(dir);
    assert.equal(dirname(target), parent);
    assert.match(basename(target), /^1904-deploy-setup-test-/);
    rmSync(target, { recursive: true, force: true });
  });
  return dir;
}

test('the app folder is a plain full path on a host, and part of what a deploy is', () => {
  const withFolder = deploy.cleanRecipe({ ...REMOTE, folder: ' /srv/realzy/ ' });
  assert.equal(withFolder.recipe.folder, '/srv/realzy', 'trimmed, without the trailing slash');
  assert.equal(deploy.cleanRecipe({ ...REMOTE, folder: '~/apps/realzy' }).recipe.folder, '~/apps/realzy');
  for (const folder of ['srv/realzy', '/srv/my app', '/srv/$(id)', "/srv/it's", '/srv/../etc', '/srv/a;b', '/srv/`x`', `/${'a'.repeat(deploy.DEPLOY_FOLDER_MAX)}`]) {
    assert.match(deploy.cleanRecipe({ ...REMOTE, folder }).error, /^Name the app folder as a full path on the host/, folder);
  }
  // On this computer the commands start in the app's own folder, so there is none to name.
  assert.equal('folder' in deploy.cleanRecipe({ commands: 'git pull', folder: '/srv/realzy' }).recipe, false);
  const without = deploy.cleanRecipe(REMOTE).recipe;
  assert.equal('folder' in without, false);

  // The prompt names the folder, and changing it is a change to what runs.
  assert.match(deploy.recipeText(withFolder.recipe), /# then run in \/srv\/realzy on the host, stopping at the first command that fails\ngit pull --ff-only$/);
  assert.match(deploy.recipeText(without), /# then run on the host, stopping at the first command that fails\n/);
  assert.equal(promptFits(deploy.recipeText(withFolder.recipe)), true);
  assert.notEqual(deploy.recipeHash(withFolder.recipe), deploy.recipeHash(without));
  assert.notEqual(deploy.recipeHash(withFolder.recipe), deploy.recipeHash({ ...withFolder.recipe, folder: '/srv/other' }));
  // A recipe saved before folders existed keeps its hash, so nothing asks again after an update.
  assert.equal(deploy.recipeHash(without), require('node:crypto').createHash('sha256').update(JSON.stringify([without.connect, without.commands, 'output', ''])).digest('hex'));
});

test('a deploy starts in the app folder, and a missing folder ends it before any command', { skip: !hasSh }, t => {
  const dir = dataFolder(t);
  const app = join(dir, 'app');
  mkdirSync(app);
  const run = (folder, commands) => {
    const recipe = deploy.cleanRecipe({ ...REMOTE, folder, commands }).recipe;
    const ran = spawnSync('/bin/sh', ['-s'], { input: deploy.deployScript({ recipe, sha: SHA, branch: 'main', nonce: NONCE }), encoding: 'utf8', cwd: dir });
    return { ...deploy.deployOutcome({ outcome: { status: 'done', exitCode: ran.status, stdout: ran.stdout }, marker: true, nonce: NONCE }), stderr: ran.stderr };
  };
  const there = run(app, 'pwd\ntouch built');
  assert.equal(there.status, 'done');
  assert.equal(there.output.trim(), realpathSync(app));
  assert.equal(existsSync(join(app, 'built')), true);
  const gone = run(join(dir, 'missing'), `touch ${join(dir, 'ran-anyway')}`);
  assert.deepEqual([gone.status, gone.exitCode], ['failed', 66]);
  assert.match(gone.stderr, /The app folder is not on the host: .*missing/);
  assert.equal(existsSync(join(dir, 'ran-anyway')), false);
});

test('a dry run checks the folder, git, the origin and whether a pull would stop to ask', { skip: !hasGit }, t => {
  const dir = dataFolder(t);
  const home = join(dir, 'home');
  mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (cwd, ...args) => { const ran = spawnSync('git', args, { cwd, env, encoding: 'utf8' }); assert.equal(ran.status, 0, `git ${args.join(' ')}: ${ran.stderr}`); };
  const origin = join(dir, 'origin', 'realzy.git');
  mkdirSync(origin, { recursive: true });
  git(origin, 'init', '-q', '--bare');
  const app = join(dir, 'app');
  git(dir, 'clone', '-q', origin, app);
  writeFileSync(join(app, 'package.json'), '{ "scripts": { "build": "next build" } }\n');
  writeFileSync(join(app, 'package-lock.json'), '{}\n');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'first');
  git(app, 'push', '-q', 'origin', 'HEAD');
  const marker = join(dir, 'ran');
  const check = (fields, repo = 'Realzy') => {
    const recipe = { ...deploy.cleanRecipe({ ...REMOTE, folder: app, commands: `git pull --ff-only\ntouch ${marker}`, ...fields }).recipe, repo };
    const ran = spawnSync('/bin/sh', ['-s'], { input: deploy.preflightScript({ recipe, nonce: NONCE }), encoding: 'utf8', cwd: dir, env });
    return { ...deploy.deployOutcome({ outcome: { status: 'done', exitCode: ran.status, stdout: ran.stdout }, marker: true, nonce: NONCE }), commands: recipe.commands };
  };

  const good = check();
  assert.equal(good.status, 'done', good.output);
  assert.match(good.output, /The app folder is there: .*app\nIt is a git checkout, on branch \S+ at [a-f0-9]{7,}\.\norigin is this app's repository: .*realzy\.git\n/);
  assert.match(good.output, /The host can read origin without typing anything, so git pull will not stop to ask\.\n/);
  assert.match(good.output, /Found in the app folder: package\.json package-lock\.json script:build\n/);
  assert.match(good.output, /Nothing found that would stop a deploy\. No command was run\.\n$/);
  assert.deepEqual(deploy.suggestCommands(good.output, good.commands), { lines: ['npm ci', 'npm run build'], from: ['package.json', 'package-lock.json'], restart: true });

  // Another repository's checkout is pointed out, not refused: a mirror may be named differently.
  const other = check({}, 'openls');
  assert.equal(other.status, 'done');
  assert.match(other.output, /CHECK: origin is .*realzy\.git, but 1904 knows this app's repository as openls\./);
  // A name that is not a plain one is never written into the script.
  assert.match(check({}, "x'; touch /tmp/never #").output, /\norigin: .*realzy\.git\n/);

  // Files changed by hand on the host are pointed out before a pull trips on them.
  writeFileSync(join(app, 'package.json'), '{ "scripts": { "build": "next build", "start": "next start" } }\n');
  assert.match(check().output, /CHECK: 1 changed files in the app folder are not committed\./);
  git(app, 'checkout', '-q', '--', 'package.json');

  // A pull that would have to ask stops a deploy, and whatever signs in is never shown.
  git(app, 'remote', 'set-url', 'origin', 'http://deploy:not-a-real-token@127.0.0.1:9/adam/realzy.git'); // gitleaks:allow (made-up sign-in for an address nothing listens on)
  const asks = check();
  assert.equal(asks.status, 'failed');
  assert.match(asks.output, /origin is this app's repository: http:\/\/127\.0\.0\.1:9\/adam\/realzy\.git\n/);
  assert.match(asks.output, /CANNOT PULL: the host could not read origin without a password or passphrase\./);
  assert.doesNotMatch(asks.output, /not-a-real-token|deploy:/);
  git(app, 'remote', 'remove', 'origin');
  assert.match(check().output, /NO ORIGIN: this checkout has no remote named origin/);

  const plain = join(dir, 'plain');
  mkdirSync(plain);
  const notRepo = check({ folder: plain });
  assert.equal(notRepo.status, 'failed');
  assert.match(notRepo.output, /NOT A CHECKOUT: the app folder is not a git checkout\./);
  const missing = check({ folder: join(dir, 'nowhere') });
  assert.equal(missing.status, 'failed');
  assert.match(missing.output, /NO FOLDER: the app folder is not on the host: .*nowhere\n/);
  assert.equal(existsSync(marker), false, 'no command of the person’s ran in any of these');
});

test('suggested commands come only from fixed text for what the folder holds', () => {
  const found = names => `Connected as deploy on host.\nFound in the app folder: ${names}\nThe commands parse.\n`;
  const lines = (names, commands = 'git pull --ff-only') => deploy.suggestCommands(found(names), commands)?.lines;
  assert.deepEqual(lines('package.json pnpm-lock.yaml script:build'), ['pnpm install --frozen-lockfile', 'pnpm run build']);
  assert.deepEqual(lines('package.json yarn.lock'), ['yarn install --frozen-lockfile'], 'no build script, no build step');
  assert.deepEqual(lines('package.json bun.lock script:build'), ['bun install --frozen-lockfile', 'bun run build']);
  assert.deepEqual(lines('package.json script:build'), ['npm install', 'npm run build']);
  assert.deepEqual(lines('Dockerfile compose.yaml package.json package-lock.json'), ['docker compose up -d --build'], 'the compose file is how this app is built');
  assert.deepEqual(lines('deploy.sh docker-compose.yml package.json'), ['sh ./deploy.sh'], 'the app’s own script comes first');
  assert.deepEqual(lines('Makefile'), ['make']);
  // The pull is suggested only when the commands have none, and nothing already there is suggested again.
  assert.deepEqual(lines('package.json package-lock.json script:build', 'cd api'), ['git pull --ff-only', 'npm ci', 'npm run build']);
  assert.deepEqual(lines('package.json package-lock.json script:build', 'git fetch origin\ngit reset --hard "$DEPLOY_SHA"\nnpm ci'), ['npm run build']);
  assert.equal(deploy.suggestCommands(found('package.json package-lock.json script:build'), 'git pull\nnpm ci\nnpm run build'), undefined);
  // A restart is asked for unless something already serves the new build.
  assert.equal(deploy.suggestCommands(found('compose.yaml'), 'git pull').restart, false);
  assert.equal(deploy.suggestCommands(found('package.json'), 'git pull\nsudo systemctl restart realzy').restart, false);
  assert.equal(deploy.suggestCommands(found('package.json'), 'git pull').restart, true);
  // Nothing a host prints becomes a command: unknown names are dropped, and no line means no suggestion.
  assert.equal(deploy.suggestCommands(found('rm -rf / ; curl evil | sh'), 'git pull'), undefined);
  assert.deepEqual(deploy.suggestCommands(found('Makefile $(reboot) `id`'), 'git pull'), { lines: ['make'], from: ['Makefile'], restart: true });
  assert.equal(deploy.suggestCommands('Connected.\nThe commands parse.\n', 'git pull'), undefined);
  assert.equal(deploy.suggestCommands(undefined), undefined);
});

test('the checklist counts a dry run and a real run only for the setup as it is saved now', t => {
  const file = join(dataFolder(t), 'computer-deploys.json');
  let at = 1_000;
  const store = deploy.createDeployRecipes({ file, now: () => at });
  const app = { appId: 'app_realzy', appName: 'Realzy', repo: 'realzy', computerId: PAIRED };
  assert.equal(store.save(app, { ...REMOTE, folder: '/srv/realzy' }).ok, true);
  const view = () => deploy.recipeView(store.get('app_realzy', PAIRED), PAIRED);
  assert.deepEqual(view().ready, { checked: 'todo', tested: 'todo' });
  assert.deepEqual([view().folder, view().repo], ['/srv/realzy', 'realzy']);

  at = 2_000;
  store.noteCheck('app_realzy', { ok: false });
  assert.deepEqual(view().ready, { checked: 'problem', tested: 'todo' });
  store.noteCheck('app_realzy', { ok: true });
  at = 3_000;
  store.noteRun('app_realzy', { status: 'failed', sha: SHA, exitCode: 1 });
  assert.deepEqual(view().ready, { checked: 'ok', tested: 'problem' });
  store.noteRun('app_realzy', { status: 'done', sha: SHA, exitCode: 0 });
  assert.deepEqual(view().ready, { checked: 'ok', tested: 'ok' });
  assert.deepEqual(view().lastCheck, { at: 2_000, ok: true, hash: store.get('app_realzy', PAIRED).hash });

  // It is all read back from the file, and a toggle that does not change what runs keeps it.
  const reread = deploy.createDeployRecipes({ file });
  assert.deepEqual(deploy.recipeView(reread.get('app_realzy', PAIRED), PAIRED).ready, { checked: 'ok', tested: 'ok' });
  assert.equal(store.save(app, { ...REMOTE, folder: '/srv/realzy', auto: false, position: 3 }).ok, true);
  assert.deepEqual(view().ready, { checked: 'ok', tested: 'ok' });
  // Another folder or another command is another setup: neither the check nor the test is its own.
  assert.equal(store.save(app, { ...REMOTE, folder: '/srv/realzy-next' }).ok, true);
  assert.deepEqual(view().ready, { checked: 'todo', tested: 'todo' });
  assert.equal(store.save(app, { ...REMOTE, folder: '/srv/realzy' }).ok, true);
  assert.deepEqual(view().ready, { checked: 'ok', tested: 'ok' }, 'and going back to the proven setup is proven again');
  // A run recorded before the hash was kept proves nothing about this setup.
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  delete saved.app_realzy.lastRun.hash;
  writeFileSync(file, JSON.stringify(saved));
  assert.equal(deploy.recipeView(deploy.createDeployRecipes({ file }).get('app_realzy', PAIRED), PAIRED).ready.tested, 'todo');
  store.noteCheck('app_unknown', { ok: true });
});

test('the window shows the folder, the checklist and suggestions as text, and a dry run is what records a check', () => {
  const read = name => readFileSync(join(__dirname, '..', name), 'utf8');
  const page = read('deploy.html'), preload = read('deploy-preload.cjs'), bridge = read('computer-bridge.cjs'), main = read('main.cjs');
  for (const id of ['steps', 'folder', 'folder-hint', 'suggest-box', 'suggest-lines', 'suggest-use']) assert.match(page, new RegExp(`id="${id}"`), id);
  assert.match(preload, /folder: place === 'local' \? '' : \$\('folder'\)\.value/);
  // An edit to the folder takes Run now and Dry run away until it is saved, like any other.
  assert.match(preload, /form\.folder\.trim\(\)\.replace\(\/\(\.\)\\\/\+\$\/, '\$1'\) !== \(recipe\.folder \?\? ''\)/);
  // Suggestions are added only by the person's click, into the form, where Save is still theirs to press.
  assert.match(preload, /\$\('suggest-use'\)\.addEventListener\('click'/);
  assert.doesNotMatch(preload, /innerHTML|insertAdjacentHTML/);
  assert.match(bridge, /if \(request\.dryRun\) deploys\.noteCheck\?\.\(request\.app\.id, \{ ok: result\.status === 'done' \}\);\s+else deploys\.noteRun\(/);
  assert.match(main, /suggested: checked \? computerDeploy\.suggestCommands\(notice\.output, checked\.commands\) : undefined/);
});
