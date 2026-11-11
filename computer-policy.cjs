// Use My Computer: what 1904 Desktop accepts from 1904, where a command starts, how the shell is
// started, how much output goes back, and what "Allow for this message" covers.
// No Electron in here, so every decision can be tested with plain Node.

const path = require('node:path');
const { appFolderProblem } = require('./computer-sandbox.cjs');

// ── Mirrored from 1904's wire contract. Change both together; test/computer-policy.test.cjs pins them. ──

const COMPUTER_PLATFORMS = Object.freeze(['macos', 'windows']);
/** How long the agent's call waits before it hears "still running". */
const COMPUTER_WAIT_MS = 100_000;
/** How long a command may run on this computer before it is stopped. */
const COMPUTER_TIMEOUT_SECONDS = Object.freeze({ min: 5, max: 1800, default: 120 });
/** A request nobody approves or declines in this long expires. */
const COMPUTER_PENDING_MS = 10 * 60_000;
/** A computer counts as online when it polled this recently. */
const COMPUTER_ONLINE_MS = 45_000;
/** 1904 holds one poll open this long when nothing is waiting. */
const COMPUTER_POLL_HOLD_MS = 25_000;
const COMPUTER_COMMAND_MAX = 8000;
const COMPUTER_REASON_MAX = 500;
const COMPUTER_CWD_MAX = 1000;
const COMPUTER_NAME_MAX = 60;
/** The tail of each stream that goes back, in bytes of UTF-8. */
const COMPUTER_STDOUT_MAX = 48 * 1024;
const COMPUTER_STDERR_MAX = 16 * 1024;
const COMPUTER_AUDIT_COMMAND_MAX = 2000;
const COMPUTER_GRANT_MAX = 1024;
/** The sentence that goes back with a result is cut to this length. */
const COMPUTER_MESSAGE_MAX = 500;
/** The shell's display name is cut to this length. */
const COMPUTER_SHELL_MAX = 40;
/** 'sandbox' (the default) runs in this computer's sandbox; 'full' runs with everything the person has. */
const COMPUTER_ACCESS = Object.freeze(['sandbox', 'full']);
/** A pairing lapses after this long without a poll; the person then connects the computer again. */
const COMPUTER_PAIRING_IDLE_MS = 30 * 24 * 60 * 60_000;
/** The header 1904 Desktop adds to each message its own window sends (see computer-proof.cjs). */
const COMPUTER_PROOF_HEADER = 'x-1904-computer-proof';
const COMPUTER_PROOF_SKEW_MS = 2 * 60_000;
/** A request from a message sent here is answered only within this long of sending it. */
const COMPUTER_OWN_MESSAGE_MS = 6 * 60 * 60_000;
/** Away mode: the lengths a person can choose, and the command budget. */
const COMPUTER_AWAY_MINUTES = Object.freeze([30, 60, 120, 240, 480]);
const COMPUTER_AWAY_MAX_COMMANDS = Object.freeze({ min: 1, max: 200, default: 50 });
const COMPUTER_STATUSES = Object.freeze(['pending', 'delivered', 'running', 'done', 'declined', 'failed', 'timeout', 'cancelled', 'expired']);
const COMPUTER_FINAL_STATUSES = Object.freeze(['done', 'declined', 'failed', 'timeout', 'cancelled', 'expired']);
/** What this computer may report. `expired` is 1904's to set, never a computer's. */
const DESKTOP_FINAL_STATUSES = Object.freeze(['done', 'declined', 'failed', 'timeout', 'cancelled']);

/** Ids 1904 mints and this app only passes back. */
const ID = /^[A-Za-z0-9_-]{8,64}$/;
/** Ids of things the request names (app, task, person), which this app only displays and compares. */
const REF = /^[A-Za-z0-9_.:-]{1,128}$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LABEL_MAX = 200;
/** What the agent hears when a request names a message this computer did not send. */
const NOT_FROM_DESKTOP = '1904 Desktop did not send this message, so it will not run commands for it.';

const computerId = value => typeof value === 'string' && ID.test(value) ? value : undefined;
const pathFor = platform => platform === 'windows' ? path.win32 : path.posix;

/** Node's platform name as 1904 knows it, or undefined where Use My Computer is not offered. */
function computerPlatform(nodePlatform) {
  if (nodePlatform === 'darwin') return 'macos';
  if (nodePlatform === 'win32') return 'windows';
  return undefined;
}

/** One line of display text: control characters become spaces, runs of space collapse, length is capped. */
function label(value, max = LABEL_MAX) {
  if (typeof value !== 'string') return undefined;
  return value.replace(/\p{Cc}+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function clampTimeout(value) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(n)) return COMPUTER_TIMEOUT_SECONDS.default;
  return Math.min(COMPUTER_TIMEOUT_SECONDS.max, Math.max(COMPUTER_TIMEOUT_SECONDS.min, Math.round(n)));
}

function reference(value, nameKey, max = LABEL_MAX) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = typeof value.id === 'string' && REF.test(value.id) ? value.id : undefined;
  const name = label(value[nameKey], max);
  return id && name !== undefined ? { id, name } : undefined;
}

/**
 * Checks one request from a poll. Returns `{ ok: true, request }` with a clean copy, or
 * `{ ok: false, id?, reason }`: with an id, the reason goes back to 1904 as a failed result.
 */
function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'The request could not be read.' };
  const id = computerId(value.id);
  const fail = reason => ({ ok: false, ...(id ? { id } : {}), reason });
  if (!id) return fail('The request has no id.');
  if (value.kind !== 'run') return fail('This version of 1904 Desktop cannot do that yet. Ask the person to update 1904 Desktop.');
  const messageId = computerId(value.messageId);
  if (!messageId) return fail('The request does not name the message it belongs to.');
  const command = typeof value.command === 'string' ? value.command : '';
  if (!command.trim()) return fail('The request has no command.');
  if (command.length > COMPUTER_COMMAND_MAX) return fail(`The command is longer than ${COMPUTER_COMMAND_MAX} characters.`);
  if (command.includes('\u0000')) return fail('The command contains a NUL character.');
  let cwd;
  if (value.cwd !== undefined && value.cwd !== null && value.cwd !== '') {
    if (typeof value.cwd !== 'string' || value.cwd.length > COMPUTER_CWD_MAX || CONTROL.test(value.cwd) || value.cwd.includes('\n')) {
      return fail('The folder in the request is not a folder path.');
    }
    cwd = value.cwd;
  }
  if (typeof value.reason !== 'string') return fail('The request does not say why it needs this computer.');
  // An older 1904 sends no access level: the sandbox is the safe reading.
  const access = value.access === undefined || value.access === null ? 'sandbox' : value.access;
  if (!COMPUTER_ACCESS.includes(access)) return fail('The request asks for an access level 1904 Desktop does not know.');
  if (value.network !== undefined && value.network !== null && typeof value.network !== 'boolean') return fail('The request’s network setting could not be read.');
  let origin;
  if (value.origin?.kind === 'desktop') origin = { kind: 'desktop' };
  else if (value.origin?.kind === 'away' && computerId(value.origin.leaseId)) origin = { kind: 'away', leaseId: value.origin.leaseId };
  else return fail(NOT_FROM_DESKTOP);
  const reason = label(value.reason, COMPUTER_REASON_MAX);
  const appRef = reference(value.app, 'name');
  const repo = label(value.app?.repo);
  const taskRef = reference(value.task, 'title', 500);
  const sender = reference(value.sender, 'name');
  if (!appRef || repo === undefined || !taskRef || !sender) return fail('The request does not say which app, task and person it is for.');
  const createdAt = Number(value.createdAt), expiresAt = Number(value.expiresAt);
  if (!Number.isFinite(expiresAt)) return fail('The request has no expiry time.');
  return {
    ok: true,
    request: {
      id, kind: 'run', messageId, command, ...(cwd ? { cwd } : {}),
      timeoutSeconds: clampTimeout(value.timeoutSeconds), reason, access, network: value.network === true, origin,
      app: { id: appRef.id, name: appRef.name || 'Untitled app', repo },
      task: { id: taskRef.id, title: taskRef.name || 'Untitled task' },
      sender: { id: sender.id, name: sender.name || 'Someone' },
      createdAt: Number.isFinite(createdAt) ? createdAt : expiresAt - COMPUTER_PENDING_MS,
      expiresAt,
    },
  };
}

// ── Where a command starts ─────────────────────────────────────────────────

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A single folder name that is safe on macOS and Windows, from the first candidate that has one. */
function folderName(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    let name = candidate.normalize('NFKD').replace(/\p{M}+/gu, '').replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[.\s-]+/, '').slice(0, 64).replace(/[.\s-]+$/, '');
    if (!name) continue;
    if (WINDOWS_RESERVED.test(name)) name += '-app';
    return name;
  }
  return 'app';
}

/** `<home>/1904/<repo>`: where an app's commands start until the person chooses another folder. */
function defaultFolder({ platform, home, app }) {
  return pathFor(platform).join(home, '1904', folderName(app?.repo, app?.name, app?.id));
}

/** Whether `target` is `root` or inside it. Windows paths compare without regard to case. */
function within(platform, root, target) {
  const p = pathFor(platform);
  const relative = p.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + p.sep) && !p.isAbsolute(relative));
}

/**
 * Where a request starts. `root` is the app's folder (the person's choice, or the default);
 * `path` is the agent's `cwd` resolved against it; `outside` is true when that path is not in the
 * root, which happens only through an absolute path, `~`, or a `..` that climbs out.
 */
function placeFor({ platform, home, app, chosen, cwd }) {
  const p = pathFor(platform);
  const root = p.resolve(chosen || defaultFolder({ platform, home, app }));
  let target = root;
  if (typeof cwd === 'string' && cwd.trim()) {
    let raw = cwd.trim();
    if (raw === '~' || raw.startsWith('~/') || (platform === 'windows' && raw.startsWith('~\\'))) raw = p.join(home, raw.slice(1));
    const absolute = p.isAbsolute(raw) || (platform === 'windows' && /^[A-Za-z]:/.test(raw));
    target = absolute ? p.resolve(raw) : p.resolve(root, raw);
  }
  return { root, chosen: Boolean(chosen), path: target, outside: !within(platform, root, target) };
}

/**
 * Why a folder the person picked (or one read back from the saved choices) cannot be an app's
 * folder, or undefined when it can. Never a drive, the home folder or a folder holding it; on macOS
 * nothing the sandbox protects (see computer-sandbox.cjs appFolderProblem); on Windows nothing in
 * AppData or a hidden folder in the home folder.
 */
function folderChoiceProblem(folder, { platform, home, userData, realpath }) {
  const p = pathFor(platform);
  if (typeof folder !== 'string' || !p.isAbsolute(folder) || CONTROL.test(folder) || folder.includes('\n')) return 'Choose a folder on this computer.';
  const resolved = p.resolve(folder);
  if (resolved === p.parse(resolved).root) return 'Choose a folder for this app, not a whole drive.';
  if (home && within(platform, resolved, p.resolve(home))) return 'Choose a folder for this app, not your home folder or a folder that contains it.';
  if (home && platform === 'macos') return appFolderProblem({ appFolder: resolved, home: p.resolve(home), userData, realpath });
  if (home && platform === 'windows') {
    const relative = p.relative(p.resolve(home), resolved);
    const first = relative.split(p.sep)[0];
    if (!relative.startsWith('..') && !p.isAbsolute(relative) && (first.toLowerCase() === 'appdata' || first.startsWith('.'))) {
      return 'Choose a folder outside AppData and the hidden folders in your home folder.';
    }
  }
  return undefined;
}

// ── How a command is started ───────────────────────────────────────────────

function envValue(env, name) {
  const key = Object.keys(env || {}).find(candidate => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/** The first `file` in an absolute PATH entry that exists. Relative PATH entries are skipped. */
function findOnPath(file, { platform, env, exists }) {
  const p = pathFor(platform);
  for (const entry of String(envValue(env, 'PATH') || '').split(platform === 'windows' ? ';' : ':')) {
    const dir = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !p.isAbsolute(dir)) continue;
    const candidate = p.join(dir, file);
    try { if (exists(candidate)) return candidate; } catch { /* unreadable PATH entry */ }
  }
  return undefined;
}

/**
 * The shell commands run in. macOS: the person's login shell ($SHELL, else /bin/zsh).
 * Windows: PowerShell 7 when pwsh.exe is on PATH, else the Windows PowerShell that ships with Windows.
 */
function computerShell({ platform, env = {}, exists = () => false }) {
  if (platform === 'windows') {
    const pwsh = findOnPath('pwsh.exe', { platform, env, exists });
    if (pwsh) return { kind: 'powershell', file: pwsh, name: 'PowerShell 7' };
    const root = envValue(env, 'SystemRoot') || envValue(env, 'windir') || 'C:\\Windows';
    return { kind: 'powershell', file: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), name: 'Windows PowerShell' };
  }
  const shell = envValue(env, 'SHELL');
  const file = typeof shell === 'string' && path.posix.isAbsolute(shell) && !/\s/.test(shell) ? shell : '/bin/zsh';
  return { kind: 'posix', file, name: path.posix.basename(file).slice(0, COMPUTER_SHELL_MAX) };
}

/** A PowerShell single-quoted string. PowerShell also ends such strings at curly single quotes. */
function powershellLiteral(text) {
  return "'" + String(text).replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&') + "'";
}

/**
 * The script PowerShell runs. The command is parsed as its own script block so its mistakes
 * stay its own, and the line after it records whether its last statement succeeded. The exit
 * code is then 0, the last native command's code when that failed, or 1 for a failed cmdlet.
 * A parse error, `throw`, or an error under `$ErrorActionPreference = 'Stop'` ends with 1, and
 * the command's own `exit N` ends with N.
 */
function powershellScript(command) {
  return [
    "$ErrorActionPreference = 'Continue'",
    "$ProgressPreference = 'SilentlyContinue'",
    'try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding } catch { }',
    '$global:LASTEXITCODE = 0',
    '$global:__1904Succeeded = $true',
    `try { $__1904Command = [ScriptBlock]::Create(${powershellLiteral(command)} + [char]10 + [char]10 + '$global:__1904Succeeded = $?') }`,
    'catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }',
    '. $__1904Command',
    'if ($global:__1904Succeeded) { exit 0 }',
    'if ($global:LASTEXITCODE) { exit $global:LASTEXITCODE }',
    'exit 1',
  ].join('\n');
}

const encodePowerShell = script => Buffer.from(script, 'utf16le').toString('base64');
const decodePowerShell = encoded => Buffer.from(encoded, 'base64').toString('utf16le');

// CreateProcess takes at most 32,767 characters; leave room for quoting.
const WINDOWS_COMMAND_LINE_MAX = 32_000;

/**
 * How each shell starts without reading any startup file, so a profile cannot put tokens back into
 * a command's environment. A shell not listed here is replaced by /bin/zsh -f.
 */
const STARTUP_FREE = {
  zsh: ['-f'], bash: ['--noprofile', '--norc'], sh: [], dash: [], ksh: [], fish: ['--no-config'], csh: ['-f'], tcsh: ['-f'],
};
const FALLBACK_SHELL = '/bin/zsh';

/**
 * The program, arguments and spawn flags for one command, or `{ error }` when it cannot be started.
 * `sandbox` (from computer-sandbox.cjs, macOS) wraps the command in sandbox-exec with /bin/zsh -f.
 */
function commandPlan({ shell, command, sandbox }) {
  if (shell.kind === 'powershell') {
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(powershellScript(command))];
    const length = [shell.file, ...args].reduce((sum, arg) => sum + arg.length + 3, 0);
    if (length > WINDOWS_COMMAND_LINE_MAX) {
      return { error: 'This command is too long for PowerShell to start. Write it to a script file in the app folder with shorter commands, then run the file.' };
    }
    // Windows PowerShell writes errors to stderr as CLIXML when started with -EncodedCommand.
    return { file: shell.file, args, detached: false, clixml: true, shellFile: shell.file };
  }
  // Its own process group, so a timeout, Stop or the shell's own exit ends everything the command started.
  if (sandbox) {
    return { file: sandbox.file, args: [...sandbox.args, FALLBACK_SHELL, ...STARTUP_FREE.zsh, '-c', command], detached: true, clixml: false, shellFile: FALLBACK_SHELL };
  }
  const known = Object.hasOwn(STARTUP_FREE, path.posix.basename(shell.file));
  const file = known ? shell.file : FALLBACK_SHELL;
  return { file, args: [...STARTUP_FREE[path.posix.basename(file)], '-c', command], detached: true, clixml: false, shellFile: file };
}

const DEFAULT_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
// The variables Windows itself and its tools need. Nothing an app or a person set for themselves.
const WINDOWS_KEEP = /^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|USERPROFILE|USERNAME|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramFiles\(x86\)|CommonProgramW6432|HOMEDRIVE|HOMEPATH|PROCESSOR_[A-Z0-9_]+|NUMBER_OF_PROCESSORS|OS)$/i;

/** A search path with only absolute folders, so a relative entry such as `.` can never pick the program. */
function cleanSearchPath(value, platform) {
  const separator = platform === 'windows' ? ';' : ':';
  const p = pathFor(platform);
  const seen = new Set();
  for (const entry of String(value ?? '').split(separator)) {
    const dir = entry.trim();
    if (dir && p.isAbsolute(dir) && !CONTROL.test(dir) && !dir.includes('\n')) seen.add(dir);
  }
  return [...seen].join(separator).slice(0, 8192);
}

/**
 * A command's whole environment. Nothing else from 1904 Desktop's own environment reaches it, so
 * tokens and keys exported there stay there. macOS and Linux: PATH (the login shell's, resolved
 * once), HOME, USER, LOGNAME, SHELL, LANG and LC_*, TERM, and TMPDIR set to the run's own temp
 * folder. Windows: the system variables above, Path, and TEMP/TMP set to the run's temp folder.
 */
function commandEnvironment({ platform, env = {}, searchPath, tempDir, shellFile }) {
  if (platform === 'windows') {
    const out = {};
    for (const [key, value] of Object.entries(env)) if (WINDOWS_KEEP.test(key) && typeof value === 'string') out[key] = value;
    out.Path = cleanSearchPath(searchPath ?? envValue(env, 'PATH'), platform);
    out.TEMP = tempDir;
    out.TMP = tempDir;
    return out;
  }
  const out = { PATH: cleanSearchPath(searchPath, platform) || DEFAULT_PATH };
  for (const key of ['HOME', 'USER', 'LOGNAME', 'LANG']) if (typeof env[key] === 'string') out[key] = env[key];
  for (const [key, value] of Object.entries(env)) if (/^LC_[A-Z]+$/.test(key) && typeof value === 'string') out[key] = value;
  out.SHELL = shellFile;
  out.TERM = typeof env.TERM === 'string' && /^[\w.+-]{1,64}$/.test(env.TERM) ? env.TERM : 'dumb';
  out.TMPDIR = tempDir;
  return out;
}

// ── Output ─────────────────────────────────────────────────────────────────

/** Keeps the last `max` bytes of a stream (as UTF-8) and whether anything before them was dropped. */
function createTail(max) {
  let chunks = [];
  let size = 0;
  let total = 0;
  return {
    push(text) {
      if (!text) return;
      const bytes = Buffer.from(text, 'utf8');
      chunks.push(bytes);
      size += bytes.length;
      total += bytes.length;
      if (size > max * 2) {
        const joined = Buffer.concat(chunks);
        chunks = [Buffer.from(joined.subarray(joined.length - max))];
        size = max;
      }
    },
    get trimmed() { return total > max; },
    get bytes() { return total; },
    text() {
      let joined = Buffer.concat(chunks);
      if (joined.length > max) joined = joined.subarray(joined.length - max);
      let start = 0;
      // Never start in the middle of a character.
      if (total > max) while (start < joined.length && (joined[start] & 0xc0) === 0x80) start++;
      return joined.subarray(start).toString('utf8');
    },
  };
}

const CLIXML_MARK = '#< CLIXML';
const XML_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeClixmlString(text) {
  return text
    .replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#[0-9]+);/gi, (_, entity) => {
      if (entity[0] !== '#') return XML_ENTITIES[entity.toLowerCase()];
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** End of the `<Obj>` element that starts `text`, counting nested ones; -1 while it is incomplete. */
function objectEnd(text) {
  const tag = /<(\/?)Obj(?=[\s>/])[^>]*?(\/?)>/g;
  let depth = 0;
  for (let match; (match = tag.exec(text));) {
    if (match[1]) depth--;
    else if (!match[2]) depth++;
    if (depth <= 0) return tag.lastIndex;
  }
  return -1;
}

const partialPrefix = (text, whole) => text.length < whole.length && whole.startsWith(text);
function incompleteTag(text) {
  if (['<Objs', '</Objs>', '<S S="', '<Obj'].some(tag => partialPrefix(text, tag))) return true;
  if (/^<Objs\b[^>]*$/.test(text)) return true;
  if (text.startsWith('<S S="')) return !text.includes('</S>') && !/^<S S="[^"]*"\s*\/>/.test(text);
  return /^<Obj[\s>/]/.test(text) && objectEnd(text) === -1;
}

/**
 * Turns the CLIXML that Windows PowerShell writes to stderr back into the text it would have shown.
 * Native programs write to the same stderr directly, so plain text can sit between the records.
 * Feed it text in any chunks; `end()` returns whatever was held back.
 */
function createClixmlDecoder() {
  let buffer = '';
  let inXml = false;
  const LIMIT = 1 << 20;
  function drain(final) {
    let out = '';
    while (buffer) {
      if (!inXml) {
        const at = buffer.indexOf(CLIXML_MARK);
        if (at === -1) {
          let keep = 0;
          if (!final) for (let k = Math.min(CLIXML_MARK.length - 1, buffer.length); k > 0; k--) {
            if (CLIXML_MARK.startsWith(buffer.slice(-k))) { keep = k; break; }
          }
          out += buffer.slice(0, buffer.length - keep);
          buffer = buffer.slice(buffer.length - keep);
          break;
        }
        out += buffer.slice(0, at);
        const rest = buffer.slice(at + CLIXML_MARK.length);
        if (!final && (rest === '' || rest === '\r')) { buffer = buffer.slice(at); break; }
        buffer = rest.replace(/^\r?\n/, '');
        inXml = true;
        continue;
      }
      const lt = buffer.indexOf('<');
      if (lt === -1) { out += buffer; buffer = ''; break; }
      if (lt > 0) { out += buffer.slice(0, lt); buffer = buffer.slice(lt); continue; }
      let match;
      if ((match = /^<Objs\b[^>]*>/.exec(buffer))) { buffer = buffer.slice(match[0].length); continue; }
      if (buffer.startsWith('</Objs>')) { buffer = buffer.slice(7).replace(/^\r?\n/, ''); inXml = false; continue; }
      if ((match = /^<S S="[^"]*"\s*\/>/.exec(buffer))) { buffer = buffer.slice(match[0].length); continue; }
      if ((match = /^<S S="[^"]*">([\s\S]*?)<\/S>/.exec(buffer))) {
        out += decodeClixmlString(match[1]);
        buffer = buffer.slice(match[0].length);
        continue;
      }
      if (/^<Obj[\s>/]/.test(buffer)) {
        const end = objectEnd(buffer);
        if (end > 0) { buffer = buffer.slice(end); continue; }
      }
      if (!final && buffer.length < LIMIT && incompleteTag(buffer)) break;
      out += '<';
      buffer = buffer.slice(1);
    }
    return out;
  }
  return {
    push(text) { buffer += text || ''; return drain(false); },
    end() { return drain(true); },
  };
}

// ── What the person sees ───────────────────────────────────────────────────

// Characters that hide, reorder or restyle text, or break a line without looking like it: a
// command must read the same in the prompt as it runs. Includes line and paragraph separators,
// tag characters, variation selectors and the fillers that render as nothing.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u2028-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
const codePoint = ch => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/** Text as the person should read it: anything invisible or reordering is spelled out as <U+XXXX>. */
function visibleText(text) {
  return String(text ?? '').replace(/\r\n/g, '\n').replace(INVISIBLE, ch => `<${codePoint(ch)}>`);
}

/** One line of visibleText: a line break is spelled out too, so the text cannot start a line of its own. */
function visibleLine(text) {
  return visibleText(text).replace(/\n/g, '<U+000A>');
}

/** A short line for a notification: spelled out like the prompt, and marked with … where it was cut. */
function shortLine(text, max) {
  const line = visibleLine(text);
  return line.length > max ? line.slice(0, Math.max(0, max - 1)) + '…' : line;
}

/**
 * Every character outside printable ASCII, once each, as `\u201C\u0430\u201D U+0430` (or just `U+202E` for one
 * that shows nothing), so a look-alike letter cannot pass for the one it imitates.
 */
function unusualCharacters(text, max = 20) {
  const found = [...new Set([...String(text ?? '')].filter(ch => /[^\t\n\r\x20-\x7e]/.test(ch)))];
  const named = found.slice(0, max).map(ch => (visibleText(ch) === ch && ch.trim() ? `\u201C${ch}\u201D ${codePoint(ch)}` : codePoint(ch)));
  if (found.length > max) named.push(`and ${found.length - max} more`);
  return named;
}

/** The name a computer gets when it connects: the host name without its domain. */
function defaultComputerName(hostname) {
  const name = String(hostname || '').replace(/\p{Cc}/gu, '').trim().split('.')[0].trim().slice(0, COMPUTER_NAME_MAX);
  return name || 'My computer';
}

// ── "Allow for this message" ───────────────────────────────────────────────

/** "Allow for this message" never lasts longer than this, however long the message's turn runs. */
const ALLOWANCE_MS = 30 * 60_000;

/**
 * Remembers, in memory only, which messages the person allowed. An allowance covers a later
 * request only when it belongs to the same message, task and app, and starts in the same folder.
 * It ends after 30 minutes, or as soon as a request for the same task arrives from another
 * message: nothing outlives the message's turn.
 */
function createAllowance({ now = Date.now, max = 100, ttlMs = ALLOWANCE_MS } = {}) {
  const entries = new Map();
  function prune() {
    for (const [key, entry] of entries) if (now() - entry.at > ttlMs) entries.delete(key);
    while (entries.size > max) entries.delete(entries.keys().next().value);
  }
  return {
    /** Every arriving request passes through here: a new message on a task ends that task's allowance. */
    seen(request) {
      for (const [messageId, entry] of entries) {
        if (entry.taskId === request?.task?.id && messageId !== request.messageId) entries.delete(messageId);
      }
    },
    /** `network`: whether the person also allowed internet access. Full access is never allowed this way. */
    allow(request, place, network = false) {
      if (!request || !place || place.outside || request.access === 'full') return false;
      entries.delete(request.messageId);
      entries.set(request.messageId, { taskId: request.task.id, appId: request.app.id, root: place.root, network: network === true, at: now() });
      prune();
      return true;
    },
    /** Covered, and with internet only when it was allowed too. */
    covers(request, place) {
      prune();
      const entry = request && place && !place.outside && request.access !== 'full' && entries.get(request.messageId);
      return Boolean(entry && entry.taskId === request.task.id && entry.appId === request.app.id && entry.root === place.root &&
        (!request.network || entry.network));
    },
    clear() { entries.clear(); },
    get size() { return entries.size; },
  };
}

// ── What goes back to 1904 ─────────────────────────────────────────────────

function runningUpdate(requestId, cwd) {
  return { requestId, status: 'running', ...(cwd ? { cwd } : {}) };
}

function finalUpdate({ requestId, status, exitCode = null, stdout = '', stderr = '', trimmed, durationMs = 0, cwd, message }) {
  if (!DESKTOP_FINAL_STATUSES.includes(status)) throw new Error(`Unknown result status: ${status}`);
  return {
    requestId, status,
    exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    stdout: String(stdout), stderr: String(stderr),
    trimmed: { stdout: trimmed?.stdout === true, stderr: trimmed?.stderr === true },
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    ...(cwd ? { cwd } : {}),
    ...(message ? { message: String(message).slice(0, COMPUTER_MESSAGE_MAX) } : {}),
  };
}

module.exports = {
  COMPUTER_PLATFORMS, COMPUTER_WAIT_MS, COMPUTER_TIMEOUT_SECONDS, COMPUTER_PENDING_MS, COMPUTER_ONLINE_MS,
  COMPUTER_POLL_HOLD_MS, COMPUTER_COMMAND_MAX, COMPUTER_REASON_MAX, COMPUTER_CWD_MAX, COMPUTER_NAME_MAX,
  COMPUTER_STDOUT_MAX, COMPUTER_STDERR_MAX, COMPUTER_AUDIT_COMMAND_MAX, COMPUTER_GRANT_MAX, COMPUTER_MESSAGE_MAX,
  COMPUTER_SHELL_MAX, COMPUTER_STATUSES, COMPUTER_FINAL_STATUSES, DESKTOP_FINAL_STATUSES,
  COMPUTER_ACCESS, COMPUTER_PAIRING_IDLE_MS, COMPUTER_PROOF_HEADER, COMPUTER_PROOF_SKEW_MS, COMPUTER_OWN_MESSAGE_MS,
  COMPUTER_AWAY_MINUTES, COMPUTER_AWAY_MAX_COMMANDS, NOT_FROM_DESKTOP,
  computerId, computerPlatform, label, clampTimeout, validateRequest, within,
  folderName, defaultFolder, placeFor, folderChoiceProblem,
  findOnPath, computerShell, powershellLiteral, powershellScript, encodePowerShell, decodePowerShell, commandPlan,
  STARTUP_FREE, FALLBACK_SHELL, DEFAULT_PATH, cleanSearchPath, commandEnvironment,
  createTail, createClixmlDecoder, visibleText, visibleLine, shortLine, unusualCharacters, defaultComputerName,
  ALLOWANCE_MS, createAllowance, runningUpdate, finalUpdate,
};
