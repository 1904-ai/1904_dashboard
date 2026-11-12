const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const sandbox = require('../computer-sandbox.cjs');

const {
  CREDENTIAL_FILES, CREDENTIAL_FOLDERS, DEVICE_FILES, GIT_NEVER, GIT_WRITABLE, NETWORK_SERVICES, NPMRC_ANYWHERE, PREFERENCE_DOMAINS,
  PRIVATE_SYSTEM_FOLDERS, PROTECTED_IN_APP, PROTECTED_SOURCES, REMOVE_PROGRAM, RUN_FOLDER_PREFIX, SANDBOX_EXEC, SERVICES, SYSCTL_NAMES,
  SYSCTL_PREFIXES, SYSTEM_CREDENTIAL_FOLDERS, TOOLCHAIN_FILES, TOOLCHAIN_FOLDERS, appFolderProblem, caseless, caselessSubpath, cleanupPlan,
  gitConfigForRun, sandboxPlan,
} = sandbox;

const home = '/Users/dana';
const base = { appFolder: '/Users/dana/1904/shop', tempDir: '/private/var/folders/xy/T/1904-run-abc', home, userData: '/Users/dana/Library/Application Support/1904 Desktop' };
const app = base.appFolder;
const lines = plan => plan.profile.split('\n');
// The lines of the rule that starts at `opening`, up to its closing parenthesis (or the line itself when it closes there).
function rule(plan, opening, from = 0) {
  const all = lines(plan);
  const start = all.findIndex((line, i) => i >= from && (line === opening || line.startsWith(opening + ' ')));
  assert.ok(start >= 0, opening);
  if (all[start].endsWith(')') && !all[start + 1]?.startsWith('  ')) return all.slice(start, start + 1);
  return all.slice(start, all.indexOf(')', start) + 1);
}
const paramsIn = (block, plan) => block.flatMap(line => [...line.matchAll(/\(param "(P\d+)"\)/g)].map(match => plan.params[match[1]]));
const index = (plan, text) => lines(plan).findIndex(line => line === text || line.startsWith(text));
// The multi-line rule whose first line is exactly `opening` (the git allowance is `(allow file-write*` on its own line).
function block(plan, opening) {
  const all = lines(plan);
  const start = all.indexOf(opening);
  assert.ok(start >= 0, opening);
  return all.slice(start, all.indexOf(')', start) + 1);
}

// ── A small reading of the profile: file rules, last match wins, denied by default ──

function parse(text) {
  const tokens = [];
  for (let i = 0; i < text.length;) {
    const char = text[i];
    if (/\s/.test(char)) { i += 1; continue; }
    if (char === '(' || char === ')') { tokens.push(char); i += 1; continue; }
    if (char === '"' || (char === '#' && text[i + 1] === '"')) {
      const regex = char === '#';
      let j = i + (regex ? 2 : 1);
      let value = '';
      while (text[j] !== '"') {
        if (text[j] === '\\' && !regex) { value += text[j + 1]; j += 2; continue; }
        if (text[j] === '\\' && regex) { value += text[j] + text[j + 1]; j += 2; continue; }
        value += text[j];
        j += 1;
      }
      tokens.push({ [regex ? 'regex' : 'string']: value });
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < text.length && !/[\s()]/.test(text[j])) j += 1;
    tokens.push({ atom: text.slice(i, j) });
    i = j;
  }
  let at = 0;
  const read = () => {
    const token = tokens[at++];
    if (token !== '(') return token;
    const list = [];
    while (tokens[at] !== ')') list.push(read());
    at += 1;
    return list;
  };
  const forms = [];
  while (at < tokens.length) forms.push(read());
  return forms;
}

function evaluator(plan) {
  const value = node => (Array.isArray(node) && node[0]?.atom === 'param' ? plan.params[node[1].string] : node.string);
  const filter = node => {
    const kind = node[0].atom;
    if (kind === 'subpath') { const root = value(node[1]); return p => p === root || p.startsWith(root + '/'); }
    if (kind === 'literal') { const exact = value(node[1]); return p => p === exact; }
    if (kind === 'regex') { const re = new RegExp(node[1].regex); return p => re.test(p); }
    if (kind === 'require-all') { const parts = node.slice(1).map(filter); return p => parts.every(part => part(p)); }
    return () => false; // not a path filter (global-name, sysctl-name, remote ...)
  };
  const rules = parse(plan.profile).filter(form => form[0].atom === 'allow' || form[0].atom === 'deny').map(form => {
    const ops = form.slice(1).filter(node => !Array.isArray(node)).map(node => node.atom);
    const filters = form.slice(1).filter(Array.isArray).map(filter);
    return { allow: form[0].atom === 'allow', ops, test: p => filters.length === 0 || filters.some(f => f(p)) };
  });
  const decide = op => p => {
    let allowed = false;
    for (const r of rules) if ((r.ops.includes(op) || r.ops.includes('default')) && r.test(p)) allowed = r.allow;
    return allowed;
  };
  return { canWrite: decide('file-write*'), canRead: decide('file-read*') };
}

/** `text` in lower case, upper case, and two mixed cases. */
const caseVariants = text => [
  text, text.toUpperCase(),
  text.replace(/[a-z]/g, (c, i) => (i % 2 ? c.toUpperCase() : c)),
  text.replace(/[a-z]/g, (c, i) => (i % 2 ? c : c.toUpperCase())),
];

// ── The profile ──

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
  assert.doesNotMatch(plain.profile, /dana|1904-run|Application Support/);
  assert.ok(Object.values(tricked.params).includes(hostile), 'the folder reaches sandbox-exec unchanged, as a value');
  // Every string in the profile is one of these constants.
  const constants = new Set([...DEVICE_FILES, '/dev/fd', ...PRIVATE_SYSTEM_FOLDERS, ...SYSTEM_CREDENTIAL_FOLDERS, ...SERVICES, ...NETWORK_SERVICES,
    ...PREFERENCE_DOMAINS, ...SYSCTL_PREFIXES, ...SYSCTL_NAMES, ...PROTECTED_IN_APP, ...GIT_WRITABLE, ...GIT_NEVER, NPMRC_ANYWHERE,
    ...[...PRIVATE_SYSTEM_FOLDERS, ...SYSTEM_CREDENTIAL_FOLDERS].map(caselessSubpath), '/private/var/run/mDNSResponder', '*:*', 'localhost:*']);
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

test('reads: the system, but not any home folder, other drives, local databases or other apps’ temporary files', () => {
  const plan = sandboxPlan(base);
  assert.ok(index(plan, '(allow file-read*)') > 0, 'the system');
  const denied = rule(plan, '(deny file-read*');
  assert.deepEqual(paramsIn(denied, plan), [home], 'all of the home folder');
  for (const folder of PRIVATE_SYSTEM_FOLDERS) {
    assert.ok(denied.includes(`  (subpath "${folder}")`), folder);
    assert.ok(denied.includes(`  (regex #"${caselessSubpath(folder)}")`), `${folder} in any case`);
  }
  assert.deepEqual([...PRIVATE_SYSTEM_FOLDERS], ['/Users', '/Volumes', '/opt/homebrew/var', '/usr/local/var', '/opt/local/var', '/private/tmp', '/private/var/tmp', '/private/var/folders']);
  assert.ok(index(plan, '(allow file-read-metadata)') > index(plan, '(deny file-read*'), 'paths can still be looked up');

  const { canRead } = evaluator(plan);
  const unreadable = [
    '/Users/dana/Documents/notes.txt', '/Users/sam/Documents/x', '/Users/Shared/data', '/USERS/sam/x', '/users/Shared/x', '/Volumes/Backup/x',
    '/VOLUMES/Backup/x', '/opt/homebrew/var/postgresql@16/base/1', '/opt/homebrew/VAR/mysql/ibdata1', '/usr/local/var/redis/dump.rdb',
    '/private/tmp/other-app/x', '/private/var/folders/xy/T/other/x', '/Users/dana/.gitconfig', '/Users/dana/.config/git/config',
    '/Users/dana/.nvm/versions/node/v20.11.0/etc/npmrc', '/Users/dana/.nvm/versions/node/v20.11.0/ETC/NPMRC', '/Users/dana/.volta/tools/image/node/20.11.0/etc/npmrc',
    '/opt/homebrew/etc/npmrc', '/usr/local/etc/npmrc', '/Users/dana/.ssh/id_ed25519', '/Library/Keychains/System.keychain', '/LIBRARY/keychains/System.keychain',
  ];
  for (const file of unreadable) assert.equal(canRead(file), false, file);
  const readable = [
    '/usr/bin/git', '/opt/homebrew/bin/node', '/opt/homebrew/Cellar/python@3.12/3.12.1/bin/python3', '/opt/homebrew/etc/gitconfig', '/Library/Developer/CommandLineTools/usr/bin/git',
    `${app}/src/index.js`, `${base.tempDir}/x`, '/Users/dana/.nvm/versions/node/v20.11.0/bin/node', '/Users/dana/.nvm/versions/node/v20.11.0/lib/node_modules/npm/index.js',
    '/Users/dana/.pyenv/versions/3.12.1/bin/python', '/Users/dana/.config/git/ignore', '/Users/dana/.config/git/attributes',
  ];
  for (const file of readable) assert.equal(canRead(file), true, file);
});

test('reads come back for the app’s folder, the run’s temporary folder and named toolchains only; never git’s settings', () => {
  const plan = sandboxPlan(base);
  const allowedBack = lines(plan).slice(index(plan, '(allow file-read-metadata)') + 1);
  const block = allowedBack.slice(0, allowedBack.indexOf(')') + 1);
  assert.equal(block[0], '(allow file-read*');
  const paths = paramsIn(block, plan);
  assert.deepEqual(paths.slice(0, 2), [base.appFolder, base.tempDir]);
  assert.deepEqual(paths.slice(2), [...TOOLCHAIN_FOLDERS, ...TOOLCHAIN_FILES].map(entry => path.posix.join(home, entry)));
  for (const entry of ['.nvm', '.npm', '.rustup', '.cargo/bin', '.cargo/registry', 'go/pkg', '.local/bin', 'Library/pnpm', '.gradle/caches', '.m2/repository']) assert.ok(TOOLCHAIN_FOLDERS.includes(entry), entry);
  for (const notAllowed of ['.cargo', '.gradle', '.m2', 'go', 'go/src', '.config', '.local', '.local/share', 'Library']) assert.ok(!TOOLCHAIN_FOLDERS.includes(notAllowed), `${notAllowed}: holds credentials or the person’s files`);
  assert.deepEqual([...TOOLCHAIN_FILES], ['.config/git/ignore', '.config/git/attributes'], 'never git’s settings or credentials');
  for (const file of ['.gitconfig', '.config/git/config']) assert.ok(CREDENTIAL_FILES.includes(file), `${file} is denied last`);
});

test('writes: only the app’s folder, the run’s temporary folder and devices; git internals only in the app’s own .git', () => {
  const plan = sandboxPlan(base);
  const writes = lines(plan).filter(line => line.startsWith('(allow') && line.includes('file-write'));
  assert.deepEqual(writes.map(line => line.replace(/\(param "P\d+"\)/g, 'P')), [
    '(allow file-write* (subpath P) (subpath P))',
    '(allow file-read* file-write* file-ioctl',
    '(allow file-write*',
  ]);
  assert.deepEqual(paramsIn([writes[0]], plan), [base.appFolder, base.tempDir]);
  const devices = rule(plan, '(allow file-read* file-write* file-ioctl');
  assert.deepEqual(devices.slice(1, -1), [...DEVICE_FILES.map(device => `  (literal "${device}")`), '  (subpath "/dev/fd")']);
  const gitBack = block(plan, '(allow file-write*');
  assert.deepEqual(gitBack.slice(1, -1).map(line => line.replace(/\(param "P\d+"\)/, 'P')),
    GIT_WRITABLE.map(pattern => `  (require-all (subpath P) (regex #"${pattern}"))`));
  assert.deepEqual([...new Set(paramsIn(gitBack, plan))], [`${app}/.git`], 'only under the app’s top-level .git');

  const { canWrite } = evaluator(plan);
  for (const file of [`${app}/src/index.js`, `${base.tempDir}/x`, '/dev/null']) assert.equal(canWrite(file), true, file);
  for (const file of ['/Users/dana/Documents/x', '/Users/dana/.zshrc', '/usr/local/bin/x', '/private/tmp/x', base.userData + '/x']) assert.equal(canWrite(file), false, file);
});

test('caseless: every letter matches either case; brackets and escapes stay as written', () => {
  assert.equal(caseless('/\\.git(/.*)?$'), '/\\.[gG][iI][tT](/.*)?$');
  assert.equal(caseless('/lint-staged\\.config\\.[^/]*$'), '/[lL][iI][nN][tT]-[sS][tT][aA][gG][eE][dD]\\.[cC][oO][nN][fF][iI][gG]\\.[^/]*$');
  assert.throws(() => caseless('[a-z]'), /bracket/);
  assert.throws(() => caseless('\\d'), /escape/);
  assert.equal(caselessSubpath('/Users'), '^/[uU][sS][eE][rR][sS](/.*)?$');
  for (const pattern of [...PROTECTED_IN_APP, ...GIT_NEVER, NPMRC_ANYWHERE]) {
    // No letter is left that would only match one case.
    assert.doesNotMatch(pattern.replace(/\[[^\]]*\]/g, '').replace(/\\./g, ''), /[A-Za-z]/, pattern);
  }
  assert.deepEqual(PROTECTED_IN_APP, PROTECTED_SOURCES.map(caseless), 'generated, never written by hand');
});

test('in the app’s folder, nothing other tools run or trust later can be written, in any case', () => {
  const plan = sandboxPlan(base);
  const protectedBlock = rule(plan, '(deny file-write*');
  assert.ok(index(plan, '(deny file-write*') > index(plan, '(allow file-write* '), 'after the allowance, so it wins');
  const patterns = protectedBlock.slice(1, -1).map(line => {
    const match = /^  \(require-all \(subpath \(param "(P\d+)"\)\) \(regex #"(.+)"\)\)$/.exec(line);
    assert.ok(match, line);
    assert.equal(plan.params[match[1]], base.appFolder, 'only within the app’s folder');
    return match[2];
  });
  assert.deepEqual(patterns, [...PROTECTED_IN_APP]);

  const { canWrite } = evaluator(plan);
  const blocked = [
    '.git', '.git/config', '.git/config.worktree', '.git/config.lock', '.git/hooks', '.git/hooks/pre-commit', '.git/info/attributes', '.git/info/exclude',
    '.git/description', '.git/shallow', '.git/branches/x', '.git/remotes/origin',
    '.vscode/tasks.json', '.vscode/settings.json', '.idea/workspace.xml', '.zed/tasks.json', '.cursor/rules', '.cursor/mcp.json',
    '.claude/settings.json', '.claude/settings.local.json', '.claude/hooks/x.sh', '.mcp.json', '.codex/config.toml', '.gemini/settings.json',
    '.grok/settings.json', '.kiro/hooks/x', '.amazonq/mcp.json', '.roo/mcp.json', '.continue/config.yaml', '.opencode/plugin/x.js', 'opencode.json',
    '.devcontainer/devcontainer.json', '.devcontainer.json', 'shop.code-workspace',
    '.husky/pre-commit', '.githooks/pre-commit', '.pre-commit-config.yaml', 'lefthook.yml', '.lefthook.yml', 'lefthook-local.yaml', '.lefthook/pre-commit/x.sh',
    '.lintstagedrc', '.lintstagedrc.json', '.lintstagedrc.mjs', 'lint-staged.config.js',
    '.envrc', 'sub/.envrc', 'mise.toml', '.mise.toml', 'mise.local.toml', '.mise/config.toml', 'mise/config.toml', '.config/mise/config.toml', '.config/mise.toml', '.config/lefthook.yml',
  ];
  for (const relative of blocked) {
    for (const variant of caseVariants(relative)) assert.equal(canWrite(`${app}/${variant}`), false, variant);
  }
  const open = ['src/index.js', '.gitignore', '.gitattributes', '.gitmodules', '.github/workflows/ci.yml', '.env', 'package.json', 'tsconfig.json',
    'eslint.config.js', '.eslintrc.json', '.prettierrc', 'my.git/config', '.vscodex/x', '.envrc.example', 'promise.toml', 'CLAUDE.md', 'AGENTS.md',
    'node_modules/x/index.js', '.npmrc', 'Makefile', 'GIT.md'];
  for (const relative of open) assert.equal(canWrite(`${app}/${relative}`), true, relative);
});

test('git: only the app’s own repository, and only what ordinary git work writes there', () => {
  const plan = sandboxPlan(base);
  const { canWrite } = evaluator(plan);
  // What add, commit, checkout, switch, rebase, merge, cherry-pick, revert, stash, fetch, bisect and gc write.
  const ordinary = [
    'objects/ab/cdef0123', 'objects/pack/pack-1.pack', 'objects/pack/tmp_pack_x', 'objects/info/packs', 'objects/info/commit-graph',
    'objects/info/commit-graphs/graph-1.graph', 'objects/maintenance.lock', 'objects/incoming-x/ab/cd', 'refs/heads/main', 'refs/heads/feature/x.lock',
    'refs/remotes/origin/main', 'refs/tags/v1', 'refs/stash', 'refs/heads/config', 'refs/heads/info', 'logs/HEAD', 'logs/refs/heads/main',
    'index', 'index.lock', 'HEAD', 'HEAD.lock', 'ORIG_HEAD', 'FETCH_HEAD', 'MERGE_HEAD', 'MERGE_MODE', 'MERGE_MSG', 'MERGE_RR', 'MERGE_AUTOSTASH',
    'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'AUTO_MERGE', 'COMMIT_EDITMSG', 'SQUASH_MSG', 'TAG_EDITMSG', 'BISECT_LOG', 'BISECT_START',
    'packed-refs', 'packed-refs.lock', 'gc.pid', 'gc.log', 'gc.log.lock', 'sharedindex.0123abcd', 'index.stash.4242', 'index.stash.4242.lock',
    'next-index-4242.lock', 'rebase-merge', 'rebase-merge/git-rebase-todo', 'rebase-merge/done', 'rebase-apply/0001', 'sequencer/todo',
    'rr-cache/abc/preimage', 'lfs/objects/ab/cd/x', 'lfs/tmp/x',
    // Submodules' repositories.
    'modules/lib/objects/ab/cd', 'modules/lib/refs/heads/main', 'modules/lib/HEAD', 'modules/lib/index', 'modules/lib/index.lock',
    'modules/lib/logs/HEAD', 'modules/a/b/ORIG_HEAD', 'modules/a/modules/b/FETCH_HEAD',
  ];
  for (const relative of ordinary) assert.equal(canWrite(`${app}/.git/${relative}`), true, relative);

  const never = [
    // Settings, hooks and links to other repositories: the commondir and worktree escapes.
    'config', 'config.lock', 'config.worktree', 'commondir', 'gitdir', 'hooks/pre-commit', 'info/attributes', 'shallow',
    'worktrees/w/commondir', 'worktrees/w/config.worktree', 'worktrees/w/gitdir', 'worktrees/w/HEAD', 'worktrees/w',
    'modules/lib/config', 'modules/lib/config.worktree', 'modules/lib/commondir', 'modules/lib/gitdir', 'modules/lib/hooks/post-checkout',
    'modules/lib/info/exclude', 'modules/lib/worktrees/w/commondir', 'modules/a/b/config', 'modules/x/refs/config', 'modules/x/refs/hooks/x',
    'modules/new', 'modules',
    // Other object stores, in any case.
    'objects/info/alternates', 'objects/info/alternates.lock', 'objects/info/http-alternates', 'modules/lib/objects/info/alternates',
    // A repository inside the git folder.
    'refs/.git', 'refs/.git/config', 'objects/x/.git/HEAD', 'rebase-merge/.git',
    // Anything else in the git folder.
    'random', 'FOO_HEAD', 'description',
  ];
  for (const relative of never) {
    for (const variant of caseVariants(relative)) assert.equal(canWrite(`${app}/.git/${variant}`), false, variant);
  }
  // .git in any case, at the top or below: a folder, a gitdir file, or anything in either.
  for (const relative of ['sub/.git', 'sub/.git/config', 'sub/.git/HEAD', 'sub/.git/objects/x', 'a/b/.git', 'node_modules/x/.git/config']) {
    for (const variant of caseVariants(relative)) assert.equal(canWrite(`${app}/${variant}`), false, variant);
  }
  for (const relative of ['config', 'commondir', 'objects/ab/cd', 'refs/heads/main', 'HEAD', 'index']) {
    for (const top of ['.GIT', '.Git', '.gIT']) assert.equal(canWrite(`${app}/${top}/${relative}`), false, `${top}/${relative}: a case variant of the top-level .git is never allowed back`);
  }
  for (const relative of ['objects/INFO/ALTERNATES', 'objects/info/Alternates', 'modules/lib/CONFIG', 'modules/lib/Hooks/x']) {
    assert.equal(canWrite(`${app}/.git/${relative}`), false, relative);
  }
  const back = lines(plan).indexOf('(allow file-write*');
  assert.ok(back > lines(plan).indexOf('(deny file-write*'), 'git internals come back after the protection');
  assert.ok(lines(plan).lastIndexOf('(deny file-write*') > back, 'and the never list comes after that');
});

test('credentials, git’s settings, npmrc files and 1904 Desktop’s own data come last and win over every allowance', () => {
  const plan = sandboxPlan(base);
  const last = lines(plan).slice(lines(plan).lastIndexOf('(deny file-read* file-write*'));
  assert.equal(last.at(-1), ')', 'the very last rule');
  const denied = paramsIn(last, plan);
  for (const folder of CREDENTIAL_FOLDERS) assert.ok(denied.includes(path.posix.join(home, folder)), folder);
  for (const file of CREDENTIAL_FILES) assert.ok(denied.includes(path.posix.join(home, file)), file);
  assert.ok(denied.includes(base.userData));
  assert.ok(last.includes('  (subpath "/Library/Keychains")'));
  assert.ok(last.includes(`  (regex #"${caselessSubpath('/Library/Keychains')}")`));
  assert.ok(last.includes(`  (regex #"${NPMRC_ANYWHERE}")`));
  for (const expected of ['.ssh', '.aws', '.gnupg', '.config/gh', '.config/gcloud', '.kube', '.docker', '.codex', '.claude', '.gemini', 'Library/Keychains']) assert.ok(CREDENTIAL_FOLDERS.includes(expected), expected);
  for (const expected of ['.netrc', '.npmrc', '.pypirc', '.git-credentials', '.config/git/credentials', '.cargo/credentials.toml', '.gradle/gradle.properties', '.m2/settings.xml', '.vault-token', '.pgpass', '.gitconfig', '.config/git/config']) assert.ok(CREDENTIAL_FILES.includes(expected), expected);
  const { canRead, canWrite } = evaluator(plan);
  for (const file of ['/Users/dana/.nvm/versions/node/v22.1.0/etc/npmrc', '/Users/dana/.asdf/installs/nodejs/20.0.0/etc/npmrc', '/opt/homebrew/etc/npmrc', `${app}/etc/npmrc`]) {
    assert.equal(canRead(file), false, file);
    assert.equal(canWrite(file), false, file);
  }
});

test('the order: home denied, then app, temp and toolchains allowed, then protected app files, git back, git never, then credentials', () => {
  const plan = sandboxPlan({ ...base, network: true });
  const order = ['(deny default)', '(allow file-read*)', '(deny file-read*', '(allow file-read-metadata)', '(allow file-write* ', '(deny file-write*',
    '(allow network-outbound (remote ip "*:*"))', '(deny file-read* file-write*'];
  const positions = order.map(text => index(plan, text));
  assert.ok(positions.every(position => position >= 0), JSON.stringify(positions));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
  const all = lines(plan);
  const protect = all.indexOf('(deny file-write*');
  const back = all.indexOf('(allow file-write*');
  const never = all.lastIndexOf('(deny file-write*');
  assert.ok(protect < back && back < never && never < index(plan, '(allow network-outbound'), 'protect, allow git back, then never');
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

test('an app folder that holds or sits in credentials, Library, a hidden home folder or a .git folder is refused', () => {
  const refused = [
    '/Users/dana/.ssh', '/Users/dana/.ssh/x', '/Users/dana/.config', '/Users/dana/.config/project', '/Users/dana/.cache/x', '/Users/dana/.local',
    '/Users/dana/Library', '/Users/dana/Library/Application Support', '/Users/dana/Library/Developer/x', base.userData, `${base.userData}/x`,
    '/Library', '/Library/Keychains/x', '/Users/dana/code/shop/.git', '/Users/dana/code/shop/.git/objects/x', '/Users/dana/code/shop/.GIT/x',
  ];
  for (const appFolder of refused) {
    assert.ok(appFolderProblem({ appFolder, home, userData: base.userData }), appFolder);
    assert.match(sandboxPlan({ ...base, appFolder }).error, /will not sandbox/, appFolder);
  }
  for (const appFolder of ['/Users/dana/1904/shop', '/Users/dana/Documents/code/shop', '/Users/dana/code/.hidden-inside-ok', '/Volumes/Work/shop', '/Users/dana/sshkeys', '/Users/dana/code/shop.git', '/Users/dana/code/.github']) {
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
  const git = block(plan, '(allow file-write*');
  assert.deepEqual([...new Set(paramsIn(git, plan))], [`${app}/.git`], 'the app’s .git is never resolved: a link out of the folder stays unwritable');
});

// ── Git's settings for a run ──

test('git’s settings for a run: only the name and email, quoted, in the run’s temporary folder', async () => {
  const written = [];
  const writeFile = async (file, text, options) => { written.push({ file, text, options }); };
  const plain = await gitConfigForRun({ tempDir: base.tempDir, name: 'Dana Smith', email: 'dana@example.com', writeFile });
  assert.equal(plain.file, `${base.tempDir}/gitconfig`);
  assert.deepEqual(plain.env, { GIT_CONFIG_GLOBAL: `${base.tempDir}/gitconfig` });
  assert.equal(plain.text, '[user]\n\tname = "Dana Smith"\n\temail = "dana@example.com"\n');
  assert.deepEqual(written, [{ file: plain.file, text: plain.text, options: { mode: 0o600 } }]);

  // A value can never start a setting of its own.
  const tricky = await gitConfigForRun({ tempDir: base.tempDir, name: 'Dana "DJ" \\ Smith\n[core]\n\tfsmonitor = x', email: ' dana@example.com\r\n', writeFile });
  assert.equal(tricky.text, '[user]\n\tname = "Dana \\"DJ\\" \\\\ Smith[core]fsmonitor = x"\n\temail = "dana@example.com"\n');
  assert.equal(tricky.text.split('\n').filter(line => line.startsWith('[')).length, 1, 'one section');

  const lfs = await gitConfigForRun({ tempDir: base.tempDir, email: 'dana@example.com', lfs: true, writeFile });
  assert.equal(lfs.text, '[user]\n\temail = "dana@example.com"\n[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n');
  const none = await gitConfigForRun({ tempDir: base.tempDir, writeFile });
  assert.equal(none.text, '', 'no identity: an empty file, still in place of ~/.gitconfig');
  assert.deepEqual(none.env, { GIT_CONFIG_GLOBAL: `${base.tempDir}/gitconfig` });

  const failed = await gitConfigForRun({ tempDir: base.tempDir, name: 'Dana', writeFile: async () => { throw Object.assign(new Error('no'), { code: 'EACCES' }); } });
  assert.deepEqual(failed.env, { GIT_CONFIG_GLOBAL: '/dev/null' }, 'never falls back to ~/.gitconfig');
  assert.equal(failed.error, 'EACCES');
  await assert.rejects(gitConfigForRun({ tempDir: 'relative', writeFile }), /absolute/);
});

// ── Removing a run's temporary folder ──

test('the run’s temporary folder is removed inside the sandbox, by /bin/rm, which can write only that folder', () => {
  const plan = cleanupPlan({ tempDir: base.tempDir });
  assert.equal(plan.file, SANDBOX_EXEC);
  assert.deepEqual(plan.args, ['-D', `P0=${base.tempDir}`, '-p', plan.profile, REMOVE_PROGRAM, '-rf', '--', base.tempDir]);
  assert.equal(REMOVE_PROGRAM, '/bin/rm');
  assert.deepEqual(plan.params, { P0: base.tempDir });
  const profile = lines(plan);
  assert.deepEqual(profile.slice(0, 3), ['(version 1)', '(deny default)', '(allow process-exec (literal "/bin/rm"))']);
  assert.deepEqual(profile.filter(line => line.startsWith('(allow') && line.includes('write')), ['(allow file-write* (subpath (param "P0")))']);
  assert.doesNotMatch(plan.profile, /network|mach-lookup|process-fork|process-exec\*|Users|1904-run/);
  const { canWrite } = evaluator(plan);
  assert.equal(canWrite(base.tempDir), true);
  assert.equal(canWrite(`${base.tempDir}/sub/x`), true);
  for (const file of ['/Users/dana/Documents/x', '/private/var/folders/xy/T/1904-run-other/x', `${base.tempDir}-x`, '/private/var/folders/xy/T']) assert.equal(canWrite(file), false, file);

  for (const tempDir of ['relative/1904-run-x', '/', '/Users/dana', '/private/var/folders/xy/T/other', '/private/var/folders/xy/T/1904-run-x/', '/a/../1904-run-x', '/1904-run-x', 'x\u0000', undefined]) {
    assert.ok(cleanupPlan({ tempDir }).error, String(tempDir));
  }
  assert.ok(path.posix.basename(base.tempDir).startsWith(RUN_FOLDER_PREFIX));
});
