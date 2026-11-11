const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const sandbox = require('../computer-sandbox.cjs');

const {
  CREDENTIAL_FILES, CREDENTIAL_FOLDERS, DEVICE_FILES, NETWORK_SERVICES, PREFERENCE_DOMAINS, PRIVATE_SYSTEM_FOLDERS, PROTECTED_IN_APP,
  SANDBOX_EXEC, SERVICES, SYSCTL_NAMES, SYSCTL_PREFIXES, TOOLCHAIN_FILES, TOOLCHAIN_FOLDERS, appFolderProblem, sandboxPlan,
} = sandbox;

const home = '/Users/dana';
const base = { appFolder: '/Users/dana/1904/shop', tempDir: '/private/var/folders/xy/T/1904-run-abc', home, userData: '/Users/dana/Library/Application Support/1904 Desktop' };
const lines = plan => plan.profile.split('\n');
// The lines of the rule that starts at `opening`, up to its closing parenthesis (or the line itself when it closes there).
function rule(plan, opening) {
  const all = lines(plan);
  const start = all.findIndex(line => line === opening || line.startsWith(opening + ' '));
  assert.ok(start >= 0, opening);
  if (all[start].endsWith(')') && !all[start + 1]?.startsWith('  ')) return all.slice(start, start + 1);
  return all.slice(start, all.indexOf(')', start) + 1);
}
const paramsIn = (block, plan) => block.flatMap(line => [...line.matchAll(/\(param "(P\d+)"\)/g)].map(match => plan.params[match[1]]));
const index = (plan, text) => lines(plan).findIndex(line => line === text || line.startsWith(text));

test('everything is denied by default, and these are the only operations allowed', () => {
  for (const network of [false, true]) {
    const plan = sandboxPlan({ ...base, network });
    assert.equal(lines(plan)[0], '(version 1)');
    assert.equal(lines(plan)[1], '(deny default)');
    assert.ok(!plan.profile.includes('(allow default)'));
    // The operations are the words after "(allow" and before the first filter.
    const allowed = new Set(lines(plan).filter(line => line.startsWith('(allow ')).flatMap(line =>
      line.slice('(allow '.length).split(' (')[0].replace(/\)$/, '').split(' ')));
    const expected = ['process-exec*', 'process-fork', 'signal', 'process-info*', 'sysctl-read', 'ipc-posix-sem', 'ipc-posix-shm', 'mach-lookup',
      'user-preference-read', 'file-read*', 'file-map-executable', 'file-read-metadata', 'file-write*', 'file-ioctl',
      ...(network ? ['network-outbound', 'network-bind', 'network-inbound'] : [])];
    assert.deepEqual([...allowed].sort(), expected.sort(), `network ${network}`);
  }
});

test('never Apple events, launching apps or URLs, background jobs, preference writes, mounting, pasteboard or the window server', () => {
  for (const network of [false, true]) {
    const profile = sandboxPlan({ ...base, network }).profile;
    for (const forbidden of ['appleevent-send', 'job-creation', 'user-preference-write', 'file-mount', 'file-unmount', 'lsopen', 'system-', 'iokit-open', 'nvram', 'process-exec-interpreter-', 'distributed-notification']) {
      assert.ok(!new RegExp(`\\(allow[^\\n]*${forbidden}`).test(profile), forbidden);
    }
    const services = [...profile.matchAll(/\(global-name "([^"]+)"\)/g)].map(match => match[1]);
    assert.deepEqual(services.sort(), [...SERVICES, ...(network ? NETWORK_SERVICES : [])].sort(), 'only the named services');
    for (const service of services) assert.doesNotMatch(service, /launchservices|lsd|pasteboard|windowserver|appleevents|coreservices|SecurityServer|pboard|launchd/i);
  }
  assert.deepEqual([...SERVICES].sort(), ['com.apple.cfprefsd.agent', 'com.apple.cfprefsd.daemon', 'com.apple.logd', 'com.apple.system.logger',
    'com.apple.system.notification_center', 'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership']);
  assert.deepEqual([...NETWORK_SERVICES].sort(), ['com.apple.SystemConfiguration.configd', 'com.apple.dnssd.service', 'com.apple.networkd',
    'com.apple.trustd', 'com.apple.trustd.agent']);
  assert.deepEqual([...PREFERENCE_DOMAINS], ['kCFPreferencesAnyApplication', 'com.apple.dt.Xcode']);
});

test('signals and process information only within the sandbox; system settings by name, never other processes’ arguments', () => {
  const plan = sandboxPlan(base);
  assert.ok(lines(plan).includes('(allow signal (target same-sandbox))'), 'no kill -9 -1 outside');
  assert.ok(lines(plan).includes('(allow process-info* (target same-sandbox))'));
  const sysctl = rule(plan, '(allow sysctl-read');
  assert.deepEqual(sysctl.slice(1, -1), [...SYSCTL_PREFIXES.map(prefix => `  (sysctl-name-prefix "${prefix}")`), ...SYSCTL_NAMES.map(name => `  (sysctl-name "${name}")`)]);
  assert.ok(!SYSCTL_PREFIXES.some(prefix => 'kern.procargs2'.startsWith(prefix)) && !SYSCTL_NAMES.includes('kern.procargs2'));
  assert.ok(!SYSCTL_PREFIXES.includes('kern.'), 'not every kernel setting');
});

test('no path is ever written into the profile, so no folder name can add a rule', () => {
  const hostile = '/Users/dana/1904/sh")(allow file-write* (subpath "/")) ; \n(allow network*)(version 1)"\\';
  const plain = sandboxPlan(base);
  const tricked = sandboxPlan({ ...base, appFolder: hostile, home: '/Users/da"na)(allow default' });
  assert.equal(tricked.profile, plain.profile, 'the profile text does not depend on any path');
  assert.doesNotMatch(plain.profile, /Users|dana|1904-run|Application Support/);
  assert.ok(Object.values(tricked.params).includes(hostile), 'the folder reaches sandbox-exec unchanged, as a value');
  // Every string in the profile is one of these constants.
  const constants = new Set([...DEVICE_FILES, '/dev/fd', ...PRIVATE_SYSTEM_FOLDERS, '/Library/Keychains', ...SERVICES, ...NETWORK_SERVICES,
    ...PREFERENCE_DOMAINS, ...SYSCTL_PREFIXES, ...SYSCTL_NAMES, ...PROTECTED_IN_APP, '/private/var/run/mDNSResponder', '*:*', 'localhost:*']);
  for (const network of [false, true]) {
    const profile = sandboxPlan({ ...base, network }).profile;
    for (const [, value] of profile.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
      if (!/^P\d+$/.test(value)) assert.ok(constants.has(value), value);
    }
  }
  assert.throws(() => sandboxPlan({ ...base, tempDir: 'relative/tmp' }), /absolute/);
  const dash = plain.args.lastIndexOf('-p');
  assert.equal(plain.args[dash + 1], plain.profile);
  assert.equal(dash, plain.args.length - 2);
  for (let i = 0; i < dash; i += 2) {
    assert.equal(plain.args[i], '-D');
    const [name, ...rest] = plain.args[i + 1].split('=');
    assert.equal(plain.params[name], rest.join('='));
  }
  assert.equal(plain.file, SANDBOX_EXEC);
});

test('reads: the system, but not the home folder, other drives or other apps’ temporary files', () => {
  const plan = sandboxPlan(base);
  assert.ok(index(plan, '(allow file-read*)') > 0, 'the system');
  const denied = rule(plan, '(deny file-read*');
  assert.deepEqual(paramsIn(denied, plan), [home], 'all of the home folder');
  for (const folder of PRIVATE_SYSTEM_FOLDERS) assert.ok(denied.includes(`  (subpath "${folder}")`), folder);
  assert.deepEqual([...PRIVATE_SYSTEM_FOLDERS], ['/Volumes', '/private/tmp', '/private/var/tmp', '/private/var/folders']);
  assert.ok(index(plan, '(allow file-read-metadata)') > index(plan, '(deny file-read*'), 'paths can still be looked up');
});

test('reads come back for the app’s folder, the run’s temporary folder and named toolchains only', () => {
  const plan = sandboxPlan(base);
  const allowedBack = lines(plan).slice(index(plan, '(allow file-read-metadata)') + 1);
  const block = allowedBack.slice(0, allowedBack.indexOf(')') + 1);
  assert.equal(block[0], '(allow file-read*');
  const paths = paramsIn(block, plan);
  assert.deepEqual(paths.slice(0, 2), [base.appFolder, base.tempDir]);
  assert.deepEqual(paths.slice(2), [...TOOLCHAIN_FOLDERS, ...TOOLCHAIN_FILES].map(entry => path.posix.join(home, entry)));
  for (const entry of ['.nvm', '.npm', '.rustup', '.cargo/bin', '.cargo/registry', 'go/pkg', '.local/bin', 'Library/pnpm', '.gradle/caches', '.m2/repository']) assert.ok(TOOLCHAIN_FOLDERS.includes(entry), entry);
  for (const notAllowed of ['.cargo', '.gradle', '.m2', 'go', 'go/src', '.config', '.local', '.local/share', 'Library']) assert.ok(!TOOLCHAIN_FOLDERS.includes(notAllowed), `${notAllowed}: holds credentials or the person’s files`);
  assert.deepEqual([...TOOLCHAIN_FILES], ['.gitconfig', '.config/git/config', '.config/git/ignore', '.config/git/attributes'], 'never git’s credentials');
});

test('writes: only the app’s folder, the run’s temporary folder and devices', () => {
  const plan = sandboxPlan(base);
  const writes = lines(plan).filter(line => line.startsWith('(allow') && line.includes('file-write'));
  assert.deepEqual(writes.map(line => line.replace(/\(param "P\d+"\)/g, 'P')), [
    '(allow file-write* (subpath P) (subpath P))',
    '(allow file-read* file-write* file-ioctl',
  ]);
  assert.deepEqual(paramsIn([writes[0]], plan), [base.appFolder, base.tempDir]);
  const devices = rule(plan, '(allow file-read* file-write* file-ioctl');
  assert.deepEqual(devices.slice(1, -1), [...DEVICE_FILES.map(device => `  (literal "${device}")`), '  (subpath "/dev/fd")']);
});

test('in the app’s folder, nothing other tools run later can be written', () => {
  const plan = sandboxPlan(base);
  const protectedBlock = rule(plan, '(deny file-write*');
  assert.ok(index(plan, '(deny file-write*') > index(plan, '(allow file-write* '), 'after the allowance, so it wins');
  const patterns = protectedBlock.slice(1, -1).map(line => {
    const match = /^  \(require-all \(subpath \(param "(P\d+)"\)\) \(regex #"(.+)"\)\)$/.exec(line);
    assert.ok(match, line);
    assert.equal(plan.params[match[1]], base.appFolder, 'only within the app’s folder');
    return new RegExp(match[2]);
  });
  const app = base.appFolder;
  const blocked = ['.git', '.git/config', '.git/config.worktree', '.git/config.lock', '.git/hooks', '.git/hooks/pre-commit', '.git/info/attributes',
    '.git/modules/lib/config', '.git/modules/lib/hooks/post-checkout', '.git/modules/a/b/info/exclude', 'sub/.git', 'sub/.git/hooks/x',
    '.vscode/tasks.json', '.idea/workspace.xml', '.zed/tasks.json', '.cursor/rules', '.husky/pre-commit', '.envrc', 'sub/.envrc', '.pre-commit-config.yaml'];
  for (const relative of blocked) assert.ok(patterns.some(pattern => pattern.test(`${app}/${relative}`)), relative);
  const open = ['src/index.js', '.git/objects/ab/cdef', '.git/HEAD', '.git/refs/heads/main', '.git/index', '.gitignore', '.github/workflows/ci.yml',
    '.env', 'package.json', 'my.git/config', '.vscodex/x', '.envrc.example'];
  for (const relative of open) assert.ok(!patterns.some(pattern => pattern.test(`${app}/${relative}`)), relative);
  assert.equal(PROTECTED_IN_APP.length, patterns.length);
});

test('credentials and 1904 Desktop’s own data come last and win over every allowance, for reading and writing', () => {
  const plan = sandboxPlan(base);
  const last = lines(plan).slice(lines(plan).lastIndexOf('(deny file-read* file-write*'));
  assert.equal(last.at(-1), ')', 'the very last rule');
  const denied = paramsIn(last, plan);
  for (const folder of CREDENTIAL_FOLDERS) assert.ok(denied.includes(path.posix.join(home, folder)), folder);
  for (const file of CREDENTIAL_FILES) assert.ok(denied.includes(path.posix.join(home, file)), file);
  assert.ok(denied.includes(base.userData));
  assert.ok(last.includes('  (subpath "/Library/Keychains")'));
  for (const expected of ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.kube', '.docker', '.codex', '.claude', '.gemini', 'Library/Keychains']) assert.ok(CREDENTIAL_FOLDERS.includes(expected), expected);
  for (const expected of ['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.config/git/credentials', '.cargo/credentials.toml', '.gradle/gradle.properties', '.m2/settings.xml', '.vault-token', '.pgpass']) assert.ok(CREDENTIAL_FILES.includes(expected), expected);
});

test('the order: home denied, then app, temp and toolchains allowed, then protected app files, then credentials', () => {
  const plan = sandboxPlan({ ...base, network: true });
  const order = ['(deny default)', '(allow file-read*)', '(deny file-read*', '(allow file-read-metadata)', '(allow file-write* ', '(deny file-write*',
    '(allow network-outbound (remote ip "*:*"))', '(deny file-read* file-write*'];
  const positions = order.map(text => index(plan, text));
  assert.ok(positions.every(position => position >= 0), JSON.stringify(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('the network: none unless allowed; then out to the internet, but not to this computer’s loopback, and listening on loopback only', () => {
  const off = sandboxPlan(base);
  assert.ok(!/network/.test(off.profile.replace(/com\.apple\.networkd/g, '')), 'not a single network rule');
  const on = lines(sandboxPlan({ ...base, network: true }));
  const network = on.filter(line => line.includes('network-'));
  assert.deepEqual(network, [
    '(allow network-outbound (remote ip "*:*"))',
    '(deny network-outbound (remote ip "localhost:*"))',
    '(allow network-bind (local ip "localhost:*"))',
    '(allow network-inbound (local ip "localhost:*"))',
    '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
  ]);
  assert.ok(on.indexOf('(deny network-outbound (remote ip "localhost:*"))') > on.indexOf('(allow network-outbound (remote ip "*:*"))'), 'the loopback denial wins');
});

test('an app folder that holds or sits in credentials, Library or a hidden home folder is refused', () => {
  const refused = [
    '/Users/dana/.ssh', '/Users/dana/.ssh/x', '/Users/dana/.config', '/Users/dana/.config/project', '/Users/dana/.cache/x', '/Users/dana/.local',
    '/Users/dana/Library', '/Users/dana/Library/Application Support', '/Users/dana/Library/Developer/x', base.userData, `${base.userData}/x`,
    '/Library', '/Library/Keychains/x',
  ];
  for (const appFolder of refused) {
    assert.ok(appFolderProblem({ appFolder, home, userData: base.userData }), appFolder);
    assert.match(sandboxPlan({ ...base, appFolder }).error, /will not sandbox/, appFolder);
  }
  for (const appFolder of ['/Users/dana/1904/shop', '/Users/dana/Documents/code/shop', '/Users/dana/code/.hidden-inside-ok', '/Volumes/Work/shop', '/Users/dana/sshkeys']) {
    assert.equal(appFolderProblem({ appFolder, home, userData: base.userData }), undefined, appFolder);
  }
  const realpath = value => value === '/Users/dana/link-to-ssh' ? '/Users/dana/.ssh' : value;
  assert.ok(appFolderProblem({ appFolder: '/Users/dana/link-to-ssh', home, userData: base.userData, realpath }), 'a link is judged by where it leads');
});

test('paths the sandbox sees resolved are used resolved, and denied both ways', () => {
  const realpath = value => value.startsWith('/var/') ? '/private' + value : value === '/Users/dana/.aws' ? '/Volumes/Keys/aws' : value;
  const plan = sandboxPlan({ ...base, tempDir: '/var/folders/xy/T/run', realpath });
  assert.ok(Object.values(plan.params).includes('/private/var/folders/xy/T/run'), 'the temporary folder is used resolved');
  const last = lines(plan).slice(lines(plan).lastIndexOf('(deny file-read* file-write*'));
  const denied = paramsIn(last, plan);
  assert.ok(denied.includes('/Users/dana/.aws') && denied.includes('/Volumes/Keys/aws'));
});
