// Use My Computer: runs one approved command. Starts the shell with stdin closed, streams what it
// writes, stops everything it started on a timeout or Stop, and reports how it ended.
// No Electron in here; tests pass their own spawn, kill and clock.

const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { COMPUTER_STDOUT_MAX, COMPUTER_STDERR_MAX, DEFAULT_PATH, cleanSearchPath, createClixmlDecoder, createTail } = require('./computer-policy.cjs');

const LOGIN_PATH_SHELLS = ['zsh', 'bash', 'sh', 'dash', 'ksh', 'fish'];
const PATH_MARK = '__1904_PATH__=';

/**
 * The PATH the person's login shell sets up (Homebrew, nvm and so on), asked once. The shell gets
 * only HOME, USER, LOGNAME, SHELL, a basic PATH and TERM, and only the PATH it prints is kept: no
 * other variable its startup files set reaches a command. Undefined when it cannot be read in time.
 */
function resolveLoginPath({ shellFile, home, user, spawn, kill = (pid, signal) => process.kill(pid, signal), clock, timeoutMs = 5000 }) {
  return new Promise(resolve => {
    if (!LOGIN_PATH_SHELLS.includes(path.posix.basename(shellFile || ''))) { resolve(undefined); return; }
    let out = '';
    let done = false;
    let child;
    let timer;
    const finish = value => {
      if (done) return;
      done = true;
      clock.clearTimeout(timer);
      resolve(value);
    };
    try {
      child = spawn(shellFile, ['-l', '-c', `printf "\\n${PATH_MARK}%s\\n" "$PATH"`], {
        cwd: home, env: { HOME: home, USER: user, LOGNAME: user, SHELL: shellFile, PATH: DEFAULT_PATH, TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true,
      });
    } catch {
      resolve(undefined);
      return;
    }
    timer = clock.setTimeout(() => {
      try { kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      finish(undefined);
    }, timeoutMs);
    child.stdout?.on('data', chunk => { out = (out + chunk).slice(-65536); });
    child.on('error', () => finish(undefined));
    child.on('close', () => {
      const found = [...out.matchAll(new RegExp(`^${PATH_MARK}(.*)$`, 'gm'))].pop();
      finish(found ? cleanSearchPath(found[1], 'macos') || undefined : undefined);
    });
  });
}

/** Output can arrive a moment after the shell exits; a background process that keeps it open is not waited for. */
const EXIT_GRACE_MS = 2000;
/** macOS: the process group gets SIGTERM, then SIGKILL after this long. */
const KILL_GRACE_MS = 2000;

const STOPPED = {
  timeout: seconds => `Stopped after ${seconds} seconds, the time limit for this command.`,
  stopped: () => 'The person stopped the command on this computer.',
  cancelled: () => 'The task cancelled this command.',
  disconnected: () => 'This computer was disconnected from 1904.',
  quit: () => '1904 Desktop quit while the command was running.',
};

function startFailure(file, error) {
  if (error?.code === 'ENOENT') return `Not found: ${file}`;
  if (error?.code === 'EACCES') return `Not allowed to run ${file}`;
  return `Could not start ${file}: ${error?.code || error?.message || 'unknown error'}`;
}

/**
 * Ends a command and everything it started. Windows: taskkill /T /F on the shell's process tree.
 * macOS: the shell leads its own process group (spawned detached), so the group is signalled.
 */
function killTree(child, { platform, spawn, kill = process.kill, clock, env = process.env }) {
  if (!child?.pid) return;
  if (platform === 'windows') {
    const root = env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows';
    const fallback = () => { try { child.kill(); } catch { /* already gone */ } };
    try {
      const killer = spawn(path.win32.join(root, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.on('error', fallback);
    } catch {
      fallback();
    }
    return;
  }
  const signal = name => {
    try { kill(-child.pid, name); } catch { try { child.kill(name); } catch { /* already gone */ } }
  };
  signal('SIGTERM');
  clock.setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS);
}

/**
 * Starts `plan` (from commandPlan) in `cwd`. Returns `{ pid, stop(reason), done }`; `done` resolves with
 * `{ status, exitCode, stdout, stderr, trimmed, durationMs, message? }` and never rejects.
 * `reason` is one of timeout, stopped (the person), cancelled (the task), disconnected or quit.
 */
function startRun({
  plan, cwd, env, timeoutSeconds, platform, spawn, kill = (pid, signal) => process.kill(pid, signal), clock,
  onOutput = () => {}, stopTree = killTree,
}) {
  const started = clock.now();
  const tails = { stdout: createTail(COMPUTER_STDOUT_MAX), stderr: createTail(COMPUTER_STDERR_MAX) };
  const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
  const clixml = plan.clixml ? createClixmlDecoder() : null;
  let child;
  let exited;
  let stopReason;
  let finished = false;
  let exitTimer;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });

  const emit = (stream, text) => {
    if (!text) return;
    tails[stream].push(text);
    try { onOutput(stream, text); } catch { /* a closed window must not stop the run */ }
  };
  const read = (stream, chunk, final) => {
    let text = final ? decoders[stream].end() : decoders[stream].write(chunk);
    if (stream === 'stderr' && clixml) text = clixml.push(text) + (final ? clixml.end() : '');
    emit(stream, text);
  };

  function finish(fields) {
    if (finished) return;
    finished = true;
    clock.clearTimeout(timeoutTimer);
    clock.clearTimeout(exitTimer);
    read('stdout', null, true);
    read('stderr', null, true);
    resolveDone({
      exitCode: null, ...fields,
      stdout: tails.stdout.text(), stderr: tails.stderr.text(),
      trimmed: { stdout: tails.stdout.trimmed, stderr: tails.stderr.trimmed },
      durationMs: Math.max(0, clock.now() - started),
    });
  }

  // macOS and Linux: the shell leads its own process group, so whatever it left running in the
  // background (`job &`) is in that group and ends with it. Windows has no equivalent without a
  // native job object: taskkill /T cannot follow a parent that already exited.
  const reapGroup = signal => {
    if (!plan.detached || !child?.pid) return;
    try { kill(-child.pid, signal); } catch { /* the group is already gone */ }
  };

  function settle() {
    if (finished) return;
    reapGroup('SIGKILL');
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    if (stopReason) {
      finish({ status: stopReason === 'timeout' ? 'timeout' : 'cancelled', message: (STOPPED[stopReason] || STOPPED.stopped)(timeoutSeconds) });
      return;
    }
    const code = exited?.code;
    if (Number.isSafeInteger(code)) finish({ status: 'done', exitCode: code });
    else finish({ status: 'done', ...(exited?.signal ? { message: `The command ended with ${exited.signal}.` } : {}) });
  }

  function stop(reason) {
    if (finished) return;
    if (exited) {
      // The command already ended and only something it left running holds the output open:
      // stop that, and report the command's own result.
      stopTree(child, { platform, spawn, kill, clock, env });
      settle();
      return;
    }
    if (stopReason) return;
    stopReason = reason;
    stopTree(child, { platform, spawn, kill, clock, env });
  }

  const timeoutTimer = clock.setTimeout(() => stop('timeout'), timeoutSeconds * 1000);
  try {
    child = spawn(plan.file, plan.args, {
      cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: Boolean(plan.detached),
    });
  } catch (error) {
    finish({ status: 'failed', message: startFailure(plan.file, error) });
    return { pid: undefined, stop() {}, done };
  }
  child.stdout?.on('data', chunk => read('stdout', chunk, false));
  child.stderr?.on('data', chunk => read('stderr', chunk, false));
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});
  child.on('error', error => {
    // Without a pid the shell never started (it is missing, or not allowed to run). A later error
    // means a signal could not be delivered; the exit or the grace timer still ends the run.
    if (!child.pid) finish({ status: 'failed', message: startFailure(plan.file, error) });
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    // The command is over: what it started in the background gets SIGTERM now and SIGKILL when the run settles.
    reapGroup('SIGTERM');
    exitTimer = clock.setTimeout(settle, EXIT_GRACE_MS);
  });
  child.on('close', settle);
  return { pid: child.pid, stop, done };
}

module.exports = { EXIT_GRACE_MS, KILL_GRACE_MS, killTree, resolveLoginPath, startRun };
