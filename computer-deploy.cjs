// Deploy From This Computer: the commands a person saved here to deploy one of their apps, run when
// 1904 says a change of theirs merged (or when they press Run now). 1904 only ever says "deploy this
// app at this commit": the commands, how to connect, whether they may run without asking and where
// the log goes live in this file's store on this computer, and nothing 1904 sends can change them.
// No Electron in here, so every decision can be tested with plain Node.

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { COMPUTER_STDOUT_MAX, computerId, label, visibleLine, visibleText } = require('./computer-policy.cjs');
const { promptFits } = require('./computer-approval.cjs');
const { cleanHost, fingerprint, hostText } = require('./computer-deploy-ssh.cjs');

const DEPLOYS_PATH = '/api/desktop/computer/deploys';
const RECIPES_FILE = 'computer-deploys.json';
/** Sized so the connect line, the commands and the log path fit one approval prompt; cleanRecipe checks the text as the prompt shows it. */
const DEPLOY_CONNECT_MAX = 300;
const DEPLOY_COMMANDS_MAX = 2200;
const DEPLOY_COMMAND_LINES = 40;
const DEPLOY_LOG_PATH_MAX = 200;
/** output: what the commands print. file: a log the commands write on the host. write: 1904 Desktop writes that log. */
const DEPLOY_LOG_MODES = Object.freeze(['output', 'file', 'write']);
/** The end of the host's log that comes back, in bytes: it has to fit inside the output that is kept. */
const DEPLOY_LOG_TAIL_BYTES = 24 * 1024;
/** A deploy may run this long before it is stopped. */
const DEPLOY_TIMEOUT_SECONDS = 1800;
/** However long 1904 says a deploy may wait, this computer keeps it in line no longer than this. */
const DEPLOY_WAIT_MAX_MS = 2 * 60 * 60_000;
/** An unanswered deploy prompt closes after this long, so it never holds other prompts for hours. */
const DEPLOY_PROMPT_MS = 30 * 60_000;
/** Apps deploy in this order on one computer, lowest first. */
const DEPLOY_POSITION = Object.freeze({ min: 1, max: 99, default: 10 });
const DEPLOY_RECIPES_MAX = 50;
/** What a computer may report for a deploy. `expired` and `skipped` are 1904's to set. */
const DEPLOY_FINAL_STATUSES = Object.freeze(['done', 'failed', 'declined', 'timeout', 'cancelled']);

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const BRANCH_CHARS = /^[A-Za-z0-9._/-]{1,200}$/;
/**
 * A branch name git itself would accept, and that cannot be read as an option by a command that uses
 * $DEPLOY_BRANCH without quotes: no leading dash or slash, no `..`, no empty or dot-led part, no `.lock` or trailing slash or dot.
 */
const validBranch = value => typeof value === 'string' && BRANCH_CHARS.test(value) && !/^[-/.]|\.\.|\/\/|\/\.|\.lock(\/|$)|[/.]$/.test(value);
const BRANCH = { test: validBranch };
const REF = /^[A-Za-z0-9_.:-]{1,128}$/;
const NONCE = /^[a-f0-9]{16}$/;
// A log path is written into a shell script, so it holds nothing a shell reads as syntax.
const LOG_PATH = /^(?:~\/|\/)[A-Za-z0-9._/@%+=:,-]+$/;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const appKey = key => typeof key === 'string' && REF.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key);

const NO_RECIPE = 'This computer has no deploy commands saved for this app. Choose Deploy From This Computer in 1904 Desktop’s 1904 menu.';
const UNCONFIRMED_RUN = 'The commands did not report back from the host, so this deploy is not counted as done. Check that sh and base64 are available there.';

/**
 * Checks what the person typed. Returns `{ ok: true, recipe }` with a clean copy of the parts that
 * decide what runs, or `{ ok: false, error }` with a sentence for them.
 */
function cleanRecipe(value) {
  const fail = error => ({ ok: false, error });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Fill in the deploy commands.');
  // A host the person filled in (computer-deploy-ssh.cjs) takes the place of a typed connect line.
  let host;
  if (value.host && typeof value.host === 'object') {
    const checked = cleanHost(value.host);
    if (!checked.ok) return checked;
    host = checked.host;
  }
  const connect = host ? '' : typeof value.connect === 'string' ? value.connect.trim() : '';
  if (/[\r\n]/.test(connect) || CONTROL.test(connect)) return fail('Write how to connect on one line.');
  if (connect.length > DEPLOY_CONNECT_MAX) return fail(`Write how to connect in up to ${DEPLOY_CONNECT_MAX} characters.`);
  if (connect.endsWith('\\')) return fail('The connect line cannot end with a backslash.');
  const commands = typeof value.commands === 'string' ? value.commands.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '') : '';
  if (!commands.trim()) return fail('Add at least one command.');
  if (CONTROL.test(commands)) return fail('The commands contain a character that cannot be shown. Type them again.');
  if (commands.length > DEPLOY_COMMANDS_MAX) return fail(`Keep the commands under ${DEPLOY_COMMANDS_MAX} characters. Put longer steps in a script on the host and run that.`);
  if (commands.split('\n').length > DEPLOY_COMMAND_LINES) return fail(`Keep the commands to ${DEPLOY_COMMAND_LINES} lines. Put longer steps in a script on the host and run that.`);
  const mode = DEPLOY_LOG_MODES.includes(value.log?.mode) ? value.log.mode : 'output';
  let logPath = '';
  if (mode !== 'output') {
    logPath = typeof value.log?.path === 'string' ? value.log.path.trim() : '';
    if (!logPath) return fail('Name the log file on the host.');
    if (logPath.length > DEPLOY_LOG_PATH_MAX || !LOG_PATH.test(logPath) || logPath.includes('..')) {
      return fail('Name the log file as a full path, such as /var/log/myapp/deploy.log or ~/deploy.log, without spaces or quotes.');
    }
  }
  const position = Number.isSafeInteger(value.position) ? Math.min(DEPLOY_POSITION.max, Math.max(DEPLOY_POSITION.min, value.position)) : DEPLOY_POSITION.default;
  const recipe = {
    ...(host ? { host } : {}), connect, commands, log: { mode, path: logPath },
    auto: value.auto !== false, noApproval: value.noApproval === true, position, stopOnFailure: value.stopOnFailure === true,
  };
  // Measured the way the prompt shows it: an invisible character is spelled out there and takes more room.
  if (!promptFits(recipeText(recipe))) return fail('These commands are too long to review in one prompt, or hold characters that cannot be shown. Shorten them or type them again.');
  return { ok: true, recipe };
}

/** Changes when anything that decides what runs changes: the connect line, the commands or the log. */
function recipeHash(recipe) {
  const host = recipe.host ? [recipe.host.name, recipe.host.user, recipe.host.port ?? null, recipe.host.auth, recipe.host.keys] : null;
  return createHash('sha256').update(JSON.stringify([recipe.connect, recipe.commands, recipe.log?.mode ?? 'output', recipe.log?.path ?? '', ...(host ? [host] : [])])).digest('hex');
}

/** Whether the commands run on a host rather than on this computer. */
const isRemote = recipe => Boolean(recipe.host || recipe.connect);

/** All of what a deploy runs, as the prompt and Computer Activity show it. */
function recipeText(recipe) {
  const log = recipe.log?.mode === 'write' ? `\n\n# 1904 Desktop writes the output to this log on the host\n${recipe.log.path}`
    : recipe.log?.mode === 'file' ? `\n\n# then reads the end of this log on the host\n${recipe.log.path}` : '';
  return isRemote(recipe)
    ? `# connect\n${recipe.host ? hostText(recipe.host) : recipe.connect}\n\n# then run on the host, stopping at the first command that fails\n${recipe.commands}${log}`
    : `${recipe.commands}${log}`;
}

// ── The script that runs the commands ──────────────────────────────────────

const logExpression = logPath => logPath.startsWith('~/') ? `"$HOME/${logPath.slice(2)}"` : `"${logPath}"`;

/**
 * The sh script for one deploy. The person's commands run in a subshell under `set -e`, with no
 * input, exactly as written: nothing is piped through anything, so a broken pipe can never end
 * them or hide how they ended. Their own exit status is kept before anything else happens, and the
 * last line reports it with this run's nonce: a script that was cut short, or never reached the
 * host, reports nothing and is not counted as done.
 * A log file (`write`) is tried first and skipped when it cannot be written: the commands then run
 * without it. Reading the log back happens after the commands and cannot change their result.
 */
function deployScript({ recipe, sha = '', branch = '', nonce }) {
  if (!NONCE.test(nonce)) throw new Error('A deploy needs a nonce.');
  const mode = recipe.log?.mode ?? 'output';
  const lines = [
    `DEPLOY_SHA='${SHA.test(sha) ? sha : ''}'`,
    `DEPLOY_BRANCH='${BRANCH.test(branch) ? branch : ''}'`,
    'export DEPLOY_SHA DEPLOY_BRANCH',
    '__1904_run() {',
    '(',
    'set -e',
    recipe.commands,
    ')',
    '}',
  ];
  const tail = [`echo "__1904_log_${nonce}_begin"`];
  if (mode === 'output') {
    lines.push('__1904_run </dev/null', '__1904_status=$?');
  } else {
    lines.push(`__1904_log=${logExpression(recipe.log.path)}`);
    if (mode === 'file') {
      lines.push('__1904_run </dev/null', '__1904_status=$?', ...tail,
        // Only a regular file is read: a device or a pipe named as the log would never end.
        `if [ -f "$__1904_log" ]; then tail -c ${DEPLOY_LOG_TAIL_BYTES} "$__1904_log" 2>/dev/null; fi`);
    } else {
      lines.push(
        // The log is used only when it is an ordinary file (or does not exist yet) and a line can really be written
        // to it now: a full disk or a device is found out here, before the commands, and they then run without it.
        'if { [ ! -e "$__1904_log" ] || [ -f "$__1904_log" ]; } && ( echo "== 1904 deploy $DEPLOY_SHA ==" >>"$__1904_log" ) 2>/dev/null; then',
        '__1904_from=$(wc -c <"$__1904_log" 2>/dev/null | tr -d " ")',
        '__1904_run >>"$__1904_log" 2>&1 </dev/null',
        '__1904_status=$?',
        ...tail,
        `if [ -f "$__1904_log" ]; then tail -c "+$(( \${__1904_from:-0} + 1 ))" "$__1904_log" 2>/dev/null | tail -c ${DEPLOY_LOG_TAIL_BYTES}; fi`,
        'else',
        'echo "1904 Desktop could not write to $__1904_log, so the commands ran without a log file." >&2',
        '__1904_run </dev/null',
        '__1904_status=$?',
        ...tail,
        'fi',
      );
    }
    lines.push('echo', `echo "__1904_log_${nonce}_end"`);
  }
  lines.push(`echo "__1904_deploy_${nonce}:$__1904_status"`, 'exit "$__1904_status"');
  return lines.join('\n') + '\n';
}

/**
 * Put before the commands when PowerShell runs them on this computer, so a failure stops the ones after it: a
 * failed cmdlet in every PowerShell, a program that exits non-zero in PowerShell 7.4 and later. Windows PowerShell 5
 * has no such setting for programs: there the result is the last command's, and the window says so.
 */
const POWERSHELL_STOP = "$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true";

/**
 * How one deploy starts on this computer: `{ command, shell?, marker }`.
 * - With a connect line, the person's own shell runs `<connect> '<one word>'`. The script travels as
 *   base64 inside that one quoted word (letters, digits, + / = only), so neither this computer's
 *   shell nor the host's can read any of it as syntax, whatever the commands contain.
 * - Without one on macOS, /bin/sh runs the same script here.
 * - Without one on Windows, PowerShell runs the commands as written after POWERSHELL_STOP, and their exit code is the result.
 */
function deployPlan({ recipe, platform, sha, branch, nonce, dryRun = false }) {
  if (!isRemote(recipe) && platform === 'windows') {
    return dryRun ? { error: 'A dry run needs a host, or a Mac: on Windows these commands run in PowerShell on this computer, which has no way to check them without running them.' }
      : { command: `${POWERSHELL_STOP}\n${recipe.commands}`, marker: false };
  }
  const script = dryRun ? preflightScript({ recipe, nonce }) : deployScript({ recipe, sha, branch, nonce });
  if (!isRemote(recipe)) return { command: script, shell: { kind: 'posix', file: '/bin/sh', name: 'sh' }, marker: true };
  // A host the person filled in: 1904 Desktop starts ssh itself and hands it this one word (computer-deploy-ssh.cjs sshArgs).
  if (recipe.host) return { word: scriptWord(script), marker: true };
  return { command: `${recipe.connect} '${scriptWord(script)}'`, marker: true };
}

/** A script as the one word the host's shell is given: decoded there and run by sh. Only letters, digits, + / = and the fixed words around them. */
function scriptWord(script) {
  return `echo ${Buffer.from(script, 'utf8').toString('base64')} | base64 -d | sh`;
}

const SHELL_WORDS = new Set(['cd', 'echo', 'export', 'set', 'unset', 'if', 'then', 'else', 'elif', 'fi', 'for', 'do', 'done', 'while', 'until', 'case', 'esac', 'exit', 'return',
  'test', 'true', 'false', 'source', 'read', 'wait', 'exec', 'eval', 'printf', 'pwd', 'umask', 'trap', 'shift', 'local', 'function', 'time', 'command', 'type', 'alias', 'sudo', 'env', 'nohup']);

/** The programs the commands start, as far as a first look can tell: the first word of each line (the one after sudo too). */
function commandTools(commands) {
  const tools = new Set();
  for (const line of String(commands).split('\n')) {
    const words = line.trim().split(/\s+/).filter(word => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    for (const word of words[0] === 'sudo' ? words.slice(0, 2) : words.slice(0, 1)) {
      if (/^[A-Za-z0-9_.+-]{1,64}$/.test(word) && !SHELL_WORDS.has(word)) tools.add(word);
    }
  }
  return [...tools].slice(0, 20);
}

/**
 * A dry run: what can be checked where the commands would run, without running any of them. That the
 * connection works and as whom; that the host has what the script itself needs and the programs the
 * commands start; that the commands parse (`sh -n` reads them and runs nothing); that sudo, when the
 * commands use it, works without a password, since nobody is there to type one; that the log file
 * can be written; and how much disk is free. It changes nothing on the host, and ends like a deploy
 * does, reporting 0 only when nothing that would stop a deploy was found.
 */
function preflightScript({ recipe, nonce }) {
  if (!NONCE.test(nonce)) throw new Error('A dry run needs a nonce.');
  const mode = recipe.log?.mode ?? 'output';
  const lines = [
    '__1904_bad=0',
    'echo "Connected as $(id -un 2>/dev/null || echo unknown) on $(hostname 2>/dev/null || echo this host)."',
    ...['sh', 'base64', ...commandTools(recipe.commands)].map(tool =>
      `if command -v ${tool} >/dev/null 2>&1; then echo "found: ${tool}"; else echo "MISSING: ${tool} is not installed for this user"; __1904_bad=1; fi`),
    `if echo ${Buffer.from(recipe.commands + '\n', 'utf8').toString('base64')} | base64 -d | sh -n; then echo "The commands parse."; else echo "The commands do not parse: see the error above."; __1904_bad=1; fi`,
  ];
  if (/(^|[\s;&|(])sudo\s/.test(recipe.commands)) {
    lines.push(
      'if sudo -n -l >/dev/null 2>&1; then echo "sudo works without a password here. Allowed:"; sudo -n -l 2>/dev/null | sed -n "/may run/,\$p" | sed -n "2,12p"',
      'else echo "sudo asks for a password here, and a deploy cannot type one. Allow these commands for this user without a password (NOPASSWD in sudoers), or avoid sudo."; __1904_bad=1; fi',
    );
  }
  if (mode !== 'output') {
    lines.push(`__1904_log=${logExpression(recipe.log.path)}`);
    lines.push(mode === 'write'
      ? 'if [ -f "$__1904_log" ] && [ -w "$__1904_log" ]; then echo "The log file can be written."; elif [ ! -e "$__1904_log" ] && [ -w "$(dirname "$__1904_log")" ]; then echo "The log file will be created."; else echo "The log file cannot be written, so the commands would run without it: $__1904_log"; fi'
      : 'if [ -f "$__1904_log" ]; then echo "The log file exists."; else echo "The log file is not there yet: $__1904_log"; fi');
  }
  lines.push(
    'df -Pk . 2>/dev/null | tail -1 | { read -r _ _ _ free _ where; [ -n "$free" ] && echo "Free disk in $where: $((free / 1024)) MB"; }',
    'if [ "$__1904_bad" = 0 ]; then echo "Nothing found that would stop a deploy. No command was run."; else echo "Fix what is marked above before deploying. No command was run."; fi',
    `echo "__1904_deploy_${nonce}:$__1904_bad"`, 'exit "$__1904_bad"',
  );
  return lines.join('\n') + '\n';
}

/**
 * What a deploy's commands get on top of the usual minimal environment: the commit and branch, and
 * on macOS the person's ssh-agent socket, without which a key that lives in the agent cannot be used.
 */
function deployEnvironment({ platform, env = {}, sha = '', branch = '' }) {
  const out = { DEPLOY_SHA: SHA.test(sha) ? sha : '', DEPLOY_BRANCH: BRANCH.test(branch) ? branch : '' };
  const socket = env.SSH_AUTH_SOCK;
  if (platform !== 'windows' && typeof socket === 'string' && path.posix.isAbsolute(socket) && !CONTROL.test(socket) && socket.length <= 1024) out.SSH_AUTH_SOCK = socket;
  return out;
}

/**
 * Reads what the script printed. `confirmed`: its last line arrived, with the commands' own exit
 * `status`. `log`: the end of the host's log, when one was asked for. `output`: everything else.
 */
function readDeployOutput(stdout, nonce) {
  const text = String(stdout ?? '');
  // The last report line counts, wherever it is: something the commands left running in the background may
  // print after it. Only this run's script knows the nonce, so no earlier output can stand in for it.
  let done;
  for (const match of text.matchAll(new RegExp(`(^|\\n)__1904_deploy_${nonce}:(\\d{1,3})(\\r?\\n|$)`, 'g'))) done = match;
  let output = done ? text.slice(0, done.index + done[1].length) + text.slice(done.index + done[0].length) : text;
  let log;
  const begin = `__1904_log_${nonce}_begin`;
  const end = `__1904_log_${nonce}_end`;
  const from = output.indexOf(begin);
  if (from !== -1) {
    const to = output.indexOf(end, from);
    // The script prints one line break after the log so its end marker starts a line: that one is not the log's.
    log = output.slice(from + begin.length, to === -1 ? undefined : to).replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    output = output.slice(0, from) + (to === -1 ? '' : output.slice(to + end.length).replace(/^\r?\n/, ''));
  }
  return { confirmed: Boolean(done), ...(done ? { status: Number(done[2]) } : {}), ...(log !== undefined ? { log } : {}), output };
}

/** How a finished run counts: `done` only when the commands ended with 0 and, where the script reports, it said so. */
function deployOutcome({ outcome, marker, nonce }) {
  const read = marker ? readDeployOutput(outcome.stdout, nonce) : { confirmed: true, output: String(outcome.stdout ?? '') };
  if (outcome.status !== 'done') return { ...read, status: outcome.status, exitCode: outcome.exitCode ?? null, message: outcome.message };
  if (outcome.exitCode === 0 && !read.confirmed) return { ...read, status: 'failed', exitCode: null, message: UNCONFIRMED_RUN };
  // The commands' own exit status where the script reported it; otherwise whatever ended the connection.
  const code = read.confirmed && Number.isSafeInteger(read.status) ? read.status : outcome.exitCode;
  if (code === 0 && outcome.exitCode === 0) return { ...read, status: 'done', exitCode: 0 };
  // The commands reported 0 but the connection itself ended badly: the connection's code is the one that failed.
  const failedCode = code === 0 ? outcome.exitCode : code;
  return {
    ...read, status: 'failed', exitCode: Number.isSafeInteger(failedCode) ? failedCode : null,
    message: outcome.message || (read.confirmed && code !== 0 ? `The commands ended with exit code ${code}.`
      : `Could not run the commands${marker ? ' on the host' : ''} (exit code ${outcome.exitCode ?? 'unknown'}).`),
  };
}

// ── What 1904 sends ────────────────────────────────────────────────────────

function reference(value, nameKey) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const id = typeof value.id === 'string' && REF.test(value.id) ? value.id : undefined;
  const name = label(value[nameKey]);
  return id && name !== undefined ? { id, name } : undefined;
}

/**
 * Checks one deploy from a poll. 1904 names the app and the commit, never a command: a field that
 * tried to carry one is simply not read. Returns `{ ok: true, deploy }` or `{ ok: false, id?, reason }`.
 */
function validateDeploy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'The deploy could not be read.' };
  const id = computerId(value.id);
  const fail = reason => ({ ok: false, ...(id ? { id } : {}), reason });
  if (!id) return fail('The deploy has no id.');
  if (value.kind !== 'deploy') return fail('This version of 1904 Desktop cannot do that yet. Update 1904 Desktop.');
  const app = reference(value.app, 'name');
  if (!app) return fail('The deploy does not say which app it is for.');
  const sender = reference(value.sender, 'name') ?? { id: 'unknown', name: '' };
  const expiresAt = Number(value.expiresAt), createdAt = Number(value.createdAt);
  if (!Number.isFinite(expiresAt)) return fail('The deploy has no expiry time.');
  return {
    ok: true,
    deploy: {
      id, kind: 'deploy',
      app: { id: app.id, name: app.name || 'Untitled app', repo: label(value.app.repo) || '' },
      sha: typeof value.sha === 'string' && SHA.test(value.sha) ? value.sha : '',
      branch: typeof value.branch === 'string' && BRANCH.test(value.branch) ? value.branch : '',
      taskId: typeof value.taskId === 'string' && /^[a-f0-9]{32}$/.test(value.taskId) ? value.taskId : '',
      sender: { id: sender.id, name: sender.name || 'You' },
      createdAt: Number.isFinite(createdAt) ? createdAt : expiresAt - 60 * 60_000, expiresAt,
    },
  };
}

/** A deploy in the shape the prompt, Computer Activity and this computer's log already show commands in. */
function deployRequest(deploy, recipe) {
  const commit = deploy.sha ? deploy.sha.slice(0, 10) : '';
  const dryRun = deploy.local === true && deploy.dryRun === true;
  return {
    id: deploy.id, kind: 'deploy', command: recipeText(recipe), access: 'full', network: true, origin: { kind: deploy.local ? 'manual' : 'deploy' }, dryRun,
    reason: dryRun ? 'A dry run you started from 1904 Desktop: it checks these commands without running them.'
      : deploy.local ? 'You started this deploy from 1904 Desktop.' : `Your change${commit ? ` ${commit}` : ''} merged${deploy.branch ? ` into ${deploy.branch}` : ''}.`,
    timeoutSeconds: DEPLOY_TIMEOUT_SECONDS,
    app: deploy.app, task: { id: deploy.taskId || `deploy-${deploy.id}`, title: `${dryRun ? 'Dry run for' : 'Deploy'} ${deploy.app.name}${commit ? ` at ${commit}` : ''}` },
    sender: deploy.sender, sha: deploy.sha, branch: deploy.branch, local: deploy.local === true,
    createdAt: deploy.createdAt, expiresAt: deploy.expiresAt,
  };
}

/** A final report for 1904. The output and the log are the ends this computer kept, never more than it is sent for a command. */
function deployUpdate({ deployId, status, exitCode = null, output = '', stderr = '', log, durationMs = 0, message }) {
  if (!DEPLOY_FINAL_STATUSES.includes(status)) throw new Error(`Unknown deploy status: ${status}`);
  const cut = text => { const value = String(text ?? ''); return value.length > COMPUTER_STDOUT_MAX ? value.slice(-COMPUTER_STDOUT_MAX) : value; };
  return {
    action: 'result', deployId, status, exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    output: cut(output), stderr: cut(stderr), ...(log !== undefined ? { log: cut(log) } : {}),
    durationMs: Number.isFinite(durationMs) ? Math.max(0, Math.round(durationMs)) : 0,
    ...(message ? { message: String(message).slice(0, 500) } : {}),
  };
}

/** What 1904 keeps about a recipe: enough to know when to ask and in what order, never the commands. */
function recipeRegistration(recipe) {
  return {
    action: 'save', appId: recipe.appId, auto: recipe.auto, noApproval: recipe.noApproval, position: recipe.position,
    stopOnFailure: recipe.stopOnFailure, remote: isRemote(recipe), logMode: recipe.log.mode, commandsHash: recipe.hash,
  };
}

// ── What the person is asked ───────────────────────────────────────────────

/** Before commands may run without asking: all of them, spelled out. Cancel is the default and the Escape answer. */
function noApprovalPrompt(recipe, computerName) {
  return {
    type: 'warning', title: 'Deploy From This Computer',
    // The app's name comes from 1904: anything in it that hides or reorders text is spelled out, as in a prompt.
    message: `Let ${visibleLine(label(recipe.appName, 80) || 'this app')}’s deploy commands run without asking?`,
    detail: `When a change of yours to this app merges, 1904 Desktop runs these commands on ${visibleLine(label(computerName, 60) || 'this computer')} without a prompt. ` +
      'They run as you, with access to your files and keys. 1904 can only start them: it cannot change them, and editing them here asks you again.\n\n' +
      visibleText(recipeText(recipe)),
    buttons: ['Cancel', 'Run Without Asking'], defaultId: 0, cancelId: 0, noLink: true,
  };
}

// ── The saved recipes ──────────────────────────────────────────────────────

function storedRecipe(appId, value) {
  if (!appKey(appId) || !value || typeof value !== 'object') return undefined;
  const checked = cleanRecipe(value);
  if (!checked.ok || !computerId(value.computerId)) return undefined;
  const recipe = { appId, appName: label(value.appName) || 'App', repo: label(value.repo) || '', computerId: value.computerId, ...checked.recipe };
  const lastRun = value.lastRun && typeof value.lastRun === 'object' && Number.isFinite(value.lastRun.at) ? {
    at: value.lastRun.at, status: label(String(value.lastRun.status ?? ''), 20) || '', sha: SHA.test(value.lastRun.sha) ? value.lastRun.sha : '',
    exitCode: Number.isSafeInteger(value.lastRun.exitCode) ? value.lastRun.exitCode : null,
  } : undefined;
  return { ...recipe, hash: recipeHash(recipe), updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0, ...(lastRun ? { lastRun } : {}) };
}

/**
 * The recipes on this computer, in a file only this app reads. Each belongs to the pairing it was
 * saved under (`computerId`): after Disconnect, or once another account connects this computer, an
 * old recipe keeps its text but cannot run and never runs without asking until it is saved again.
 */
function createDeployRecipes({ file, now = Date.now }) {
  let recipes;
  function load() {
    if (recipes) return;
    recipes = new Map();
    if (!file) return;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [appId, entry] of Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})) {
        const recipe = storedRecipe(appId, entry);
        if (recipe) recipes.set(appId, recipe);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('1904 Desktop could not read its deploy commands.');
    }
  }
  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(Object.fromEntries(recipes)), { mode: 0o600 });
    fs.renameSync(file + '.tmp', file);
  }
  return {
    all() { load(); return [...recipes.values()].map(recipe => ({ ...recipe, log: { ...recipe.log } })); },
    /** The recipe that may run for this app under the current pairing, or undefined. */
    get(appId, pairedId) {
      load();
      const recipe = appKey(appId) ? recipes.get(appId) : undefined;
      return recipe && pairedId && recipe.computerId === pairedId ? { ...recipe, log: { ...recipe.log } } : undefined;
    },
    /** Saves what the person typed for one app. Returns `{ ok, recipe }` or `{ ok: false, error }`. */
    save({ appId, appName, repo, computerId: pairedId }, input) {
      load();
      if (!appKey(appId) || !computerId(pairedId)) return { ok: false, error: 'Connect this computer to 1904 first.' };
      const checked = cleanRecipe(input);
      if (!checked.ok) return checked;
      if (!recipes.has(appId) && recipes.size >= DEPLOY_RECIPES_MAX) return { ok: false, error: `This computer can keep deploy commands for ${DEPLOY_RECIPES_MAX} apps. Remove one first.` };
      const previous = recipes.get(appId);
      const recipe = { appId, appName: label(appName) || previous?.appName || 'App', repo: label(repo) || previous?.repo || '', computerId: pairedId, ...checked.recipe };
      const stored = { ...recipe, hash: recipeHash(recipe), updatedAt: now(), ...(previous?.lastRun ? { lastRun: previous.lastRun } : {}) };
      recipes.set(appId, stored);
      save();
      return { ok: true, recipe: { ...stored, log: { ...stored.log } } };
    },
    remove(appId) {
      load();
      if (!recipes.delete(appId)) return false;
      save();
      return true;
    },
    /** How the last run of an app's recipe ended. */
    noteRun(appId, run) {
      load();
      const recipe = recipes.get(appId);
      if (!recipe) return;
      recipe.lastRun = { at: now(), status: String(run.status ?? ''), sha: SHA.test(run.sha) ? run.sha : '', exitCode: Number.isSafeInteger(run.exitCode) ? run.exitCode : null };
      try { save(); } catch { /* a record, never a reason to fail a deploy */ }
    },
    /** Disconnect: nothing runs without asking again until the person saves it under a new pairing. */
    disarm() {
      load();
      let changed = false;
      for (const recipe of recipes.values()) if (recipe.noApproval) { recipe.noApproval = false; changed = true; }
      if (changed) try { save(); } catch { /* still off in memory */ }
    },
  };
}

/** A recipe as the deploy window shows it. Text is spelled out the way a prompt would show it. */
function recipeView(recipe, pairedId) {
  return {
    appId: recipe.appId, appName: visibleLine(recipe.appName), connect: recipe.connect, commands: recipe.commands, log: { ...recipe.log },
    ...(recipe.host ? { host: { ...recipe.host, keys: [...recipe.host.keys] }, fingerprints: Object.fromEntries(recipe.host.keys.map(line => [line, fingerprint(line)])) } : {}),
    auto: recipe.auto, noApproval: recipe.noApproval && recipe.computerId === pairedId, position: recipe.position, stopOnFailure: recipe.stopOnFailure,
    stale: recipe.computerId !== pairedId, updatedAt: recipe.updatedAt, ...(recipe.lastRun ? { lastRun: { ...recipe.lastRun } } : {}),
  };
}

module.exports = {
  DEPLOYS_PATH, RECIPES_FILE, DEPLOY_CONNECT_MAX, DEPLOY_COMMANDS_MAX, DEPLOY_COMMAND_LINES, DEPLOY_LOG_PATH_MAX, DEPLOY_LOG_MODES,
  DEPLOY_LOG_TAIL_BYTES, DEPLOY_TIMEOUT_SECONDS, DEPLOY_WAIT_MAX_MS, DEPLOY_PROMPT_MS, POWERSHELL_STOP, validBranch, DEPLOY_POSITION, DEPLOY_RECIPES_MAX, DEPLOY_FINAL_STATUSES, NO_RECIPE, UNCONFIRMED_RUN,
  cleanRecipe, recipeHash, recipeText, isRemote, deployScript, preflightScript, commandTools, scriptWord, deployPlan, deployEnvironment, readDeployOutput, deployOutcome,
  validateDeploy, deployRequest, deployUpdate, recipeRegistration, noApprovalPrompt, createDeployRecipes, recipeView,
};
