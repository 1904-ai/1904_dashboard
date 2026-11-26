// Deploy From This Computer, connecting to a host: instead of typing an ssh command, the person
// names the host, the user and the port and picks how to sign in. 1904 Desktop then starts the
// system's own ssh itself, with every argument passed as its own word (no shell reads them), the
// host's identity pinned to what the person saw and trusted, and the secret it needs for that run
// only. A deploy key or a saved password is kept encrypted with the operating system's key store;
// a password typed for one use is never kept. Nothing here is ever sent to 1904.
// No Electron in here, so every decision can be tested with plain Node.

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { computerId, label } = require('./computer-policy.cjs');

/**
 * key: a key pair 1904 Desktop makes for this app and host (the default).
 * ssh: whatever the person's own ssh already uses (their keys, agent and SSH config).
 * password-saved: a password kept encrypted on this computer.
 * password-ask: a password the person types at every deploy.
 */
const DEPLOY_AUTH = Object.freeze(['key', 'ssh', 'password-saved', 'password-ask']);
const SECRETS_FILE = 'computer-deploy-secrets.json';
const HOST_KEYS_MAX = 8;
const PASSWORD_MAX = 1024;
/** How long one connection attempt may take before ssh gives up. */
const CONNECT_TIMEOUT_SECONDS = 20;
/** Reading a host's identity, making a key and installing one are short jobs. */
const SETUP_TIMEOUT_MS = 45_000;
/** The variable the password travels in, from this app to the helper ssh runs to ask for it. Never on a command line, never in a file. */
const SECRET_ENV = 'DESKTOP_1904_SSH_SECRET';

// Never starting with a dash, so neither can be read as an option even before the `--` that precedes the host.
const HOST_NAME = /^(?!-)[A-Za-z0-9._:-]{1,253}$/;
const HOST_USER = /^(?!-)[A-Za-z0-9._@\\-]{1,64}$/;
const KEY_TYPES = ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-rsa', 'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com'];
const KEY_BLOB = /^[A-Za-z0-9+/]{40,4096}={0,2}$/;
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{40,200}={0,2}( [A-Za-z0-9._@:+-]{1,100})?$/;
const appKey = key => typeof key === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);

/** The name ssh files a host's key under: `host`, or `[host]:port` for any port but 22. */
const hostPattern = (name, port) => port === 22 ? name : `[${name}]:${port}`;

/** One line of a known_hosts file for exactly this host and port, or undefined. */
function hostKeyLine(line, { name, port }) {
  const parts = typeof line === 'string' ? line.trim().split(' ') : [];
  if (parts.length !== 3 || parts[0] !== hostPattern(name, port) || !KEY_TYPES.includes(parts[1]) || !KEY_BLOB.test(parts[2])) return undefined;
  return parts.join(' ');
}

/** What ssh itself shows for a host key, such as `ED25519 SHA256:abc…`, so the person can compare it with what the host's owner gave them. */
function fingerprint(line) {
  const [, type, blob] = String(line).split(' ');
  const names = { 'ssh-ed25519': 'ED25519', 'ssh-rsa': 'RSA' };
  const name = names[type] || (type.startsWith('ecdsa') ? 'ECDSA' : type.startsWith('sk-ssh-ed25519') ? 'ED25519-SK' : type.startsWith('sk-ecdsa') ? 'ECDSA-SK' : type);
  return `${name} SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Checks the host the person typed. Returns `{ ok: true, host }` or `{ ok: false, error }`.
 * With the person's own ssh setup the user and the port may be left to their SSH config, and the
 * host's identity is theirs to manage. Every other way of signing in needs a user, and an identity
 * the person has trusted for exactly this host and port.
 */
function cleanHost(value) {
  const fail = error => ({ ok: false, error });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Name the host to deploy to.');
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!HOST_NAME.test(name)) return fail('Name the host as an address or a name from your SSH settings, such as deploy.example.com or 10.0.0.12.');
  const auth = DEPLOY_AUTH.includes(value.auth) ? value.auth : 'key';
  const user = typeof value.user === 'string' ? value.user.trim() : '';
  if (user ? !HOST_USER.test(user) : auth !== 'ssh') return fail('Enter the user name to sign in as on the host.');
  let port = value.port === undefined || value.port === null || value.port === '' ? undefined : Number(value.port);
  if (port !== undefined && !(Number.isSafeInteger(port) && port >= 1 && port <= 65535)) return fail('Enter a port between 1 and 65535.');
  if (auth !== 'ssh') port ??= 22;
  let keys = [];
  if (auth !== 'ssh') {
    keys = [...new Set((Array.isArray(value.keys) ? value.keys : []).map(line => hostKeyLine(line, { name, port })).filter(Boolean))].slice(0, HOST_KEYS_MAX);
    if (!keys.length) return fail('Check the host first: choose Check host and confirm it is the one you expect.');
  }
  return { ok: true, host: { name, user, ...(port !== undefined ? { port } : {}), auth, keys } };
}

const AUTH_TEXT = {
  key: 'signing in with the deploy key 1904 Desktop made',
  ssh: 'signing in the way your own ssh does',
  'password-saved': 'signing in with the password saved on this computer',
  'password-ask': 'signing in with a password you type each time',
};

/** How a deploy reaches the host, as the prompt and Computer Activity show it. */
function hostText(host) {
  const where = `${host.user ? `${host.user}@` : ''}${host.name}${host.port && host.port !== 22 ? `, port ${host.port}` : ''}`;
  return `ssh to ${where}, ${AUTH_TEXT[host.auth]}${host.keys.length ? `\n# the host must show ${host.keys.map(fingerprint).join(' or ')}` : ''}`;
}

// ── Starting ssh ───────────────────────────────────────────────────────────

/** The system's own ssh (or ssh-keygen), from the usual place or the search path. */
function sshProgram(name, { platform, env = {}, exists = () => false }) {
  const p = platform === 'windows' ? path.win32 : path.posix;
  const file = platform === 'windows' ? `${name}.exe` : name;
  const usual = platform === 'windows'
    ? [p.join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'OpenSSH', file)]
    : [`/usr/bin/${file}`];
  const searched = String(env.PATH || env.Path || '').split(platform === 'windows' ? ';' : ':').filter(dir => dir && p.isAbsolute(dir)).map(dir => p.join(dir, file));
  for (const candidate of [...usual, ...searched]) {
    try { if (exists(candidate)) return candidate; } catch { /* unreadable entry */ }
  }
  return undefined;
}

/**
 * A file path as the value of an ssh `-o` option, which ssh reads like a line of its config file:
 * quoted so a space cannot split it, with forward slashes so a backslash is never an escape.
 */
function optionPath(file) {
  if (file.includes('"') || /[\r\n]/.test(file)) throw new Error('This computer’s temporary folder has a name ssh cannot be given.');
  return `"${file.replace(/\\/g, '/')}"`;
}

/** The options that pin a connection to the host keys the person trusted and to nothing else. */
function pinned(files) {
  return [
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${optionPath(files.knownHosts)}`, '-o', `GlobalKnownHostsFile=${optionPath(files.knownHosts + '.none')}`,
    '-o', 'UpdateHostKeys=no', '-o', 'CheckHostIP=no',
  ];
}

const target = host => [...(host.port !== undefined ? ['-p', String(host.port)] : []), ...(host.user ? ['-l', host.user] : []), '--', host.name];
const COMMON = ['-T', '-o', `ConnectTimeout=${CONNECT_TIMEOUT_SECONDS}`, '-o', 'ServerAliveInterval=30', '-o', 'ServerAliveCountMax=4', '-o', 'LogLevel=ERROR'];

/**
 * ssh's arguments for one run of `word` on the host, each its own word, so no shell ever reads the
 * host, the user or a path. `files`: `knownHosts` (the pinned identity) and, for a deploy key, `key`.
 * `password`: sign in with a password, which ssh asks the helper for (askpass below).
 */
function sshArgs({ host, files = {}, word, password = host.auth === 'password-saved' || host.auth === 'password-ask' }) {
  if (host.auth === 'ssh' && !password) return [...COMMON, '-o', 'BatchMode=yes', ...target(host), word];
  if (password) {
    return [...COMMON, '-o', 'BatchMode=no', '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=password,keyboard-interactive',
      '-o', 'NumberOfPasswordPrompts=1', ...pinned(files), ...target(host), word];
  }
  return [...COMMON, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'PreferredAuthentications=publickey', '-i', files.key, ...pinned(files), ...target(host), word];
}

/**
 * Reads a host's identity without signing in: ssh connects, writes the key it was shown into
 * `knownHosts` (an empty file of this app's own) and stops at sign-in, which is not attempted.
 * It goes the way the person's SSH config says, so a host behind a jump host is read through it.
 */
function hostKeyArgs({ host, knownHosts }) {
  return ['-T', '-o', 'ConnectTimeout=15', '-o', 'LogLevel=ERROR', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${optionPath(knownHosts)}`, '-o', `GlobalKnownHostsFile=${optionPath(knownHosts + '.none')}`, '-o', 'HashKnownHosts=no',
    '-o', 'CheckHostIP=no', '-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=none', ...target(host), 'exit'];
}

/** The keys a host showed, from the file hostKeyArgs filled: `[{ line, fingerprint }]`. */
function readHostKeys(text, host) {
  const lines = String(text ?? '').split(/\r?\n/).map(line => hostKeyLine(line, host)).filter(Boolean);
  return [...new Set(lines)].slice(0, HOST_KEYS_MAX).map(line => ({ line, fingerprint: fingerprint(line) }));
}

/** ssh-keygen's arguments for a new key pair with no passphrase, since nobody is there to type one at a deploy. */
function keygenArgs({ file, comment }) {
  return ['-q', '-t', 'ed25519', '-N', '', '-C', `1904-deploy-${String(comment ?? '').replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40) || 'app'}`, '-f', file];
}

/** A public key as ssh-keygen wrote it, or undefined. */
const publicKey = text => {
  const line = typeof text === 'string' ? text.trim() : '';
  return PUBLIC_KEY.test(line) ? line : undefined;
};

/**
 * The script that adds a public key to the host user's authorized keys, once: the folder and the
 * file get the permissions sshd insists on, and a key that is already there is not added again.
 */
function installKeyScript(key, nonce) {
  if (!publicKey(key) || !/^[a-f0-9]{16}$/.test(nonce)) throw new Error('There is no deploy key to install.');
  return [
    'umask 077',
    'mkdir -p "$HOME/.ssh" || exit 1',
    `__1904_key='${key}'`,
    'if grep -qxF "$__1904_key" "$HOME/.ssh/authorized_keys" 2>/dev/null; then :; else printf "%s\\n" "$__1904_key" >>"$HOME/.ssh/authorized_keys" || exit 1; fi',
    'chmod 700 "$HOME/.ssh" 2>/dev/null; chmod 600 "$HOME/.ssh/authorized_keys" 2>/dev/null',
    `echo "__1904_deploy_${nonce}:0"`,
  ].join('\n') + '\n';
}

/** What the person can paste into a terminal on the host themselves instead, to add the key by hand. */
function installKeyCommand(key) {
  if (!publicKey(key)) return '';
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${key}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

/**
 * The helper ssh runs when it wants a password (SSH_ASKPASS): it prints the one this app put in its
 * environment for this run and nothing else. Written into the run's own temp folder and deleted with
 * it. The password is never an argument (other programs can read those) and never in a file.
 */
function askpass({ platform }) {
  if (platform === 'windows') {
    return { name: '1904-askpass.cmd', text: `@echo off\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -Command "[Console]::Out.Write($env:${SECRET_ENV})"\r\n` };
  }
  // Only a question about a password is answered: a passphrase or "are you sure" prompt gets nothing.
  return { name: '1904-askpass', mode: 0o700, text: `#!/bin/sh\ncase "$1" in *[Pp]assword*) printf '%s\\n' "$${SECRET_ENV}" ;; *) exit 1 ;; esac\n` };
}

/** What a password run adds to ssh's environment. DISPLAY is what older ssh needs before it will use the helper at all. */
function passwordEnvironment({ helper, password, env = {} }) {
  return { SSH_ASKPASS: helper, SSH_ASKPASS_REQUIRE: 'force', DISPLAY: typeof env.DISPLAY === 'string' && env.DISPLAY ? env.DISPLAY : ':0', [SECRET_ENV]: password };
}

/** A password as typed: one line, not empty, bounded. Undefined otherwise. */
const cleanPassword = value => typeof value === 'string' && value.length > 0 && value.length <= PASSWORD_MAX && !/[\r\n\u0000]/.test(value) ? value : undefined;

/** Why ssh could not do what was asked, in words for the person, from what it printed. */
function sshProblem(stderr, { password = false } = {}) {
  const text = String(stderr ?? '');
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known/i.test(text)) {
    return 'The host did not show the identity you trusted. If it was rebuilt, choose Check host again and compare it carefully; otherwise do not connect.';
  }
  if (/Permission denied/i.test(text)) return password ? 'The host refused that password, or does not accept passwords.' : 'The host refused to sign in. Check the user name and that the key is installed there.';
  if (/Could not resolve hostname|Name or service not known|nodename nor servname/i.test(text)) return 'That host name could not be found from this computer.';
  if (/timed out|Connection refused|No route to host|Network is unreachable/i.test(text)) return 'This computer could not reach the host. Check the address, the port and that your VPN is connected.';
  return label(text.split(/\r?\n/).filter(Boolean).pop() || '', 300) || 'ssh could not connect to the host.';
}

// ── The secrets this computer keeps ────────────────────────────────────────

/** Electron's safeStorage behind three calls; tests pass a stand-in with the same methods. */
function createVault(safeStorage) {
  return {
    async available() {
      try {
        if (typeof safeStorage?.isAsyncEncryptionAvailable === 'function') return Boolean(await safeStorage.isAsyncEncryptionAvailable());
        return Boolean(safeStorage?.isEncryptionAvailable?.());
      } catch {
        return false;
      }
    },
    async encrypt(text) {
      const bytes = typeof safeStorage.encryptStringAsync === 'function' ? await safeStorage.encryptStringAsync(text) : safeStorage.encryptString(text);
      return Buffer.from(bytes).toString('base64');
    },
    async decrypt(text) {
      const bytes = Buffer.from(text, 'base64');
      if (typeof safeStorage.decryptStringAsync === 'function') return (await safeStorage.decryptStringAsync(bytes)).result;
      return safeStorage.decryptString(bytes);
    },
  };
}

/**
 * A deploy key and a saved password per app, encrypted with the operating system's key store
 * (the Keychain on macOS, DPAPI on Windows) before they touch the disk, and decrypted only for
 * the run that needs them. Like a recipe, each belongs to the pairing it was saved under.
 * Without that key store nothing is kept at all.
 */
function createDeploySecrets({ file, vault }) {
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('1904 Desktop could not read its deploy sign-ins.');
      return {};
    }
  }
  function write(value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  const entry = (appId, pairedId) => {
    const value = appKey(appId) ? read()[appId] : undefined;
    return value && typeof value === 'object' && pairedId && value.computerId === pairedId ? value : undefined;
  };
  async function open(appId, pairedId, field) {
    const sealed = entry(appId, pairedId)?.[field];
    if (typeof sealed !== 'string' || !sealed) return undefined;
    try { return await vault.decrypt(sealed); } catch { return undefined; }
  }
  async function seal(appId, pairedId, fields) {
    if (!appKey(appId) || !computerId(pairedId)) throw new Error('Connect this computer to 1904 first.');
    if (!(await vault.available())) throw new Error('This computer’s secure storage is not available, so nothing was saved.');
    const all = read();
    // Under another pairing nothing of the old entry is carried over.
    const kept = all[appId]?.computerId === pairedId ? all[appId] : {};
    all[appId] = { ...kept, computerId: pairedId, ...fields };
    write(all);
  }
  return {
    /** What is kept for an app under this pairing, never the secrets themselves. */
    summary(appId, pairedId) {
      const value = entry(appId, pairedId);
      return { password: Boolean(value?.password), publicKey: publicKey(value?.publicKey) };
    },
    password: (appId, pairedId) => open(appId, pairedId, 'password'),
    privateKey: (appId, pairedId) => open(appId, pairedId, 'privateKey'),
    async setPassword(appId, pairedId, password) {
      if (!cleanPassword(password)) throw new Error('Enter the password.');
      await seal(appId, pairedId, { password: await vault.encrypt(password) });
    },
    async setKey(appId, pairedId, { privateKey, publicKey: pub }) {
      if (!publicKey(pub) || typeof privateKey !== 'string' || !privateKey.includes('PRIVATE KEY')) throw new Error('The new key could not be read.');
      await seal(appId, pairedId, { privateKey: await vault.encrypt(privateKey), publicKey: publicKey(pub) });
    },
    /** Forgets one kind of secret, or everything kept for the app. */
    forget(appId, field) {
      const all = read();
      if (!Object.hasOwn(all, appId)) return;
      if (!field) delete all[appId];
      else {
        delete all[appId][field];
        if (field === 'privateKey') delete all[appId].publicKey;
      }
      write(all);
    },
  };
}

module.exports = {
  DEPLOY_AUTH, SECRETS_FILE, HOST_KEYS_MAX, PASSWORD_MAX, CONNECT_TIMEOUT_SECONDS, SETUP_TIMEOUT_MS, SECRET_ENV,
  hostPattern, hostKeyLine, fingerprint, cleanHost, hostText, sshProgram, optionPath, sshArgs, hostKeyArgs, readHostKeys, keygenArgs, publicKey,
  installKeyScript, installKeyCommand, askpass, passwordEnvironment, cleanPassword, sshProblem, createVault, createDeploySecrets,
};
