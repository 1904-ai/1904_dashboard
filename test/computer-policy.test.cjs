const assert = require('node:assert/strict');
const { test } = require('node:test');
const policy = require('../computer-policy.cjs');

const {
  validateRequest, placeFor, folderName, defaultFolder, folderChoiceProblem, computerShell, commandPlan,
  powershellScript, powershellLiteral, decodePowerShell, createTail, createClixmlDecoder, createAllowance,
  finalUpdate, runningUpdate, visibleText, defaultComputerName, childEnvironment, computerPlatform,
} = policy;

const request = (overrides = {}) => ({
  id: 'req_000000001', kind: 'run', messageId: 'msg_000000001',
  command: 'uname -a', timeoutSeconds: 30, reason: 'Check the macOS version.',
  app: { id: 'app_1', name: 'Shop', repo: 'shop' },
  task: { id: 'task_1', title: 'Fix the login page' },
  sender: { id: 'user_1', name: 'Dana' },
  createdAt: 1_000, expiresAt: 601_000,
  ...overrides,
});

test('the mirrored limits match 1904’s contract', () => {
  assert.deepEqual([...policy.COMPUTER_PLATFORMS], ['macos', 'windows']);
  assert.equal(policy.COMPUTER_WAIT_MS, 100_000);
  assert.deepEqual({ ...policy.COMPUTER_TIMEOUT_SECONDS }, { min: 5, max: 1800, default: 120 });
  assert.equal(policy.COMPUTER_PENDING_MS, 600_000);
  assert.equal(policy.COMPUTER_ONLINE_MS, 45_000);
  assert.equal(policy.COMPUTER_POLL_HOLD_MS, 25_000);
  assert.equal(policy.COMPUTER_COMMAND_MAX, 8000);
  assert.equal(policy.COMPUTER_REASON_MAX, 500);
  assert.equal(policy.COMPUTER_CWD_MAX, 1000);
  assert.equal(policy.COMPUTER_NAME_MAX, 60);
  assert.equal(policy.COMPUTER_STDOUT_MAX, 49_152);
  assert.equal(policy.COMPUTER_STDERR_MAX, 16_384);
  assert.equal(policy.COMPUTER_AUDIT_COMMAND_MAX, 2000);
  assert.equal(policy.COMPUTER_GRANT_MAX, 1024);
  assert.equal(policy.COMPUTER_MESSAGE_MAX, 500);
  assert.equal(policy.COMPUTER_SHELL_MAX, 40);
  assert.deepEqual([...policy.COMPUTER_STATUSES], ['pending', 'delivered', 'running', 'done', 'declined', 'failed', 'timeout', 'cancelled', 'expired']);
  assert.deepEqual([...policy.COMPUTER_FINAL_STATUSES], ['done', 'declined', 'failed', 'timeout', 'cancelled', 'expired']);
  assert.deepEqual([...policy.DESKTOP_FINAL_STATUSES], ['done', 'declined', 'failed', 'timeout', 'cancelled'], 'only 1904 sets expired');
  assert.equal(policy.computerId('abcdefgh'), 'abcdefgh');
  for (const id of ['short', 'has space1', 'a'.repeat(65), 7]) assert.equal(policy.computerId(id), undefined, String(id));
});

test('a well-formed request is accepted as a clean copy', () => {
  const checked = validateRequest(request({ cwd: 'src', timeoutSeconds: 99_999, sender: { id: 'user_1', name: 'Dana\u0007 Lee' } }));
  assert.equal(checked.ok, true);
  assert.equal(checked.request.cwd, 'src');
  assert.equal(checked.request.timeoutSeconds, 1800, 'the time limit is clamped');
  assert.equal(checked.request.sender.name, 'Dana Lee', 'control characters never reach a prompt');
  assert.equal(validateRequest(request({ timeoutSeconds: 1 })).request.timeoutSeconds, 5);
  assert.equal(validateRequest(request({ timeoutSeconds: undefined })).request.timeoutSeconds, 120);
  assert.equal(validateRequest(request({ cwd: '' })).request.cwd, undefined);
});

test('a malformed request is refused, with its id when it has one', () => {
  assert.deepEqual(validateRequest(null), { ok: false, reason: 'The request could not be read.' });
  assert.equal(validateRequest(request({ id: 'bad id' })).id, undefined);
  for (const [overrides, pattern] of [
    [{ kind: 'screen' }, /cannot do that yet/],
    [{ messageId: undefined }, /message/],
    [{ command: '   ' }, /no command/],
    [{ command: 'x'.repeat(8001) }, /longer than 8000/],
    [{ command: 'echo \u0000' }, /NUL/],
    [{ cwd: 'a\nb' }, /folder/],
    [{ cwd: 'x'.repeat(1001) }, /folder/],
    [{ reason: undefined }, /why/],
    [{ app: { id: 'app_1', name: 'Shop' } }, /which app/],
    [{ sender: 'Dana' }, /which app, task and person/],
    [{ expiresAt: 'soon' }, /expiry/],
  ]) {
    const checked = validateRequest(request(overrides));
    assert.equal(checked.ok, false, JSON.stringify(overrides));
    assert.equal(checked.id, 'req_000000001');
    assert.match(checked.reason, pattern);
  }
});

test('commands start in ~/1904/<repo>, a safe folder name, unless the person chose a folder', () => {
  assert.equal(defaultFolder({ platform: 'macos', home: '/Users/dana', app: { repo: 'shop' } }), '/Users/dana/1904/shop');
  assert.equal(defaultFolder({ platform: 'windows', home: 'C:\\Users\\dana', app: { repo: 'shop' } }), 'C:\\Users\\dana\\1904\\shop');
  assert.equal(folderName('../../etc'), 'etc');
  assert.equal(folderName('..'), 'app');
  assert.equal(folderName('', '.hidden'), 'hidden');
  assert.equal(folderName('my app/../x'), 'my-app-..-x');
  assert.equal(folderName('Café Menü'), 'Cafe-Menu');
  assert.equal(folderName('con'), 'con-app', 'a reserved Windows name gets a suffix');
  assert.equal(folderName('trailing. '), 'trailing');
  assert.equal(folderName(undefined, 'Shop', 'app_1'), 'Shop');
  const chosen = placeFor({ platform: 'macos', home: '/Users/dana', app: { repo: 'shop' }, chosen: '/Users/dana/code/shop' });
  assert.deepEqual(chosen, { root: '/Users/dana/code/shop', chosen: true, path: '/Users/dana/code/shop', outside: false });
});

test('the agent’s cwd is resolved inside the folder and flagged when it leaves it', () => {
  const mac = cwd => placeFor({ platform: 'macos', home: '/Users/dana', app: { repo: 'shop' }, cwd });
  assert.deepEqual(mac(undefined), { root: '/Users/dana/1904/shop', chosen: false, path: '/Users/dana/1904/shop', outside: false });
  assert.deepEqual([mac('src/app').path, mac('src/app').outside], ['/Users/dana/1904/shop/src/app', false]);
  assert.deepEqual([mac('src/../lib').path, mac('src/../lib').outside], ['/Users/dana/1904/shop/lib', false]);
  assert.deepEqual([mac('..').path, mac('..').outside], ['/Users/dana/1904', true]);
  assert.deepEqual([mac('../shop-other').path, mac('../shop-other').outside], ['/Users/dana/1904/shop-other', true], 'a sibling with the same prefix is outside');
  assert.deepEqual([mac('/etc').path, mac('/etc').outside], ['/etc', true]);
  assert.deepEqual([mac('~').path, mac('~').outside], ['/Users/dana', true]);
  assert.deepEqual([mac('~/1904/shop/src').path, mac('~/1904/shop/src').outside], ['/Users/dana/1904/shop/src', false]);
  assert.equal(mac('/Users/dana/1904/shop/src').outside, false, 'an absolute path inside the folder stays inside');
  assert.equal(mac('..foo').outside, false, 'a folder whose name starts with two dots is not a climb');

  const win = cwd => placeFor({ platform: 'windows', home: 'C:\\Users\\dana', app: { repo: 'shop' }, cwd });
  assert.deepEqual([win('src\\app').path, win('src\\app').outside], ['C:\\Users\\dana\\1904\\shop\\src\\app', false]);
  assert.equal(win('src/app').path, 'C:\\Users\\dana\\1904\\shop\\src\\app');
  assert.equal(win('..\\..').outside, true);
  assert.equal(win('D:\\work').outside, true);
  assert.equal(win('D:work').outside, true, 'a drive-relative path counts as another drive');
  assert.equal(win('\\\\server\\share').outside, true);
  assert.equal(win('c:\\users\\DANA\\1904\\SHOP\\src').outside, false, 'Windows paths compare without regard to case');
});

test('a chosen folder may be anywhere except a drive root or a folder holding the home folder', () => {
  const mac = { platform: 'macos', home: '/Users/dana' };
  assert.equal(folderChoiceProblem('/Users/dana/code/shop', mac), undefined);
  assert.equal(folderChoiceProblem('/Volumes/Work/shop', mac), undefined);
  assert.match(folderChoiceProblem('/', mac), /whole drive/);
  assert.match(folderChoiceProblem('/Users/dana', mac), /home folder/);
  assert.match(folderChoiceProblem('/Users', mac), /home folder/);
  assert.match(folderChoiceProblem('relative/path', mac), /on this computer/);
  const win = { platform: 'windows', home: 'C:\\Users\\dana' };
  assert.equal(folderChoiceProblem('D:\\code\\shop', win), undefined);
  assert.match(folderChoiceProblem('D:\\', win), /whole drive/);
  assert.match(folderChoiceProblem('c:\\users\\Dana', win), /home folder/);
});

test('macOS runs the login shell with -l -c', () => {
  const zsh = computerShell({ platform: 'macos', env: { SHELL: '/bin/zsh' } });
  assert.deepEqual(zsh, { kind: 'posix', file: '/bin/zsh', name: 'zsh' });
  assert.equal(computerShell({ platform: 'macos', env: {} }).file, '/bin/zsh');
  assert.equal(computerShell({ platform: 'macos', env: { SHELL: 'zsh' } }).file, '/bin/zsh', 'a relative $SHELL is not trusted');
  assert.equal(computerShell({ platform: 'macos', env: { SHELL: '/opt/homebrew/bin/fish' } }).name, 'fish');
  assert.deepEqual(commandPlan({ shell: zsh, command: 'echo "$HOME" && uname' }),
    { file: '/bin/zsh', args: ['-l', '-c', 'echo "$HOME" && uname'], detached: true, clixml: false });
  assert.deepEqual(commandPlan({ shell: { kind: 'posix', file: '/bin/tcsh' }, command: 'pwd' }).args, ['-c', 'pwd']);
});

test('Windows prefers pwsh.exe on PATH, else the built-in powershell.exe', () => {
  const env = { Path: 'C:\\Windows\\system32;relative\\bin;"C:\\Program Files\\PowerShell\\7"', SystemRoot: 'C:\\Windows' };
  const pwsh = computerShell({ platform: 'windows', env, exists: file => file === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' });
  assert.deepEqual(pwsh, { kind: 'powershell', file: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'PowerShell 7' });
  const checked = [];
  const builtIn = computerShell({ platform: 'windows', env, exists: file => { checked.push(file); return false; } });
  assert.deepEqual(builtIn, { kind: 'powershell', file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', name: 'Windows PowerShell' });
  assert.ok(!checked.some(file => file.startsWith('relative')), 'relative PATH entries are never searched');
});

// Reads the command back out of the encoded script, the way PowerShell parses the literal.
function commandInScript(script) {
  const match = /\[ScriptBlock\]::Create\('((?:[^'\u2018\u2019\u201A\u201B]|(['\u2018\u2019\u201A\u201B])\2)*)'/.exec(script);
  assert.ok(match, 'the script embeds the command as one literal');
  return match[1].replace(/(['\u2018\u2019\u201A\u201B])\1/g, '$1');
}

test('the PowerShell command line round-trips any command through -EncodedCommand', () => {
  const shell = { kind: 'powershell', file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', name: 'Windows PowerShell' };
  for (const command of [
    'Get-ChildItem',
    "Write-Output 'it''s' \u2018curly\u2019 \u201Alow\u201B \"$env:USERPROFILE\" `$x",
    'git status\ncmd /c exit 3',
    'Write-Output "Größe 字 \u{1F600}"',
    "@'\nhere\n'@",
  ]) {
    const plan = commandPlan({ shell, command });
    assert.equal(plan.file, shell.file);
    assert.deepEqual(plan.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(plan.detached, false);
    assert.equal(plan.clixml, true);
    assert.match(plan.args[4], /^[A-Za-z0-9+/]+=*$/);
    const script = decodePowerShell(plan.args[4]);
    assert.equal(script, powershellScript(command));
    assert.equal(commandInScript(script), command);
  }
  assert.equal(powershellLiteral("a'b\u2019c"), "'a''b\u2019\u2019c'");
});

test('the PowerShell wrapper turns failures into the exit code', () => {
  const script = powershellScript('cmd /c exit 3');
  assert.match(script, /\$global:LASTEXITCODE = 0/);
  assert.match(script, /\. \$__1904Command\nif \(\$global:__1904Succeeded\) \{ exit 0 \}\nif \(\$global:LASTEXITCODE\) \{ exit \$global:LASTEXITCODE \}\nexit 1$/);
  assert.match(script, /catch \{ \[Console\]::Error\.WriteLine\(\$_\.Exception\.Message\); exit 1 \}/, 'a command that does not parse ends with 1');
  assert.match(script, /UTF8Encoding \$false/, 'output is UTF-8 without a byte order mark');
  assert.match(script, /\$ProgressPreference = 'SilentlyContinue'/);
});

test('a command too long for a Windows command line is refused before it starts', () => {
  const shell = { kind: 'powershell', file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' };
  assert.equal(commandPlan({ shell, command: 'x'.repeat(8000) }).error, undefined, 'the longest ordinary command fits');
  assert.match(commandPlan({ shell, command: "'".repeat(8000) }).error, /too long/);
});

test('each stream keeps only its last bytes, never splitting a character, and says it trimmed', () => {
  const tail = createTail(10);
  tail.push('0123456789');
  assert.deepEqual([tail.text(), tail.trimmed], ['0123456789', false], 'exactly the limit is not trimmed');
  tail.push('abc');
  assert.deepEqual([tail.text(), tail.trimmed, tail.bytes], ['3456789abc', true, 13]);
  const exact = createTail(7);
  exact.push('aé字\u{1F600}');
  assert.equal(exact.text(), '字\u{1F600}');
  const wide = createTail(6);
  wide.push('aé字\u{1F600}');
  assert.equal(wide.text(), '\u{1F600}', 'a cut character is dropped whole');
  const long = createTail(policy.COMPUTER_STDOUT_MAX);
  for (let i = 0; i < 2000; i++) long.push(`line ${i} ${'x'.repeat(80)}\n`);
  assert.ok(Buffer.byteLength(long.text()) <= policy.COMPUTER_STDOUT_MAX);
  assert.ok(long.text().endsWith(`line 1999 ${'x'.repeat(80)}\n`));
  assert.equal(long.trimmed, true);
});

const CLIXML = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
  '<Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T></TN><MS><I64 N="SourceId">1</I64></MS></Obj>' +
  '<S S="Error">Get-Item : Cannot find path &apos;C:\\nope&apos; because it does not exist._x000D__x000A_</S>' +
  'native stderr line\r\n' +
  '<S S="Error">At line:1 char:1 &lt;here&gt; caf\u00e9 _x005F_x0041_ snake_case_x000D__x000A_</S>' +
  '<S S="warning" />' +
  '</Objs>';
const DECODED = 'Get-Item : Cannot find path \'C:\\nope\' because it does not exist.\r\n' +
  'native stderr line\r\n' +
  'At line:1 char:1 <here> caf\u00e9 _x0041_ snake_case\r\n';

test('CLIXML on stderr is turned back into the text PowerShell meant', () => {
  const whole = createClixmlDecoder();
  assert.equal(whole.push('plain before\n' + CLIXML) + whole.end(), 'plain before\n' + DECODED);
  // Every split point, as pipes deliver it.
  for (let cut = 0; cut <= CLIXML.length; cut++) {
    const decoder = createClixmlDecoder();
    const text = decoder.push(CLIXML.slice(0, cut)) + decoder.push(CLIXML.slice(cut)) + decoder.end();
    assert.equal(text, DECODED, `split at ${cut}`);
  }
  const plain = createClixmlDecoder();
  assert.equal(plain.push('error: <not xml> #< partial') + plain.end(), 'error: <not xml> #< partial', 'ordinary stderr passes through');
  const unfinished = createClixmlDecoder();
  assert.equal(unfinished.push('#< CLIXML\r\n<Objs><S S="Error">half') + unfinished.end(), '<S S="Error">half', 'a killed process still shows what it wrote');
});

test('"Allow for this message" covers the same message in the same folder, and nothing else', () => {
  let now = 0;
  const allowance = createAllowance({ now: () => now, ttlMs: 1000, max: 2 });
  const inside = { root: '/Users/dana/1904/shop', path: '/Users/dana/1904/shop/src', outside: false };
  const first = validateRequest(request()).request;
  assert.equal(allowance.covers(first, inside), false);
  assert.equal(allowance.allow(first, inside), true);
  const later = validateRequest(request({ id: 'req_000000002', command: 'ls' })).request;
  assert.equal(allowance.covers(later, inside), true, 'a later request of the same message');
  assert.equal(allowance.covers(later, { ...inside, path: '/etc', outside: true }), false, 'never a request that leaves the folder');
  assert.equal(allowance.covers(later, { ...inside, root: '/Users/dana/code/shop' }), false, 'not after the folder changed');
  assert.equal(allowance.covers(validateRequest(request({ messageId: 'msg_000000002' })).request, inside), false, 'not the next message');
  assert.equal(allowance.covers(validateRequest(request({ task: { id: 'task_2', title: 'Other' } })).request, inside), false, 'not another task');
  assert.equal(allowance.covers(validateRequest(request({ app: { id: 'app_2', name: 'Blog', repo: 'blog' } })).request, inside), false, 'not another app');
  assert.equal(allowance.allow(first, { ...inside, outside: true }), false, 'an outside request cannot be allowed for the message');
  now = 1001;
  assert.equal(allowance.covers(later, inside), false, 'it does not last');
  allowance.allow(first, inside);
  allowance.clear();
  assert.equal(allowance.covers(later, inside), false);
});

test('an allowance lasts 30 minutes at most and ends when its task moves to another message', () => {
  assert.equal(policy.ALLOWANCE_MS, 30 * 60_000);
  let now = 0;
  const allowance = createAllowance({ now: () => now });
  const inside = { root: '/Users/dana/1904/shop', path: '/Users/dana/1904/shop', outside: false };
  const first = validateRequest(request()).request;
  const otherTask = validateRequest(request({ messageId: 'msg_000000009', task: { id: 'task_2', title: 'Other' } })).request;
  allowance.allow(first, inside);
  allowance.allow(otherTask, inside);
  allowance.seen(validateRequest(request({ id: 'req_000000002' })).request);
  assert.equal(allowance.covers(first, inside), true, 'the same message keeps it');
  allowance.seen(validateRequest(request({ id: 'req_000000003', messageId: 'msg_000000002' })).request);
  assert.equal(allowance.covers(first, inside), false, 'a new message on the task ends it');
  assert.equal(allowance.covers(otherTask, inside), true, 'other tasks keep theirs');
  now = 30 * 60_000;
  assert.equal(allowance.covers(otherTask, inside), true);
  now = 30 * 60_000 + 1;
  assert.equal(allowance.covers(otherTask, inside), false, 'and nothing lasts past 30 minutes');
});

test('results carry every field 1904 reads, within its limits', () => {
  assert.deepEqual(runningUpdate('req_000000001', '/Users/dana/1904/shop'), { requestId: 'req_000000001', status: 'running', cwd: '/Users/dana/1904/shop' });
  assert.deepEqual(finalUpdate({ requestId: 'req_000000001', status: 'declined', message: 'The person declined.' }), {
    requestId: 'req_000000001', status: 'declined', exitCode: null, stdout: '', stderr: '',
    trimmed: { stdout: false, stderr: false }, durationMs: 0, message: 'The person declined.',
  });
  const done = finalUpdate({ requestId: 'req_000000001', status: 'done', exitCode: 3, stdout: 'out', stderr: 'err', trimmed: { stdout: true }, durationMs: 12.6, cwd: '/x', message: 'm'.repeat(600) });
  assert.deepEqual([done.exitCode, done.trimmed, done.durationMs, done.message.length], [3, { stdout: true, stderr: false }, 13, 500]);
  assert.throws(() => finalUpdate({ requestId: 'req_000000001', status: 'expired' }), /Unknown result status/);
});

test('even the worst-case result body stays under the 400 KB 1904 accepts', () => {
  // Control characters are the most JSON escaping can grow: one byte becomes six.
  const stdout = createTail(policy.COMPUTER_STDOUT_MAX), stderr = createTail(policy.COMPUTER_STDERR_MAX);
  stdout.push('\u0001'.repeat(policy.COMPUTER_STDOUT_MAX * 2));
  stderr.push('\u0001'.repeat(policy.COMPUTER_STDERR_MAX * 2));
  const body = JSON.stringify(finalUpdate({
    requestId: 'r'.repeat(64), status: 'done', exitCode: -1073741510, stdout: stdout.text(), stderr: stderr.text(),
    trimmed: { stdout: true, stderr: true }, durationMs: 1_800_000, cwd: 'c'.repeat(policy.COMPUTER_CWD_MAX), message: 'm'.repeat(600),
  }));
  assert.ok(Buffer.byteLength(body) < 400_000, `${Buffer.byteLength(body)} bytes`);
});

test('the prompt shows characters that would hide or reorder a command', () => {
  assert.equal(visibleText('rm -rf safe\u202Edlo\u202C'), 'rm -rf safe<U+202E>dlo<U+202C>');
  assert.equal(visibleText('a\u200Bb\u001B[31mc\r\nd\re\tf'), 'a<U+200B>b<U+001B>[31mc\nd<U+000D>e\tf');
  assert.equal(visibleText('a\u2028b\u2029c'), 'a<U+2028>b<U+2029>c', 'line and paragraph separators');
  assert.equal(visibleText('x\u{E0041}\u{E007F}y'), 'x<U+E0041><U+E007F>y', 'tag characters');
  assert.equal(visibleText('a\uFE0Fb\u{E0100}c'), 'a<U+FE0F>b<U+E0100>c', 'variation selectors');
  assert.equal(visibleText('\u3164\u115F\uFFA0\u034F'), '<U+3164><U+115F><U+FFA0><U+034F>', 'fillers that render as nothing');
  assert.equal(visibleText('caf\u00E9 \u5B57'), 'caf\u00E9 \u5B57', 'ordinary text is left alone');
  assert.equal(policy.visibleLine('one\ntwo'), 'one<U+000A>two', 'a single line cannot break');
});

test('look-alike characters are named with their code points', () => {
  assert.deepEqual(policy.unusualCharacters('ls'), []);
  assert.deepEqual(policy.unusualCharacters('rm -rf /h\u043Eme\n\tok'), ['\u201C\u043E\u201D U+043E']);
  assert.deepEqual(policy.unusualCharacters('a\u202Eb\u00A0c\u{1F600}\u043E\u043E'), ['U+202E', 'U+00A0', '\u201C\u{1F600}\u201D U+1F600', '\u201C\u043E\u201D U+043E']);
  const many = policy.unusualCharacters(Array.from({ length: 25 }, (_, i) => String.fromCharCode(0x400 + i)).join(''));
  assert.equal(many.length, 21);
  assert.equal(many[20], 'and 5 more');
});

test('the computer’s default name, platform and environment', () => {
  assert.equal(defaultComputerName('Danas-MacBook-Pro.local'), 'Danas-MacBook-Pro');
  assert.equal(defaultComputerName('STUDIO-PC'), 'STUDIO-PC');
  assert.equal(defaultComputerName(''), 'My computer');
  assert.equal(defaultComputerName('x'.repeat(80)).length, 60);
  assert.deepEqual(['darwin', 'win32', 'linux'].map(computerPlatform), ['macos', 'windows', undefined]);
  assert.deepEqual(childEnvironment({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1', electron_no_attach_console: '1', HOME: '/h' }), { PATH: '/bin', HOME: '/h' });
});
