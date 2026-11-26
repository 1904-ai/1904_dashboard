const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const ssh = require('../computer-deploy-ssh.cjs');
const deploy = require('../computer-deploy.cjs');

// Reaching a host: what the person may type, how ssh is started, and what is kept.

const PAIRED = 'computer_0001';
const NONCE = '0123456789abcdef';
const KEY = 'AAAAC3NzaC1lZDI1NTE5AAAAIJ' + 'x'.repeat(42);
const line = (pattern = 'deploy.example.com') => `${pattern} ssh-ed25519 ${KEY}`;
const hasSh = process.platform !== 'win32' && existsSync('/bin/sh');
// Not a key: a stand-in with a key file's first and last lines, put together here so no scanner mistakes it for one.
const FAKE_PRIVATE_KEY = ['-----BEGIN OPENSSH', 'PRIVATE KEY-----'].join(' ') + '\nnot-a-real-key\n' + ['-----END OPENSSH', 'PRIVATE KEY-----'].join(' '); // gitleaks:allow

function dataFolder(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, '1904-deploy-ssh-test-'));
  t.after(() => {
    const target = realpathSync(dir);
    assert.equal(dirname(target), parent);
    assert.match(basename(target), /^1904-deploy-ssh-test-/);
    rmSync(target, { recursive: true });
  });
  return dir;
}

const host = (overrides = {}) => {
  const checked = ssh.cleanHost({ name: 'deploy.example.com', user: 'deploy', auth: 'key', keys: [line()], ...overrides });
  assert.equal(checked.ok, true, checked.error);
  return checked.host;
};

test('a host is a name, a user and a port, and can never be read as an option', () => {
  assert.deepEqual(host(), { name: 'deploy.example.com', user: 'deploy', port: 22, auth: 'key', keys: [line()] });
  assert.equal(host({ name: ' 10.0.0.12 ', keys: [line('10.0.0.12')] }).name, '10.0.0.12');
  assert.equal(host({ port: '2222', keys: [line('[deploy.example.com]:2222')] }).port, 2222);
  for (const name of ['', '-oProxyCommand=evil', 'a b', 'host;id', 'host$(id)', 'host`id`', "host'x", 'x'.repeat(254)]) {
    assert.equal(ssh.cleanHost({ name, user: 'deploy', auth: 'ssh' }).ok, false, name);
  }
  for (const user of ['-oProxyCommand=evil', 'a b', 'root;id', '$(id)', '']) assert.equal(ssh.cleanHost({ name: 'h', user, keys: [line('h')] }).ok, false, user);
  for (const port of [0, 65536, 'abc', -1, 1.5]) assert.equal(ssh.cleanHost({ name: 'h', user: 'u', port, keys: [line('h')] }).ok, false, String(port));
  assert.equal(ssh.cleanHost({ name: 'h', user: 'u', auth: 'nonsense', keys: [line('h')] }).host.auth, 'key', 'an unknown way to sign in is the safest one');
});

test('with the person’s own ssh setup the user, port and identity are theirs; every other way needs a trusted identity', () => {
  assert.deepEqual(ssh.cleanHost({ name: 'staging', auth: 'ssh' }).host, { name: 'staging', user: '', auth: 'ssh', keys: [] });
  assert.deepEqual(ssh.cleanHost({ name: 'staging', auth: 'ssh', user: 'deploy', port: 2200, keys: [line('staging')] }).host, { name: 'staging', user: 'deploy', port: 2200, auth: 'ssh', keys: [] });
  for (const auth of ['key', 'password-saved', 'password-ask']) {
    assert.match(ssh.cleanHost({ name: 'deploy.example.com', user: 'deploy', auth, keys: [] }).error, /Check the host first/);
    // An identity trusted for another host, or another port of this one, is not this host's.
    assert.equal(ssh.cleanHost({ name: 'deploy.example.com', user: 'deploy', auth, keys: [line('other.example.com')] }).ok, false);
    assert.equal(ssh.cleanHost({ name: 'deploy.example.com', user: 'deploy', auth, port: 2222, keys: [line()] }).ok, false);
  }
  assert.equal(ssh.hostKeyLine(`${line()} injected`, { name: 'deploy.example.com', port: 22 }), undefined);
  assert.equal(ssh.hostKeyLine('deploy.example.com ssh-nonsense AAAA', { name: 'deploy.example.com', port: 22 }), undefined);
});

test('ssh is started with every argument its own word, pinned to the trusted identity', () => {
  const files = { knownHosts: '/private/tmp/run 1/known_hosts', key: '/private/tmp/run 1/key' };
  const key = ssh.sshArgs({ host: host(), files, word: 'echo abc | base64 -d | sh' });
  assert.deepEqual(key.slice(-6), ['-p', '22', '-l', 'deploy', '--', 'deploy.example.com', 'echo abc | base64 -d | sh'].slice(-6));
  assert.equal(key.at(-1), 'echo abc | base64 -d | sh');
  assert.equal(key[key.indexOf('--') + 1], 'deploy.example.com', 'the host follows --, so it is never an option');
  assert.equal(key[key.indexOf('-i') + 1], files.key, 'the key path is its own word, spaces and all');
  for (const option of ['BatchMode=yes', 'IdentitiesOnly=yes', 'PreferredAuthentications=publickey', 'StrictHostKeyChecking=yes', 'UpdateHostKeys=no',
    'UserKnownHostsFile="/private/tmp/run 1/known_hosts"']) assert.ok(key.includes(option), option);

  const password = ssh.sshArgs({ host: host({ auth: 'password-saved' }), files, word: 'true' });
  for (const option of ['BatchMode=no', 'PubkeyAuthentication=no', 'PreferredAuthentications=password,keyboard-interactive', 'NumberOfPasswordPrompts=1', 'StrictHostKeyChecking=yes']) {
    assert.ok(password.includes(option), option);
  }
  assert.ok(!password.includes('-i'));

  const own = ssh.sshArgs({ host: ssh.cleanHost({ name: 'staging', auth: 'ssh' }).host, word: 'true' });
  assert.deepEqual(own.slice(-3), ['--', 'staging', 'true'], 'user and port are left to the person’s SSH settings');
  assert.ok(own.includes('BatchMode=yes') && !own.some(arg => arg.startsWith('UserKnownHostsFile')));
  // A Windows temp folder: forward slashes, quoted.
  assert.equal(ssh.optionPath('C:\\Users\\Ada Lovelace\\AppData\\Local\\Temp\\1904-deploy-1\\known_hosts'), '"C:/Users/Ada Lovelace/AppData/Local/Temp/1904-deploy-1/known_hosts"');
  assert.throws(() => ssh.optionPath('/tmp/a"b'));
});

test('reading a host’s identity signs in to nothing', () => {
  const args = ssh.hostKeyArgs({ host: { name: 'deploy.example.com', user: 'deploy', port: 2222, auth: 'key' }, knownHosts: '/tmp/x/known_hosts' });
  for (const option of ['StrictHostKeyChecking=accept-new', 'PreferredAuthentications=none', 'PubkeyAuthentication=no', 'BatchMode=yes', 'HashKnownHosts=no']) assert.ok(args.includes(option), option);
  assert.deepEqual(args.slice(-7), ['-p', '2222', '-l', 'deploy', '--', 'deploy.example.com', 'exit']);
  const keys = ssh.readHostKeys(`# comment\n${line('[deploy.example.com]:2222')}\nother.example.com ssh-ed25519 ${KEY}\n${line('[deploy.example.com]:2222')}\n`, { name: 'deploy.example.com', port: 2222 });
  assert.equal(keys.length, 1, 'only this host and port, once');
  assert.match(keys[0].fingerprint, /^ED25519 SHA256:[A-Za-z0-9+/]{43}$/);
});

test('the fingerprint is the one ssh-keygen shows', { skip: !existsSync('/usr/bin/ssh-keygen') }, t => {
  const dir = dataFolder(t);
  const file = join(dir, 'key');
  assert.equal(spawnSync('/usr/bin/ssh-keygen', ssh.keygenArgs({ file, comment: 'Realzy App!' }), { encoding: 'utf8' }).status, 0);
  const pub = ssh.publicKey(readFileSync(file + '.pub', 'utf8'));
  assert.match(pub, /^ssh-ed25519 \S+ 1904-deploy-Realzy-App-$/);
  assert.match(readFileSync(file, 'utf8'), /PRIVATE KEY/);
  const shown = spawnSync('/usr/bin/ssh-keygen', ['-lf', file + '.pub'], { encoding: 'utf8' }).stdout.split(' ')[1];
  assert.equal(ssh.fingerprint(`h ${pub.split(' ').slice(0, 2).join(' ')}`), `ED25519 ${shown}`);
});

test('a public key is added on the host once, with the permissions sshd insists on', { skip: !hasSh }, t => {
  const home = dataFolder(t);
  const pub = `ssh-ed25519 ${KEY} 1904-deploy-realzy`;
  for (let i = 0; i < 2; i++) {
    const ran = spawnSync('/bin/sh', ['-c', ssh.installKeyScript(pub, NONCE)], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } });
    assert.equal(deploy.readDeployOutput(ran.stdout, NONCE).confirmed, true);
  }
  assert.equal(readFileSync(join(home, '.ssh/authorized_keys'), 'utf8'), pub + '\n', 'added once, not twice');
  assert.throws(() => ssh.installKeyScript("ssh-ed25519 AAAA'; rm -rf ~ #", NONCE), /no deploy key/);
  assert.equal(ssh.installKeyCommand('not a key'), '');
  assert.ok(ssh.installKeyCommand(pub).includes(`echo '${pub}' >> ~/.ssh/authorized_keys`));
});

test('the password reaches ssh through the helper’s environment, never an argument or a file', { skip: !hasSh }, t => {
  const dir = dataFolder(t);
  const helper = ssh.askpass({ platform: 'macos' });
  const file = join(dir, helper.name);
  writeFileSync(file, helper.text, { mode: helper.mode });
  const secret = `p@ss w0rd'"$\`!&|`;
  const env = ssh.passwordEnvironment({ helper: file, password: secret, env: {} });
  assert.deepEqual(Object.keys(env).sort(), ['DISPLAY', ssh.SECRET_ENV, 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'].sort());
  assert.equal(env.SSH_ASKPASS_REQUIRE, 'force');
  assert.ok(!helper.text.includes(secret));
  const asked = spawnSync(file, ["deploy@host's password: "], { encoding: 'utf8', env });
  assert.equal(asked.stdout, secret + '\n', 'any character a password can hold comes through unchanged');
  // Only a question about a password is answered.
  for (const prompt of ['Are you sure you want to continue connecting (yes/no/[fingerprint])? ', "Enter passphrase for key '/x': ", 'Verification code: ']) {
    const other = spawnSync(file, [prompt], { encoding: 'utf8', env });
    assert.deepEqual([other.stdout, other.status], ['', 1], prompt);
  }
  const windows = ssh.askpass({ platform: 'windows' });
  assert.match(windows.name, /\.cmd$/);
  assert.ok(windows.text.includes(`$env:${ssh.SECRET_ENV}`) && !windows.text.includes('%'), 'cmd never expands the password itself');
  for (const bad of ['', 'two\nlines', 'x'.repeat(ssh.PASSWORD_MAX + 1), 5, undefined]) assert.equal(ssh.cleanPassword(bad), undefined);
  assert.equal(ssh.cleanPassword(secret), secret);
});

test('what ssh printed becomes a sentence the person can act on', () => {
  assert.match(ssh.sshProblem('@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@\nHost key verification failed.'), /did not show the identity you trusted/);
  assert.match(ssh.sshProblem('deploy@h: Permission denied (publickey,password).', { password: true }), /refused that password/);
  assert.match(ssh.sshProblem('deploy@h: Permission denied (publickey).'), /key is installed/);
  assert.match(ssh.sshProblem('ssh: connect to host h port 22: Connection timed out'), /VPN/);
  assert.match(ssh.sshProblem('ssh: Could not resolve hostname nope: Name or service not known'), /could not be found/);
  assert.equal(ssh.sshProblem(''), 'ssh could not connect to the host.');
});

test('a deploy key and a saved password are sealed before they touch the disk, and belong to their pairing', async t => {
  const file = join(dataFolder(t), ssh.SECRETS_FILE);
  let available = true;
  const vault = { available: async () => available, encrypt: async text => Buffer.from(`sealed:${text}`).toString('base64'), decrypt: async text => Buffer.from(text, 'base64').toString().replace(/^sealed:/, '') };
  const secrets = ssh.createDeploySecrets({ file, vault });
  const pub = `ssh-ed25519 ${KEY} 1904-deploy-realzy`;
  await secrets.setPassword('app_1', PAIRED, 'hunter2 hunter2');
  await secrets.setKey('app_1', PAIRED, { privateKey: FAKE_PRIVATE_KEY + '\n', publicKey: pub + '\n' });
  const onDisk = readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes('hunter2') && !onDisk.includes('BEGIN OPENSSH'), 'nothing secret is written in clear');
  assert.deepEqual(secrets.summary('app_1', PAIRED), { password: true, publicKey: pub });
  assert.equal(await secrets.password('app_1', PAIRED), 'hunter2 hunter2');
  assert.match(await secrets.privateKey('app_1', PAIRED), /BEGIN OPENSSH PRIVATE KEY/);
  // Another pairing reads nothing, and saving under it starts clean.
  assert.deepEqual(secrets.summary('app_1', 'computer_0002'), { password: false, publicKey: undefined });
  assert.equal(await secrets.password('app_1', 'computer_0002'), undefined);
  await secrets.setPassword('app_1', 'computer_0002', 'another one');
  assert.equal(await secrets.privateKey('app_1', 'computer_0002'), undefined, 'the old key did not come along');
  secrets.forget('app_1', 'password');
  assert.equal(await secrets.password('app_1', 'computer_0002'), undefined);
  secrets.forget('app_1');
  assert.equal(readFileSync(file, 'utf8'), '{}');
  // Without the system's key store nothing is kept at all.
  available = false;
  await assert.rejects(secrets.setPassword('app_1', PAIRED, 'x'), /secure storage is not available/);
  await assert.rejects(secrets.setPassword('__proto__', PAIRED, 'x'));
  assert.equal(readFileSync(file, 'utf8'), '{}');
});

test('a host recipe shows how it connects, and its sign-in is part of what "without approval" covers', () => {
  const base = deploy.cleanRecipe({ host: host(), commands: 'cd /srv/app\ngit pull' });
  assert.equal(base.ok, true);
  assert.equal(base.recipe.connect, '', 'a filled-in host takes the place of a typed connect line');
  const text = deploy.recipeText(base.recipe);
  assert.match(text, /^# connect\nssh to deploy@deploy\.example\.com, signing in with the deploy key 1904 Desktop made\n# the host must show ED25519 SHA256:/);
  const hash = deploy.recipeHash(base.recipe);
  for (const change of [{ user: 'root' }, { auth: 'password-saved' }, { port: 2222, keys: [line('[deploy.example.com]:2222')] }, { keys: [line(), `deploy.example.com ssh-rsa ${KEY}`] }]) {
    assert.notEqual(deploy.recipeHash(deploy.cleanRecipe({ host: host(change), commands: 'cd /srv/app\ngit pull' }).recipe), hash, JSON.stringify(change));
  }
  assert.equal(deploy.cleanRecipe({ host: { name: '-oProxyCommand=x', user: 'u' }, commands: 'true' }).ok, false);
  const plan = deploy.deployPlan({ recipe: base.recipe, platform: 'windows', sha: 'a'.repeat(40), branch: 'main', nonce: NONCE });
  assert.match(plan.word, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/);
  assert.equal(plan.command, undefined, 'no shell on this computer reads anything');
  assert.equal(deploy.recipeRegistration({ appId: 'a', ...base.recipe, hash }).remote, true);
});

test('a dry run names what the commands start and runs none of them', { skip: !hasSh }, t => {
  assert.deepEqual(deploy.commandTools('cd /srv/app\nNODE_ENV=production npm ci\nsudo systemctl restart app\n./deploy.sh\necho done\ndocker compose up -d'), ['npm', 'systemctl', 'docker']);
  const dir = dataFolder(t);
  const marker = join(dir, 'ran');
  const check = commands => {
    const recipe = deploy.cleanRecipe({ commands, log: { mode: 'write', path: join(dir, 'deploy.log') } }).recipe;
    const plan = deploy.deployPlan({ recipe, platform: 'macos', nonce: NONCE, dryRun: true });
    const ran = spawnSync('/bin/sh', ['-c', plan.command], { encoding: 'utf8' });
    return { ...deploy.deployOutcome({ outcome: { status: 'done', exitCode: ran.status, stdout: ran.stdout }, marker: true, nonce: NONCE }), stderr: ran.stderr };
  };
  const good = check(`touch ${marker}\necho hi`);
  assert.equal(good.status, 'done');
  assert.match(good.output, /The commands parse\.\nThe log file will be created\./);
  assert.match(good.output, /Nothing found that would stop a deploy\. No command was run\.\n$/);
  const missing = check(`definitely-not-installed-1904 --now\ntouch ${marker}`);
  assert.equal(missing.status, 'failed');
  assert.match(missing.output, /MISSING: definitely-not-installed-1904/);
  const broken = check(`echo "unterminated\ntouch ${marker}`);
  assert.equal(broken.status, 'failed');
  assert.match(broken.output, /The commands do not parse/);
  assert.equal(existsSync(marker), false, 'no command ran');
  assert.equal(existsSync(join(dir, 'deploy.log')), false, 'and nothing was created');
  assert.match(deploy.deployPlan({ recipe: deploy.cleanRecipe({ commands: 'git pull' }).recipe, platform: 'windows', nonce: NONCE, dryRun: true }).error, /dry run needs a host/);
});
