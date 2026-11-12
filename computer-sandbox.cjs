// Use My Computer: the macOS sandbox a command runs in unless the person approves full access.
//
// The profile denies everything by default and allows only what command-line tools need: running
// and forking processes, signalling its own processes, reading a named set of system settings,
// semaphores and shared memory, a short named list of system services, reading the system (but not
// any home folder, other drives, local database files or other apps' temporary files), reading the
// app's folder, the run's temporary folder and named toolchain folders, and writing only the app's
// folder and the temporary folder. Inside the app's folder, files other tools later run or trust
// outside the sandbox (git's folder beyond what ordinary git work writes, editor and coding-agent
// settings, hook configurations, .envrc) cannot be written. Credential stores, git's own settings
// and 1904 Desktop's own data come last and win over every allowance. The network is off unless the
// person allowed it, and then reaches neither this computer's loopback services nor binds outside
// loopback. Never allowed: Apple events, launching apps or URLs, background jobs, preference writes,
// mounting, the pasteboard and the window server.
//
// This follows the deny-by-default approach of the Seatbelt policy that Codex CLI publishes (Apache
// License 2.0); no text of it is reused.
//
// No path is ever written into the profile text. Every path goes to sandbox-exec as its own
// `-D Pn=<path>` argument and the profile refers to it as (param "Pn"), so no folder name, however
// it is spelled, can end a string and add a rule of its own.
// No Electron in here, so the profile can be tested with plain Node; how macOS enforces it can only
// be checked on a Mac.

const path = require('node:path');

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
/** Every run's temporary folder name starts with this. */
const RUN_FOLDER_PREFIX = '1904-run-';

/**
 * A Seatbelt regex in which every ASCII letter matches either case, for paths on a disk that ignores
 * case (the default on macOS): `.GIT/config` is `.git/config` there. Seatbelt regexes take no flags,
 * so each letter becomes a bracket pair. Letters inside brackets and escapes before letters are
 * refused, so a pattern cannot keep a case by accident.
 */
function caseless(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '\\') {
      const next = pattern[i + 1];
      if (next === undefined || /[A-Za-z]/.test(next)) throw new Error(`caseless: unsupported escape in ${pattern}`);
      out += char + next;
      i += 1;
    } else if (char === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end < 0) throw new Error(`caseless: unclosed bracket in ${pattern}`);
      const set = pattern.slice(i, end + 1);
      if (/[A-Za-z]/.test(set)) throw new Error(`caseless: letters in a bracket in ${pattern}`);
      out += set;
      i = end;
    } else if (/[A-Za-z]/.test(char)) {
      out += `[${char.toLowerCase()}${char.toUpperCase()}]`;
    } else {
      out += char;
    }
  }
  return out;
}

/** `folder` and everything in it, in any case, as a regex. */
const caselessSubpath = folder => `^${caseless(folder.replace(/\./g, '\\.'))}(/.*)?$`;

/**
 * Toolchain folders under the home folder a command may read (never write), so installed runtimes
 * and caches work. Each holds programs or downloaded packages, not credentials: where a tool keeps
 * credentials beside its cache (Gradle, Maven, Cargo, RubyGems), only the cache folder is listed.
 * A global npmrc inside one of them (nvm, Volta, asdf) is denied by NPMRC_ANYWHERE.
 */
const TOOLCHAIN_FOLDERS = Object.freeze([
  '.nvm', //                     Node versions installed with nvm
  '.npm', //                     npm's download cache (its tokens are in ~/.npmrc, denied)
  '.node-gyp', //                Node headers for native modules
  '.bun', //                     Bun and its install cache
  '.volta', //                   Volta's tool shims
  '.deno', //                    Deno and its cache
  '.asdf', //                    runtimes installed with asdf
  '.pyenv', //                   Python versions
  '.rbenv', //                   Ruby versions
  '.rustup', //                  Rust toolchains
  '.cargo/bin', //               Rust tools (not ~/.cargo/credentials)
  '.cargo/registry', //          downloaded crates
  '.cargo/git', //               crates fetched from git
  'go/bin', //                   Go tools (not ~/go/src, which holds the person's code)
  'go/pkg', //                   Go module cache
  '.local/bin', //               tools installed with pipx, uv and similar
  '.local/share/uv', //          Python versions installed with uv
  'Library/pnpm', //             pnpm and its store
  '.gradle/caches', //           not ~/.gradle/gradle.properties, which holds credentials
  '.gradle/wrapper', //          Gradle versions
  '.m2/repository', //           not ~/.m2/settings.xml, which holds credentials
  '.cocoapods/repos', //         CocoaPods specs
  '.sdkman/candidates', //       JDKs and build tools from SDKMAN
]);
/**
 * Single toolchain files a command may read: git's global ignore rules and attributes. Never git's
 * settings (they can hold tokens): a sandboxed git reads the file gitConfigForRun writes instead.
 */
const TOOLCHAIN_FILES = Object.freeze(['.config/git/ignore', '.config/git/attributes']);

/** Credential stores under the home folder: never read or written, even inside an allowed folder. */
const CREDENTIAL_FOLDERS = Object.freeze([
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.password-store', '.terraform.d',
  '.config/gh', '.config/gcloud', '.config/op', '.config/hub', '.codex', '.claude', '.gemini',
  'Library/Keychains',
]);
/** Files under the home folder that hold credentials, or often do (git's settings: tokens in url.*.insteadOf, http.extraHeader). */
const CREDENTIAL_FILES = Object.freeze([
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.config/git/credentials', '.yarnrc.yml', '.vault-token', '.pgpass',
  '.cargo/credentials', '.cargo/credentials.toml', '.gradle/gradle.properties', '.m2/settings.xml', '.m2/settings-security.xml',
  '.gem/credentials', '.gitconfig', '.config/git/config',
]);
/** A global npmrc anywhere (`<prefix>/etc/npmrc`: nvm, Volta, asdf, Homebrew, /usr/local), in any case. */
const NPMRC_ANYWHERE = caseless('/etc/npmrc$');
const SYSTEM_CREDENTIAL_FOLDERS = Object.freeze(['/Library/Keychains']);
/**
 * Outside the home folder, places that are not the system: every home folder (other people's
 * included, and /Users/Shared), other drives, local database files (Homebrew's and MacPorts' var
 * folders, where Postgres, MySQL and Redis keep their data) and other apps' temporary files.
 */
const PRIVATE_SYSTEM_FOLDERS = Object.freeze([
  '/Users', '/Volumes', '/opt/homebrew/var', '/usr/local/var', '/opt/local/var', '/private/tmp', '/private/var/tmp', '/private/var/folders',
]);

/**
 * Inside the app's folder, paths other tools run or trust later, outside the sandbox. A sandboxed
 * command cannot create, change or replace them. Matched in any case, and only within the app's
 * folder. Normal coding files (package.json, tsconfig, lint settings) are not here.
 */
const PROTECTED_SOURCES = Object.freeze([
  // Any .git file or folder at any depth, and everything in one. Ordinary git work in the app's own
  // repository is allowed back by GIT_WRITABLE; nothing else can make a repository or point at one.
  '/\\.git(/.*)?$',
  // Editor, dev container and coding-agent settings: tasks, hooks and servers they start on their own.
  '/\\.(vscode|idea|zed|cursor|devcontainer|claude|codex|gemini|grok|kiro|amazonq|roo|continue|opencode)(/.*)?$',
  '/\\.mcp\\.json$',
  '/\\.devcontainer\\.json$',
  '/[^/]*\\.code-workspace$',
  '/opencode\\.jsonc?$',
  // Hooks that run on commit, and the configurations they read when they do.
  '/\\.(husky|githooks)(/.*)?$',
  '/\\.pre-commit-config\\.ya?ml$',
  '/\\.?lefthook(-local)?\\.(yml|yaml|toml|json|jsonc)$',
  '/\\.lefthook(-local)?(/.*)?$',
  '/\\.lintstagedrc[^/]*$',
  '/lint-staged\\.config\\.[^/]*$',
  // Shell environments that load on entering the folder: direnv and mise.
  '/\\.envrc$',
  '/\\.?mise(\\.[^/]+)?\\.toml$',
  '/\\.mise(/.*)?$',
  '/mise/config[^/]*\\.toml$',
  '/\\.config/(mise|lefthook)[^/]*(/.*)?$',
]);
const PROTECTED_IN_APP = Object.freeze(PROTECTED_SOURCES.map(caseless));

/**
 * What ordinary git work (add, commit, checkout, switch, rebase, merge, cherry-pick, revert, stash,
 * fetch, pull, bisect, gc) writes in the app's own repository, and in its submodules' repositories
 * under .git/modules. Allowed back only under the app's top-level .git. Exact case: git writes these
 * names in lower or upper case as listed, and a variant is simply refused.
 */
const GIT_WRITABLE = Object.freeze([
  '/\\.git/(modules/.+/)?(objects|refs|logs|rebase-merge|rebase-apply|sequencer|rr-cache|lfs)(/.*)?$',
  '/\\.git/(modules/.+/)?(index|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|MERGE_MODE|MERGE_MSG|MERGE_RR|MERGE_AUTOSTASH|CHERRY_PICK_HEAD|REVERT_HEAD|REBASE_HEAD|AUTO_MERGE|COMMIT_EDITMSG|SQUASH_MSG|TAG_EDITMSG|NOTES_EDITMSG|BISECT_[A-Z_]+|packed-refs|gc\\.pid|gc\\.log|sharedindex\\.[0-9a-f]+|index\\.stash\\.[0-9]+|next-index-[0-9]+)(\\.lock)?$',
]);

/**
 * Never, even where GIT_WRITABLE allows: a repository inside the git folder; git's settings, hooks,
 * info, worktree links (commondir, gitdir, worktrees) and shallow list, top-level or in a submodule's
 * repository; and other object stores (alternates). Matched in any case.
 */
const GIT_NEVER = Object.freeze([
  '/\\.git/(.+/)?\\.git(/.*)?$',
  '/\\.git/(modules/.+/)?(config[^/]*|commondir|gitdir|hooks|info|worktrees|shallow)(/.*)?$',
  '/\\.git/(.+/)?objects/info/(http-)?alternates',
].map(caseless));

/** Devices a command may read and write. */
const DEVICE_FILES = Object.freeze(['/dev/null', '/dev/zero', '/dev/random', '/dev/urandom', '/dev/dtracehelper', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/** System settings a command may read: hardware and OS facts, never other processes' arguments. */
const SYSCTL_PREFIXES = Object.freeze(['hw.', 'machdep.cpu.', 'kern.proc.pid.', 'user.']);
const SYSCTL_NAMES = Object.freeze([
  'kern.osrelease', 'kern.ostype', 'kern.osversion', 'kern.osproductversion', 'kern.version', 'kern.hostname',
  'kern.argmax', 'kern.maxfiles', 'kern.maxfilesperproc', 'kern.maxproc', 'kern.ngroups', 'kern.boottime',
  'kern.usrstack64', 'kern.secure_kernel', 'kern.clockrate', 'kern.hv_support', 'kern.osvariant_status',
  'sysctl.proc_cputype', 'sysctl.proc_native', 'sysctl.proc_translated', 'vm.loadavg', 'vm.pagesize',
  'security.mac.lockdown_mode_state',
]);
/** System services every command may reach: logging, notifications, user and group lookups, preference reads. */
const SERVICES = Object.freeze([
  'com.apple.logd', 'com.apple.system.logger', 'com.apple.system.notification_center',
  'com.apple.system.opendirectoryd.libinfo', 'com.apple.system.opendirectoryd.membership',
  'com.apple.cfprefsd.daemon', 'com.apple.cfprefsd.agent',
]);
/** Only with the internet allowed: name lookups, certificate checks and proxy settings. */
const NETWORK_SERVICES = Object.freeze([
  'com.apple.dnssd.service', 'com.apple.trustd', 'com.apple.trustd.agent', 'com.apple.SystemConfiguration.configd', 'com.apple.networkd',
]);
/** Preference domains a command may read: the global settings (language, number formats) and Xcode's. */
const PREFERENCE_DOMAINS = Object.freeze(['kCFPreferencesAnyApplication', 'com.apple.dt.Xcode']);

/** The program that deletes a run's temporary folder, inside its own sandbox. */
const REMOVE_PROGRAM = '/bin/rm';

const inside = (root, target) => {
  const relative = path.posix.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
};
const GIT_COMPONENT = /(^|\/)\.git(\/|$)/i;

/**
 * Why a folder cannot be an app's folder under the sandbox, or undefined. Refused: a folder inside
 * or containing a credential store or 1904 Desktop's data, anything in ~/Library, a dot-folder
 * directly in the home folder or anything inside one, and anything inside a .git folder.
 */
function appFolderProblem({ appFolder, home, userData, realpath = value => value }) {
  const resolve = value => { try { return realpath(value); } catch { return value; } };
  const both = value => [...new Set([value, resolve(value)])];
  const sensitive = [
    ...[...CREDENTIAL_FOLDERS, ...CREDENTIAL_FILES].map(entry => path.posix.join(home, entry)),
    ...SYSTEM_CREDENTIAL_FOLDERS,
    ...(userData ? [userData] : []),
  ].flatMap(both);
  for (const candidate of both(appFolder)) {
    if (sensitive.some(blocked => inside(blocked, candidate) || inside(candidate, blocked))) {
      return 'This folder holds or is inside a folder that holds keys or 1904 Desktop’s own data. Choose another folder for this app.';
    }
    if (GIT_COMPONENT.test(candidate)) return 'Choose a folder that is not inside a .git folder.';
    for (const homeDir of both(home)) {
      if (inside(path.posix.join(homeDir, 'Library'), candidate)) return 'Choose a folder outside your Library folder.';
      const relative = path.posix.relative(homeDir, candidate);
      if (relative && !relative.startsWith('..') && relative.split('/')[0].startsWith('.')) {
        return 'Choose a folder that is not a hidden folder in your home folder.';
      }
    }
  }
  return undefined;
}

/** The sysctl rule both profiles share. */
const sysctlRule = list => [
  '(allow sysctl-read',
  ...list(SYSCTL_PREFIXES.map(prefix => `(sysctl-name-prefix "${prefix}")`)),
  ...list(SYSCTL_NAMES.map(name => `(sysctl-name "${name}")`)),
  ')',
];
const listOf = (lines, indent = '  ') => lines.map(line => indent + line);

/**
 * The sandbox for one run, or `{ error }`. `realpath` resolves a path that exists (the sandbox
 * matches resolved paths, and /var is /private/var); a path that cannot be resolved is used as is.
 * `network`: the person allowed internet access for this command.
 * Returns `{ file, args, profile, params }`: `args` already holds every -D and the -p profile.
 */
function sandboxPlan({ appFolder, tempDir, home, userData, network = false, realpath = value => value }) {
  const problem = appFolderProblem({ appFolder, home, userData, realpath });
  if (problem) return { error: `1904 Desktop will not sandbox a command in this folder. ${problem}` };
  const resolve = value => { try { return realpath(value); } catch { return value; } };
  const both = value => [...new Set([value, resolve(value)])];
  const app = resolve(appFolder);
  const temp = resolve(tempDir);

  const params = [];
  const param = value => {
    if (typeof value !== 'string' || !value.startsWith('/') || value.includes('\u0000')) throw new Error('A sandbox path must be absolute.');
    params.push([`P${params.length}`, value]);
    return `(param "P${params.length - 1}")`;
  };
  const homes = both(home);
  const appParam = param(app);
  const tempParam = param(temp);
  // The app's own repository folder, as a path under the app's folder (never resolved: if .git is a
  // link, what it points to is outside the app's folder and stays unwritable).
  const gitParam = param(path.posix.join(app, '.git'));
  const inApp = pattern => `(require-all (subpath ${appParam}) (regex #"${pattern}"))`;

  const lines = [
    '(version 1)',
    '(deny default)',

    // Processes: run and fork, signal and inspect only its own.
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    ...sysctlRule(listOf),
    '(allow ipc-posix-sem)',
    '(allow ipc-posix-shm)',
    '(allow mach-lookup',
    ...listOf(SERVICES.map(service => `(global-name "${service}")`)),
    ')',
    '(allow user-preference-read',
    ...listOf(PREFERENCE_DOMAINS.map(domain => `(preference-domain "${domain}")`)),
    ')',

    // Reading: the system, but not home folders, other drives, local databases or other apps'
    // temporary files, in any case.
    '(allow file-read*)',
    '(allow file-map-executable)',
    '(deny file-read*',
    ...listOf(homes.map(dir => `(subpath ${param(dir)})`)),
    ...listOf(PRIVATE_SYSTEM_FOLDERS.map(folder => `(subpath "${folder}")`)),
    ...listOf(PRIVATE_SYSTEM_FOLDERS.map(folder => `(regex #"${caselessSubpath(folder)}")`)),
    ')',
    // Looking a path up (not listing or reading it), so tools can find their way to the app's folder.
    '(allow file-read-metadata)',
    // Back: the app's folder, the run's temporary folder, and toolchains.
    '(allow file-read*',
    `  (subpath ${appParam})`,
    `  (subpath ${tempParam})`,
    ...listOf(TOOLCHAIN_FOLDERS.flatMap(folder => both(path.posix.join(home, folder))).map(folder => `(subpath ${param(folder)})`)),
    ...listOf(TOOLCHAIN_FILES.flatMap(file => both(path.posix.join(home, file))).map(file => `(literal ${param(file)})`)),
    ')',

    // Writing: only the app's folder, the run's temporary folder and a few devices.
    `(allow file-write* (subpath ${appParam}) (subpath ${tempParam}))`,
    '(allow file-read* file-write* file-ioctl',
    ...listOf(DEVICE_FILES.map(device => `(literal "${device}")`)),
    '  (subpath "/dev/fd")',
    ')',
    // In the app's folder, never what other tools run or trust later outside the sandbox.
    '(deny file-write*',
    ...listOf(PROTECTED_IN_APP.map(inApp)),
    ')',
    // Back: what ordinary git work writes in the app's own repository.
    '(allow file-write*',
    ...listOf(GIT_WRITABLE.map(pattern => `(require-all (subpath ${gitParam}) (regex #"${pattern}"))`)),
    ')',
    // And never, even there: git's settings, hooks and links to other repositories.
    '(deny file-write*',
    ...listOf(GIT_NEVER.map(inApp)),
    ')',

    // Network: none, unless the person allowed it for this command.
    ...(network ? [
      '(allow network-outbound (remote ip "*:*"))',
      // Not this computer's own services over loopback.
      '(deny network-outbound (remote ip "localhost:*"))',
      // A server it starts listens on loopback only.
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      '(allow network-outbound (literal "/private/var/run/mDNSResponder"))',
      '(allow mach-lookup',
      ...listOf(NETWORK_SERVICES.map(service => `(global-name "${service}")`)),
      ')',
    ] : []),

    // Last, so nothing above can open them: credential stores, git's settings, global npmrc files
    // and 1904 Desktop's own data.
    '(deny file-read* file-write*',
    ...listOf(homes.flatMap(dir => CREDENTIAL_FOLDERS.map(folder => path.posix.join(dir, folder))).flatMap(both).map(folder => `(subpath ${param(folder)})`)),
    ...listOf(homes.flatMap(dir => CREDENTIAL_FILES.map(file => path.posix.join(dir, file))).flatMap(both).map(file => `(literal ${param(file)})`)),
    `  (regex #"${NPMRC_ANYWHERE}")`,
    ...listOf(SYSTEM_CREDENTIAL_FOLDERS.map(folder => `(subpath "${folder}")`)),
    ...listOf(SYSTEM_CREDENTIAL_FOLDERS.map(folder => `(regex #"${caselessSubpath(folder)}")`)),
    ...listOf((userData ? both(userData) : []).map(folder => `(subpath ${param(folder)})`)),
    ')',
  ];
  const profile = lines.join('\n');
  return {
    file: SANDBOX_EXEC,
    args: [...params.flatMap(([name, value]) => ['-D', `${name}=${value}`]), '-p', profile],
    profile,
    params: Object.fromEntries(params),
  };
}

/** A git setting's value, quoted for a gitconfig file: no control characters, so it cannot start a line of its own. */
function gitValue(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').trim().slice(0, 256);
  return text ? `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : '';
}

/**
 * Git's settings for one sandboxed run, which cannot read ~/.gitconfig or ~/.config/git/config. Writes
 * a file in the run's temporary folder holding only the person's name and email (which 1904 Desktop
 * reads outside the sandbox) and, with `lfs`, Git LFS's standard filter, so LFS files are not
 * committed whole. Returns `{ file, text, env }`; `env.GIT_CONFIG_GLOBAL` makes git read that file in
 * place of both global files. The repository's own settings still apply over it. If the file cannot
 * be written, git reads no global settings at all (`/dev/null`), and `error` says why.
 */
async function gitConfigForRun({ tempDir, name, email, lfs = false, writeFile = require('node:fs/promises').writeFile }) {
  if (typeof tempDir !== 'string' || !path.posix.isAbsolute(tempDir) || tempDir.includes('\u0000')) throw new Error('A sandbox path must be absolute.');
  const user = [['name', gitValue(name)], ['email', gitValue(email)]].filter(([, value]) => value);
  const lines = [
    ...(user.length ? ['[user]', ...user.map(([key, value]) => `\t${key} = ${value}`)] : []),
    ...(lfs ? ['[filter "lfs"]', '\tclean = git-lfs clean -- %f', '\tsmudge = git-lfs smudge -- %f', '\tprocess = git-lfs filter-process', '\trequired = true'] : []),
  ];
  const text = lines.length ? `${lines.join('\n')}\n` : '';
  const file = path.posix.join(tempDir, 'gitconfig');
  try {
    await writeFile(file, text, { mode: 0o600 });
  } catch (error) {
    return { file: '/dev/null', text: '', env: { GIT_CONFIG_GLOBAL: '/dev/null' }, error: error?.code || error?.message || 'write failed' };
  }
  return { file, text, env: { GIT_CONFIG_GLOBAL: file } };
}

/**
 * Deleting a run's temporary folder on macOS inside the sandbox: `/bin/rm -rf` under a profile that
 * can run only /bin/rm and write only that folder, so the delete cannot reach anything outside it,
 * whatever a process the command left behind does to the folder meanwhile. `tempDir` is the path as
 * resolved when the folder was made, and is never resolved again here. Returns
 * `{ file, args, profile, params }` (spawn `file` with `args`), or `{ error }`.
 */
function cleanupPlan({ tempDir }) {
  if (typeof tempDir !== 'string' || !path.posix.isAbsolute(tempDir) || tempDir.includes('\u0000') || tempDir.endsWith('/')
    || path.posix.normalize(tempDir) !== tempDir || !path.posix.basename(tempDir).startsWith(RUN_FOLDER_PREFIX)
    || tempDir.split('/').length < 3) {
    return { error: 'Not a run’s temporary folder.' };
  }
  const lines = [
    '(version 1)',
    '(deny default)',
    `(allow process-exec (literal "${REMOVE_PROGRAM}"))`,
    ...sysctlRule(listOf),
    '(allow file-read*)',
    '(allow file-write* (subpath (param "P0")))',
  ];
  const profile = lines.join('\n');
  return {
    file: SANDBOX_EXEC,
    args: ['-D', `P0=${tempDir}`, '-p', profile, REMOVE_PROGRAM, '-rf', '--', tempDir],
    profile,
    params: { P0: tempDir },
  };
}

module.exports = {
  SANDBOX_EXEC, RUN_FOLDER_PREFIX, REMOVE_PROGRAM, TOOLCHAIN_FOLDERS, TOOLCHAIN_FILES, CREDENTIAL_FOLDERS, CREDENTIAL_FILES,
  NPMRC_ANYWHERE, SYSTEM_CREDENTIAL_FOLDERS, PRIVATE_SYSTEM_FOLDERS, PROTECTED_SOURCES, PROTECTED_IN_APP, GIT_WRITABLE, GIT_NEVER,
  DEVICE_FILES, SYSCTL_PREFIXES, SYSCTL_NAMES, SERVICES, NETWORK_SERVICES, PREFERENCE_DOMAINS,
  caseless, caselessSubpath, appFolderProblem, sandboxPlan, gitConfigForRun, cleanupPlan,
};
