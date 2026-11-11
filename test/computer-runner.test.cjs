// Runs real commands through the shell this platform uses: PowerShell on Windows, the login shell
// elsewhere (macOS, and the Linux CI runner standing in for it). Each test skips on the other.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { basename, dirname, join } = require('node:path');
const { test } = require('node:test');
const { childEnvironment, commandPlan, computerShell } = require('../computer-policy.cjs');
const { startRun } = require('../computer-runner.cjs');

const windows = process.platform === 'win32';
const clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: timer => clearTimeout(timer) };

function folder(t) {
  const parent = realpathSync(tmpdir());
  const dir = mkdtempSync(join(parent, '1904-computer-runner-test-'));
  t.after(() => {
    const target = realpathSync(dir);
    assert.equal(dirname(target), parent);
    assert.match(basename(target), /^1904-computer-runner-test-/);
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  });
  return dir;
}

function shell() {
  if (windows) return computerShell({ platform: 'windows', env: process.env, exists: existsSync });
  const file = process.platform === 'darwin' ? computerShell({ platform: 'macos', env: process.env }).file : ['/bin/bash', '/bin/sh'].find(existsSync);
  return { kind: 'posix', file, name: basename(file) };
}

function run(command, cwd, { timeoutSeconds = 60 } = {}) {
  const plan = commandPlan({ shell: shell(), command });
  assert.equal(plan.error, undefined);
  return startRun({
    plan, cwd, env: childEnvironment(process.env), timeoutSeconds, platform: windows ? 'windows' : 'macos',
    spawn, kill: (pid, signal) => process.kill(pid, signal), clock,
  }).done;
}

test('PowerShell: exit codes from success, exit N, a failing native command and a failed cmdlet', { skip: !windows }, async t => {
  const cwd = folder(t);
  const ok = await run("Write-Output 'hello'", cwd);
  assert.deepEqual([ok.status, ok.exitCode, ok.stdout.trim()], ['done', 0, 'hello']);
  assert.equal((await run('exit 3', cwd)).exitCode, 3);
  assert.equal((await run('cmd /c exit 5', cwd)).exitCode, 5, 'a failing native command’s code');
  assert.equal((await run('cmd /c exit 4; Write-Output after', cwd)).exitCode, 0, 'the last statement decides, as in a shell');
  const cmdlet = await run('Get-Item C:\\definitely-missing-1904-folder', cwd);
  assert.equal(cmdlet.exitCode, 1, 'a failed cmdlet ends with 1');
  assert.match(cmdlet.stderr, /Cannot find path/);
  assert.doesNotMatch(cmdlet.stderr, /CLIXML|<Objs|_x000D_/, 'stderr is plain text');
  const parse = await run("Write-Output 'unterminated", cwd);
  assert.equal(parse.exitCode, 1, 'a command that does not parse ends with 1');
  assert.match(parse.stderr, /terminator/);
});

test('PowerShell: Unicode output, curly quotes, the working folder and closed stdin', { skip: !windows }, async t => {
  const cwd = folder(t);
  // Curly single quotes would end a single-quoted PowerShell string, so they sit in a double-quoted one;
  // the wrapper still has to pass them through its own single-quoted literal intact.
  const text = await run("Write-Output \"caf\u00e9 \u2713 \u2018quoted\u2019\"; (Get-Location).Path; [Console]::In.Peek()", cwd);
  assert.equal(text.exitCode, 0);
  const lines = text.stdout.trim().split(/\r?\n/);
  assert.equal(lines[0], 'caf\u00e9 \u2713 \u2018quoted\u2019');
  assert.equal(lines[1].toLowerCase(), cwd.toLowerCase());
  assert.equal(lines[2], '-1', 'stdin is closed');
});

test('PowerShell: a time limit stops the command and what it started', { skip: !windows }, async t => {
  const cwd = folder(t);
  const started = Date.now();
  const result = await run('cmd /c "echo started & ping -n 30 127.0.0.1 > nul"; Start-Sleep -Seconds 30', cwd, { timeoutSeconds: 3 });
  assert.equal(result.status, 'timeout');
  assert.equal(result.exitCode, null);
  assert.match(result.stdout, /started/, 'the child command was running when the time ran out');
  assert.ok(Date.now() - started < 15_000, 'it does not wait for the command');
});

test('login shell: exit codes, stderr and the working folder', { skip: windows }, async t => {
  const cwd = folder(t);
  const ok = await run('echo hello; pwd', cwd);
  assert.deepEqual([ok.status, ok.exitCode], ['done', 0]);
  assert.deepEqual(ok.stdout.trim().split('\n'), ['hello', cwd]);
  assert.equal((await run('exit 3', cwd)).exitCode, 3);
  const failed = await run('echo oops >&2; false', cwd);
  assert.deepEqual([failed.exitCode, failed.stderr], [1, 'oops\n']);
  assert.equal((await run('cat; echo "read $?"', cwd)).stdout.trim(), 'read 0', 'stdin is closed, so cat ends at once');
});

// Dead, or a zombie nobody has reaped yet (a container's first process may not reap orphans).
function alive(pid) {
  try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  try { return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return true; }
}

test('login shell: a background job does not outlive the command', { skip: windows }, async t => {
  const cwd = folder(t);
  const result = await run('sleep 30 & echo $! > job.pid; echo started', cwd);
  assert.deepEqual([result.status, result.exitCode, result.stdout], ['done', 0, 'started\n']);
  const pid = Number(readFileSync(join(cwd, 'job.pid'), 'utf8'));
  assert.ok(pid > 0);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(alive(pid), false, 'the background sleep ended with the command');
});

test('login shell: a time limit stops the whole process group', { skip: windows }, async t => {
  const cwd = folder(t);
  const started = Date.now();
  const result = await run('sleep 30 & sleep 30', cwd, { timeoutSeconds: 1 });
  assert.equal(result.status, 'timeout');
  assert.equal(result.exitCode, null);
  assert.ok(Date.now() - started < 10_000, 'the background sleep did not hold the result');
});
