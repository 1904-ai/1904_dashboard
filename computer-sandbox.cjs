// Use My Computer: the macOS sandbox a command runs in unless the person approves full access.
//
// The profile denies everything by default and allows only what command-line tools need: running
// and forking processes, signalling its own processes, reading a named set of system settings,
// semaphores and shared memory, a short named list of system services, reading the system (but not
// the home folder, other drives or other apps' temporary files), reading the app's folder, the run's
// temporary folder and named toolchain folders, and writing only the app's folder and the temporary
// folder. Inside the app's folder, files other tools later run outside the sandbox (git config and
// hooks, editor task folders, .envrc) cannot be written. Credential stores and 1904 Desktop's own
// data come last and win over every allowance. The network is off unless the person allowed it,
// and then reaches neither this computer's loopback services nor binds outside loopback.
// Never allowed: Apple events, launching apps or URLs, background jobs, preference writes, mounting,
// the pasteboard and the window server.
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

/**
 * Toolchain folders under the home folder a command may read (never write), so installed runtimes
 * and caches work. Each holds programs or downloaded packages, not credentials: where a tool keeps
 * credentials beside its cache (Gradle, Maven, Cargo, RubyGems), only the cache folder is listed.
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
/** Single toolchain files a command may read: git's own settings and ignore rules, never its credentials. */
const TOOLCHAIN_FILES = Object.freeze(['.gitconfig', '.config/git/config', '.config/git/ignore', '.config/git/attributes']);

/** Credential stores under the home folder: never read or written, even inside an allowed folder. */
const CREDENTIAL_FOLDERS = Object.freeze([
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.password-store', '.terraform.d',
  '.config/gh', '.config/gcloud', '.config/op', '.config/hub', '.codex', '.claude', '.gemini',
  'Library/Keychains',
]);
const CREDENTIAL_FILES = Object.freeze([
  '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.config/git/credentials', '.yarnrc.yml', '.vault-token', '.pgpass',
  '.cargo/credentials', '.cargo/credentials.toml', '.gradle/gradle.properties', '.m2/settings.xml', '.m2/settings-security.xml',
  '.gem/credentials',
]);
const SYSTEM_CREDENTIAL_FOLDERS = Object.freeze(['/Library/Keychains']);
/** Outside the home folder, places that are not the system: other drives and other apps' temporary files. */
const PRIVATE_SYSTEM_FOLDERS = Object.freeze(['/Volumes', '/private/tmp', '/private/var/tmp', '/private/var/folders']);

/**
 * Inside the app's folder, paths other tools run or trust later, outside the sandbox. A sandboxed
 * command cannot create, change or replace them. Fixed patterns, matched only within the app's folder.
 */
const PROTECTED_IN_APP = Object.freeze([
  '/\\.git$', //                                        creating or replacing a repository (or a gitfile pointing elsewhere)
  '/\\.git/(config[^/]*|hooks|hooks/.*|info|info/.*)$', // git settings, hooks and attributes
  '/\\.git/modules/.+/(config[^/]*|hooks|hooks/.*|info|info/.*)$', // the same for submodules
  '/\\.(vscode|idea|zed|cursor|husky)(/.*)?$', //          editor tasks and hook folders that run commands
  '/\\.envrc$', //                                      direnv
  '/\\.pre-commit-config\\.yaml$', //                    pre-commit hooks
]);

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

const inside = (root, target) => {
  const relative = path.posix.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative));
};

/**
 * Why a folder cannot be an app's folder under the sandbox, or undefined. Refused: a folder inside
 * or containing a credential store or 1904 Desktop's data, anything in ~/Library, and a dot-folder
 * directly in the home folder or anything inside one.
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
  const list = (lines, indent = '  ') => lines.map(line => indent + line);

  const lines = [
    '(version 1)',
    '(deny default)',

    // Processes: run and fork, signal and inspect only its own.
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read',
    ...list(SYSCTL_PREFIXES.map(prefix => `(sysctl-name-prefix "${prefix}")`)),
    ...list(SYSCTL_NAMES.map(name => `(sysctl-name "${name}")`)),
    ')',
    '(allow ipc-posix-sem)',
    '(allow ipc-posix-shm)',
    '(allow mach-lookup',
    ...list(SERVICES.map(service => `(global-name "${service}")`)),
    ')',
    '(allow user-preference-read',
    ...list(PREFERENCE_DOMAINS.map(domain => `(preference-domain "${domain}")`)),
    ')',

    // Reading: the system, but not the home folder, other drives or other apps' temporary files.
    '(allow file-read*)',
    '(allow file-map-executable)',
    '(deny file-read*',
    ...list(homes.map(dir => `(subpath ${param(dir)})`)),
    ...list(PRIVATE_SYSTEM_FOLDERS.map(folder => `(subpath "${folder}")`)),
    ')',
    // Looking a path up (not listing or reading it), so tools can find their way to the app's folder.
    '(allow file-read-metadata)',
    // Back: the app's folder, the run's temporary folder, and toolchains.
    '(allow file-read*',
    `  (subpath ${appParam})`,
    `  (subpath ${tempParam})`,
    ...list(TOOLCHAIN_FOLDERS.flatMap(folder => both(path.posix.join(home, folder))).map(folder => `(subpath ${param(folder)})`)),
    ...list(TOOLCHAIN_FILES.flatMap(file => both(path.posix.join(home, file))).map(file => `(literal ${param(file)})`)),
    ')',

    // Writing: only the app's folder, the run's temporary folder and a few devices.
    `(allow file-write* (subpath ${appParam}) (subpath ${tempParam}))`,
    '(allow file-read* file-write* file-ioctl',
    ...list(DEVICE_FILES.map(device => `(literal "${device}")`)),
    '  (subpath "/dev/fd")',
    ')',
    // In the app's folder, never what other tools run or trust later outside the sandbox.
    '(deny file-write*',
    ...list(PROTECTED_IN_APP.map(pattern => `(require-all (subpath ${appParam}) (regex #"${pattern}"))`)),
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
      ...list(NETWORK_SERVICES.map(service => `(global-name "${service}")`)),
      ')',
    ] : []),

    // Last, so nothing above can open them: credential stores and 1904 Desktop's own data.
    '(deny file-read* file-write*',
    ...list(homes.flatMap(dir => CREDENTIAL_FOLDERS.map(folder => path.posix.join(dir, folder))).flatMap(both).map(folder => `(subpath ${param(folder)})`)),
    ...list(homes.flatMap(dir => CREDENTIAL_FILES.map(file => path.posix.join(dir, file))).flatMap(both).map(file => `(literal ${param(file)})`)),
    ...list(SYSTEM_CREDENTIAL_FOLDERS.map(folder => `(subpath "${folder}")`)),
    ...list((userData ? both(userData) : []).map(folder => `(subpath ${param(folder)})`)),
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

module.exports = {
  SANDBOX_EXEC, TOOLCHAIN_FOLDERS, TOOLCHAIN_FILES, CREDENTIAL_FOLDERS, CREDENTIAL_FILES, SYSTEM_CREDENTIAL_FOLDERS,
  PRIVATE_SYSTEM_FOLDERS, PROTECTED_IN_APP, DEVICE_FILES, SYSCTL_PREFIXES, SYSCTL_NAMES, SERVICES, NETWORK_SERVICES,
  PREFERENCE_DOMAINS, appFolderProblem, sandboxPlan,
};
