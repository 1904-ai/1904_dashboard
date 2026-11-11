// Use My Computer: keeps this computer reachable from 1904 while it is connected.
// One long poll at a time asks 1904 for requests. A request is answered only for a message this
// computer sent itself, or inside away mode the person started here. It is then shown to the person
// (unless "Allow for this message" or away mode already covers it), confirmed with 1904, run in the
// sandbox (or with full access, which always asks) and reported back. Network failures back off the
// way the dashboard's own recovery does; the loop rests while the computer sleeps or the person paused
// it, and stops for good when 1904 no longer accepts this computer's token. Everything it touches is
// passed in, so tests drive it with a stand-in 1904, a stand-in shell and a stand-in clock.

const path = require('node:path');
const { retryDelay } = require('./desktop-recovery.cjs');
const policy = require('./computer-policy.cjs');
const { TOO_LONG, createApprovalQueue, promptFits } = require('./computer-approval.cjs');
const { AWAY_PATH, leaseCovers, readLease } = require('./computer-away.cjs');
const { PAIR_PATH } = require('./computer-link.cjs');
const { resolveLoginPath, startRun } = require('./computer-runner.cjs');
const { SANDBOX_EXEC, sandboxPlan } = require('./computer-sandbox.cjs');

const POLL_PATH = '/api/desktop/computer/poll';
const RESULT_PATH = '/api/desktop/computer/result';
/** Disconnect asks 1904 to revoke the token for this long, then forgets it here either way. */
const DISCONNECT_TIMEOUT_MS = 10_000;
/** 1904 holds a poll for up to 25 s; one that has said nothing for this long is dropped and retried. */
const POLL_TIMEOUT_MS = policy.COMPUTER_POLL_HOLD_MS + 15_000;
const POST_TIMEOUT_MS = 30_000;
/** A poll answered this quickly with nothing new waits this long before the next one. */
const QUICK_ANSWER_MS = 2000;
/** While Use My Computer is turned off for the workspace, ask again this often. */
const DISABLED_WAIT_MS = 60_000;
/** While 1904 holds this account's commands (403 computer.blocked), ask again this often. */
const BLOCKED_WAIT_MS = 5 * 60_000;
/** A result that cannot be delivered is retried this many times, backing off like the dashboard. */
const RESULT_ATTEMPTS = 8;
/** "running" must be confirmed before anything starts; it is tried this many times (0, 2 and 6 s). */
const RUNNING_ATTEMPTS = 3;
/** On Disconnect or Quit, results of stopped commands get this long to go out. */
const SHUTDOWN_WAIT_MS = 3000;
const KEEP_FINISHED = 30;
const KEEP_IDS = 500;
/** Older commands Computer Activity lists from this computer's own log. */
const HISTORY_SHOWN = 100;
/** Output kept per command for the activity window, in characters. */
const ACTIVITY_OUTPUT_MAX = 64 * 1024;

const CONNECTION_TEXT = {
  'not-connected': () => 'This computer isn’t connected to 1904. Choose Use My Computer… in the 1904 menu to connect it.',
  revoked: () => 'This computer was disconnected from 1904. Choose Use My Computer… in the 1904 menu to connect it again.',
  lapsed: () => 'This computer’s connection to 1904 lapsed after 30 days without use. Choose Use My Computer… in the 1904 menu to connect it again.',
  connecting: () => 'Connecting to 1904…',
  connected: name => `Connected to 1904 as ${name}. Nothing runs until you approve it on this computer or start away mode.`,
  offline: () => 'Can’t reach 1904. Trying again automatically.',
  challenged: () => '1904 needs to check this connection. Open the 1904 Desktop window and it reconnects by itself.',
  disabled: () => 'Use My Computer is turned off for your workspace.',
  blocked: () => '1904 isn’t sending commands to this computer for your account right now. Trying again every few minutes.',
  sleeping: () => 'Paused while this computer sleeps.',
  paused: () => 'Use My Computer is paused on this computer. Choose Resume Use My Computer in the 1904 menu to take requests again.',
  unreadable: () => 'This computer’s 1904 key could not be read. Choose Disconnect This Computer in the 1904 menu, then connect it again.',
  disconnecting: () => 'Disconnecting…',
};

const DECLINED = 'The person declined.';
const WITHDRAWN = {
  disconnected: 'This computer was disconnected from 1904.',
  quit: '1904 Desktop quit before the person answered.',
  paused: 'The person paused Use My Computer on this computer.',
};
const WITHDRAWN_BY_1904 = '1904 withdrew this request before it started, so it did not run.';
const UNCONFIRMED = '1904 Desktop could not confirm this command with 1904, so it did not run it.';
const NO_SANDBOX = 'This Mac has no sandbox-exec, so 1904 Desktop cannot run this command in its sandbox. Ask for full access if the person agrees.';

function boundedAdd(set, value) {
  set.add(value);
  if (set.size > KEEP_IDS) set.delete(set.values().next().value);
}

function readPoll(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('1904 sent an answer this computer could not read.');
  const ids = value => Array.isArray(value) ? value.filter(id => policy.computerId(id)) : [];
  return {
    enabled: body.enabled !== false,
    message: policy.label(body.message, 300) || undefined,
    name: policy.label(body.computer?.name, policy.COMPUTER_NAME_MAX) || undefined,
    requests: Array.isArray(body.requests) ? body.requests : [],
    cancelled: ids(body.cancelled),
    awayEnded: ids(body.awayEnded),
  };
}

/**
 * - `fetch(url, init)`: requests to 1904 (the dashboard's session, in the app).
 * - `link`: computer-link.cjs. `messages`: computer-proof.cjs's sent-message list. `leases`: computer-away.cjs.
 *   `log`: computer-log.cjs (optional).
 * - `ask(request, options)`: the prompt (computer-approval.cjs createDialogAsk).
 * - `awayChoice({ taskTitle })`: the away-mode questions; resolves `{ minutes, network, maxCommands }` or nothing.
 * - `confirmPresence(reason)`: Touch ID; resolves true (confirmed), false (refused) or undefined (no Touch ID here).
 * - `confirmLease(lease)`: without Touch ID, the final question about the lease 1904 started (default Cancel).
 * - `fs`: `{ mkdir, stat, mkdtemp, rm, realpath }` returning promises; `realpathSync` for the sandbox profile.
 * - `spawn`, `kill`, `clock` (`now`, `setTimeout`, `clearTimeout`): passed to the runner.
 * - `onNotice({ kind, ... })`: things the person should hear about as a notification.
 */
function createComputerBridge({
  origin, fetch, link, messages, leases, log, platform, home, user = '', userData, tmpRoot, env = {}, exists = () => false,
  fs, realpathSync = value => value, spawn, kill, clock, ask, awayChoice = async () => undefined, confirmPresence = async () => false,
  confirmLease = async () => false,
  onChange = () => {}, onOutput = () => {}, onDisconnected = () => {}, onNotice = () => {},
  run = startRun, resolvePath = resolveLoginPath,
}) {
  const allowance = policy.createAllowance({ now: clock.now });
  const entries = new Map();
  const handles = new Map();
  const known = new Set();
  const cancelledIds = new Set();
  const apps = new Map();
  const inFlight = new Set();
  let active = false;
  let suspended = false;
  let generation = 0;
  let failures = 0;
  let status = 'not-connected';
  let statusMessage;
  let pollController;
  let wake;
  let awayTimer;
  let searchPath;
  // 1904's clock minus this computer's, from the Date header of the last poll; undefined until known.
  let skew;

  /** Full access: asked for, or this computer has no sandbox (Windows). Never covered without asking. */
  const isFull = request => platform !== 'macos' || request.access === 'full';
  const awayOffered = platform === 'macos';

  const describe = request => policy.placeFor({
    platform, home, app: request.app, chosen: link.folders.get(request.app.id), cwd: request.cwd,
  });

  /**
   * The lease that lets this request run without asking, if any. Only a request 1904 marked as sent
   * from elsewhere under that lease: a message from this window always asks, so neither the budget
   * nor the notification can be skipped.
   */
  function coveringLease(request) {
    if (request.origin?.kind !== 'away') return undefined;
    const lease = leases.get(request.origin.leaseId);
    return lease && leaseCovers(lease, request, { full: isFull(request), place: describe(request) }).ok ? lease : undefined;
  }

  /** What already covers a request: away mode, then "Allow for this message". Full access never is. */
  function covered(request) {
    if (isFull(request)) return undefined;
    const lease = coveringLease(request);
    if (lease) return { decision: 'away', network: request.network && lease.network };
    if (allowance.covers(request, describe(request))) return { decision: 'covered', network: request.network };
    return undefined;
  }

  const approvals = createApprovalQueue({
    clock,
    ask: (request, options) => ask(request, {
      ...options, describe, full: isFull(request), platform,
      ...(awayOffered && !isFull(request) && request.origin?.kind === 'desktop'
        ? { startAway: async () => (await startAway({ taskId: request.task.id, appId: request.app.id, taskTitle: request.task.title })).ok }
        : {}),
    }),
    precheck: covered,
    onAnswer: (request, answer) => { if (answer.choice === 'allow') allowance.allow(request, describe(request), answer.network); },
    onChange: () => onChange(),
  });

  const sleep = ms => new Promise(resolve => clock.setTimeout(resolve, ms));
  const inProgress = entry => ['waiting', 'starting', 'running'].includes(entry.status);

  function track(promise) {
    const tracked = Promise.resolve(promise).catch(() => {}).finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    return tracked;
  }

  function setStatus(next, message) {
    if (status === next && statusMessage === message) return;
    status = next;
    statusMessage = message;
    onChange();
  }

  // A rest the loop takes between polls. Without `ms` it lasts until something wakes it.
  function rest(ms) {
    return new Promise(resolve => {
      let timer;
      const done = () => {
        clock.clearTimeout(timer);
        if (wake === done) wake = undefined;
        resolve();
      };
      wake = done;
      if (ms !== undefined) timer = clock.setTimeout(done, ms);
    });
  }
  const rouse = () => wake?.();

  /**
   * When a prompt for this request closes, on this computer's clock. 1904's expiry is moved by the
   * measured clock difference, so a computer whose clock is off neither drops requests at once nor
   * keeps them open too long; and no request waits longer than its own lifetime from its arrival.
   */
  function deadlineFor(request) {
    const now = clock.now();
    const lifetime = Math.min(policy.COMPUTER_PENDING_MS, Math.max(0, request.expiresAt - request.createdAt));
    const latest = now + lifetime;
    return skew === undefined ? latest : Math.min(latest, request.expiresAt - skew);
  }

  // ── Activity ─────────────────────────────────────────────────────────────

  function prune() {
    const finished = [...entries.values()].filter(entry => !inProgress(entry));
    for (const entry of finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED))) entries.delete(entry.id);
  }

  function addEntry(request) {
    const place = describe(request);
    const entry = {
      id: request.id, messageId: request.messageId, task: request.task, sender: request.sender, app: request.app,
      command: request.command, reason: request.reason, timeoutSeconds: request.timeoutSeconds,
      access: isFull(request) ? 'full' : 'sandbox', network: false, origin: request.origin?.kind,
      folder: place.root, cwd: place.path, outside: place.outside, deadline: deadlineFor(request),
      status: 'waiting', approval: undefined, exitCode: null, message: undefined,
      createdAt: clock.now(), startedAt: undefined, endedAt: undefined, durationMs: undefined,
      output: [], outputLength: 0, outputCut: false,
    };
    entries.set(request.id, entry);
    prune();
    onChange();
    return entry;
  }

  /** A final status. Every one goes into this computer's own log. */
  function close(entry, next, fields = {}) {
    Object.assign(entry, fields, { status: next, endedAt: clock.now() });
    try { log?.append(entry); } catch { /* the log is a record, never a reason to fail */ }
    prune();
    onChange();
  }

  function appendOutput(entry, stream, text) {
    const last = entry.output[entry.output.length - 1];
    if (last?.stream === stream) last.text += text;
    else entry.output.push({ stream, text });
    entry.outputLength += text.length;
    while (entry.outputLength > ACTIVITY_OUTPUT_MAX && entry.output.length) {
      const first = entry.output[0];
      const excess = entry.outputLength - ACTIVITY_OUTPUT_MAX;
      if (first.text.length <= excess) {
        entry.output.shift();
        entry.outputLength -= first.text.length;
      } else {
        first.text = first.text.slice(excess);
        entry.outputLength -= excess;
      }
      entry.outputCut = true;
    }
    onOutput(entry.id, stream, text);
  }

  // ── Talking to 1904 ──────────────────────────────────────────────────────

  async function poll(token) {
    const controller = new AbortController();
    pollController = controller;
    const timer = clock.setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    try {
      const response = await fetch(origin + POLL_PATH, {
        method: 'GET', credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (response.status === 401) throw Object.assign(new Error('1904 no longer accepts this computer.'), { revoked: true });
      if (response.status === 403 && !response.headers?.get?.('cf-mitigated')) {
        const body = await response.json().catch(() => undefined);
        // A suspended account or an inactive person: the token stays, and the computer asks again later.
        if (body?.code === 'computer.blocked') {
          throw Object.assign(new Error('1904 is holding this account’s commands.'), { blocked: true, message: policy.label(body.error, 300) || undefined });
        }
      }
      if (!response.ok) {
        throw Object.assign(new Error(`1904 answered ${response.status}.`), { challenged: Boolean(response.headers?.get?.('cf-mitigated')) });
      }
      const date = Date.parse(response.headers?.get?.('date') ?? '');
      if (Number.isFinite(date)) skew = date - clock.now();
      return readPoll(await response.json());
    } finally {
      clock.clearTimeout(timer);
      if (pollController === controller) pollController = undefined;
    }
  }

  /** One authenticated call to 1904: `{ ok, status, body }`, or `{ ok: false, network: true }` when 1904 did not answer. */
  async function call(pathname, payload, { timeoutMs = POST_TIMEOUT_MS, method = 'POST' } = {}) {
    const token = await link.token();
    if (!token) return { ok: false, status: 0 };
    const controller = new AbortController();
    const timer = clock.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(origin + pathname, {
        method, credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(payload ? { 'content-type': 'application/json' } : {}) },
        ...(payload ? { body: JSON.stringify(payload) } : {}),
      });
      if (response.status === 401 && active) revoked();
      const body = await response.json().catch(() => undefined);
      return { ok: response.ok, status: response.status, body };
    } catch {
      return { ok: false, network: true };
    } finally {
      clock.clearTimeout(timer);
    }
  }

  /** Sends a final result. Network errors and 5xx are retried while the computer stays connected. */
  async function report(update, { retry = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      const sent = await call(RESULT_PATH, update);
      if (sent.ok) return true;
      // 409: the request already finished on 1904. 404: it is not this computer's. 401: the token is
      // gone. Any answer below 500 is final; sending it again cannot help.
      if (!sent.network && sent.status < 500) return false;
      if (!retry || !active || attempt + 1 >= RESULT_ATTEMPTS) return false;
      await sleep(retryDelay(attempt));
    }
  }

  /**
   * Tells 1904 the command is about to start, and waits for its answer: nothing starts until 1904
   * confirms. 'confirmed', 'withdrawn' (1904 refused: the request finished, was cancelled, timed out
   * or is not this computer's), 'revoked', or 'unconfirmed' (1904 could not be reached in time).
   */
  async function confirmRunning(request, cwd) {
    for (let attempt = 0; attempt < RUNNING_ATTEMPTS; attempt++) {
      if (attempt) await sleep(retryDelay(attempt - 1));
      if (!active) return 'unconfirmed';
      const sent = await call(RESULT_PATH, policy.runningUpdate(request.id, cwd));
      if (sent.ok) return 'confirmed';
      if (sent.status === 401) return 'revoked';
      // The away lease this request came under ended on 1904 (or ran past its time): end it here too.
      if (sent.body?.code === 'computer.away_ended' && request.origin?.kind === 'away') {
        endAway(request.origin.leaseId, { tellServer: false, reason: 'elsewhere' });
      }
      if (!sent.network && sent.status > 0 && sent.status < 500) return 'withdrawn';
      if (!sent.network && sent.status === 0) return 'unconfirmed';
    }
    return 'unconfirmed';
  }

  // ── Away mode ────────────────────────────────────────────────────────────

  function scheduleAwayEnd() {
    clock.clearTimeout(awayTimer);
    const next = leases.nextEnd();
    if (!Number.isFinite(next)) return;
    awayTimer = clock.setTimeout(() => {
      for (const lease of leases.expire()) onNotice({ kind: 'away-ended', lease, reason: 'time' });
      scheduleAwayEnd();
      approvals.recheck();
      onChange();
    }, Math.min(2_000_000_000, Math.max(0, next - clock.now())));
  }

  /** Ends a lease here. `tellServer`: it ended on this computer, so 1904 hears it too. */
  function endAway(id, { tellServer = true, reason = 'desktop' } = {}) {
    const lease = leases.end(id);
    if (!lease) return false;
    if (tellServer) track(call(AWAY_PATH, { action: 'end', leaseId: id }));
    onNotice({ kind: 'away-ended', lease, reason });
    scheduleAwayEnd();
    onChange();
    return true;
  }

  /**
   * Starts away mode for a task, only ever from this computer: the person's choices, then Touch ID
   * where available, then 1904. Resolves `{ ok, lease?, message? }`.
   */
  async function startAway({ taskId, appId, taskTitle }) {
    if (!awayOffered) return { ok: false, message: 'Away mode needs a sandbox, which 1904 Desktop has only on macOS for now.' };
    if (!active || !link.info()) return { ok: false, message: 'Connect this computer and resume Use My Computer first.' };
    if (!exists(SANDBOX_EXEC)) return { ok: false, message: NO_SANDBOX };
    const choice = await awayChoice({ taskTitle });
    if (!choice) return { ok: false };
    const minutes = policy.COMPUTER_AWAY_MINUTES.includes(choice.minutes) ? choice.minutes : undefined;
    const limits = policy.COMPUTER_AWAY_MAX_COMMANDS;
    const maxCommands = Number.isSafeInteger(choice.maxCommands) ? Math.min(limits.max, Math.max(limits.min, choice.maxCommands)) : limits.default;
    if (!minutes) return { ok: false };
    // true: Touch ID confirmed. false: refused. undefined: this Mac has no Touch ID.
    const presence = await confirmPresence(`start away mode for “${policy.label(taskTitle, 80) || 'this task'}”`);
    if (presence === false) return { ok: false };
    const asked = { taskId, appId, taskTitle, network: choice.network === true, maxCommands };
    const answer = await call(AWAY_PATH, { action: 'start', taskId, appId, minutes, network: asked.network, maxCommands });
    const lease = answer.ok ? readLease(answer.body, asked) : undefined;
    if (!lease) return { ok: false, message: policy.label(answer.body?.error, 300) || 'Away mode could not be started. Check your connection and try again.' };
    if (presence !== true) {
      // Without Touch ID, one last look at what 1904 started (its own task title), defaulting to Cancel.
      // Nothing runs under the lease until this is answered: it is kept here only afterwards.
      let confirmed = false;
      try { confirmed = await confirmLease({ ...lease, minutes }); } catch { confirmed = false; }
      if (!confirmed) {
        track(call(AWAY_PATH, { action: 'end', leaseId: lease.id }));
        return { ok: false };
      }
    }
    const started = leases.start(lease, minutes);
    scheduleAwayEnd();
    onNotice({ kind: 'away-started', lease: started });
    approvals.recheck();
    onChange();
    return { ok: true, lease: started };
  }

  // ── Requests ─────────────────────────────────────────────────────────────

  async function prepareFolder(place) {
    const isFolder = async target => {
      try { return (await fs.stat(target)).isDirectory(); } catch { return false; }
    };
    if (place.chosen) {
      if (!(await isFolder(place.root))) {
        return `The folder chosen for this app is not on this computer anymore: ${place.root}. The person can choose another in Computer Activity.`;
      }
    } else {
      try {
        await fs.mkdir(place.root, { recursive: true });
      } catch (error) {
        return `Could not create the app’s folder ${place.root}: ${error.code || error.message}`;
      }
    }
    if (!(await isFolder(place.path))) return `This folder does not exist on this computer: ${place.path}`;
    return undefined;
  }

  /** PATH for commands: Windows' own; on macOS the login shell's, asked once. */
  async function commandSearchPath() {
    if (platform === 'windows') return undefined;
    searchPath ??= resolvePath({ shellFile: policy.computerShell({ platform, env, exists }).file, home, user, spawn, kill, clock }).catch(() => undefined);
    return searchPath;
  }

  async function execute(request, entry, network) {
    const place = describe(request);
    const full = isFull(request);
    Object.assign(entry, { folder: place.root, cwd: place.path, outside: place.outside, status: 'starting', network: full || network });
    onChange();
    const fail = message => {
      close(entry, 'failed', { message });
      return report(policy.finalUpdate({ requestId: request.id, status: 'failed', cwd: place.path, message }), { retry: active });
    };
    const cancelled = () => {
      if (!cancelledIds.has(request.id)) return false;
      close(entry, 'cancelled', { message: 'The task cancelled this command.' });
      return true;
    };
    const problem = await prepareFolder(place);
    if (cancelled()) return;
    if (problem) return fail(problem);
    if (!full && !exists(SANDBOX_EXEC)) return fail(NO_SANDBOX);

    // Its own temp folder: the only place besides the app's folder a sandboxed command can write.
    let tempDir;
    try {
      tempDir = await fs.realpath(await fs.mkdtemp((platform === 'windows' ? path.win32 : path.posix).join(tmpRoot, '1904-run-')));
    } catch (error) {
      return fail(`Could not create a temporary folder for this command: ${error.code || error.message}`);
    }
    try {
      let sandbox;
      if (!full) {
        sandbox = sandboxPlan({ appFolder: place.root, tempDir, home, userData, network, realpath: realpathSync });
        if (sandbox.error) return await fail(sandbox.error);
      }
      const plan = policy.commandPlan({ shell: policy.computerShell({ platform, env, exists }), command: request.command, sandbox });
      if (plan.error) return await fail(plan.error);
      const commandEnv = policy.commandEnvironment({ platform, env, searchPath: await commandSearchPath(), tempDir, shellFile: plan.shellFile });

      const confirmation = await confirmRunning(request, place.path);
      if (confirmation === 'withdrawn') {
        close(entry, 'withdrawn', { message: WITHDRAWN_BY_1904 });
        return;
      }
      if (confirmation === 'revoked') {
        close(entry, 'cancelled', { message: WITHDRAWN.disconnected });
        return;
      }
      if (confirmation === 'unconfirmed') return await fail(UNCONFIRMED);
      if (cancelled()) {
        await report(policy.finalUpdate({ requestId: request.id, status: 'cancelled', cwd: place.path, message: 'The task cancelled this command.' }), { retry: false });
        return;
      }

      const started = run({
        plan, cwd: place.path, env: commandEnv, timeoutSeconds: request.timeoutSeconds,
        platform, spawn, kill, clock, onOutput: (stream, text) => appendOutput(entry, stream, text),
      });
      handles.set(request.id, started);
      if (started.pid) {
        Object.assign(entry, { status: 'running', startedAt: clock.now() });
        onChange();
      }
      const outcome = await started.done;
      handles.delete(request.id);
      close(entry, outcome.status, { exitCode: outcome.exitCode, message: outcome.message, durationMs: outcome.durationMs });
      await report(policy.finalUpdate({ requestId: request.id, ...outcome, cwd: place.path }), { retry: active });
    } finally {
      fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Whether this computer may answer the request at all: its own message, or its own away mode. */
  function originAllows(request) {
    if (request.origin?.kind === 'desktop') {
      return messages.has(request.messageId, request.task.id) ? { ok: true } : { ok: false, message: policy.NOT_FROM_DESKTOP };
    }
    if (request.origin?.kind === 'away') {
      return leaseCovers(leases.get(request.origin.leaseId), request, { full: isFull(request), place: describe(request) });
    }
    return { ok: false, message: policy.NOT_FROM_DESKTOP };
  }

  async function refuse(request, entry, message) {
    close(entry, 'failed', { message });
    await report(policy.finalUpdate({ requestId: request.id, status: 'failed', cwd: describe(request).path, message }), { retry: active });
  }

  async function handle(request, entry) {
    try {
      const allowed = originAllows(request);
      if (!allowed.ok) return await refuse(request, entry, allowed.message);
      // The prompt must show all of what runs. What it cannot show is never run, asked about or not.
      if (!promptFits(request.command)) return await refuse(request, entry, TOO_LONG);
      const answer = covered(request) ?? await approvals.enqueue(request, { deadline: entry.deadline });
      const { decision } = answer;
      if (decision === 'away' && request.origin?.kind !== 'away') {
        // The person started away mode from this request's own prompt: they approved this one here,
        // with the internet setting they chose for away mode.
        entry.approval = 'once';
        await execute(request, entry, request.network && Boolean(leases.forTask(request.task.id)?.network));
      } else if (decision === 'away') {
        const lease = leases.get(request.origin.leaseId);
        const check = leaseCovers(lease, request, { full: isFull(request), place: describe(request) });
        if (!check.ok) return await refuse(request, entry, check.message);
        // The budget counts what 1904 counts: commands from messages sent elsewhere.
        const current = leases.use(lease.id);
        if (!current) return await refuse(request, entry, 'Away mode ended before this command could start.');
        if (current.ended) {
          // 1904 ends it at the same count itself; nothing to tell it.
          onNotice({ kind: 'away-ended', lease: current, reason: 'budget' });
          scheduleAwayEnd();
        }
        entry.approval = 'away';
        onNotice({ kind: 'away-run', request, lease: current });
        await execute(request, entry, request.network && current.network);
      } else if (decision === 'once' || decision === 'allow' || decision === 'covered') {
        entry.approval = decision;
        await execute(request, entry, answer.network === true);
      } else if (decision === 'decline') {
        close(entry, 'declined');
        await report(policy.finalUpdate({ requestId: request.id, status: 'declined', cwd: describe(request).path, message: DECLINED }), { retry: active });
      } else if (decision === 'expired') {
        close(entry, 'expired');
      } else if (WITHDRAWN[decision]) {
        close(entry, 'cancelled', { message: WITHDRAWN[decision] });
        await report(policy.finalUpdate({ requestId: request.id, status: 'cancelled', message: WITHDRAWN[decision] }), { retry: false });
      } else {
        close(entry, 'cancelled', { message: 'The task cancelled this command.' });
      }
    } catch (error) {
      console.warn('1904 Desktop could not finish a computer request:', error?.message);
      handles.delete(request.id);
      if (inProgress(entry)) close(entry, 'failed', { message: 'Something went wrong on this computer.' });
    }
  }

  /** Takes one request from a poll. Returns true when it was new. */
  function accept(raw) {
    const checked = policy.validateRequest(raw);
    const id = checked.ok ? checked.request.id : checked.id;
    if (!id || known.has(id)) return false;
    boundedAdd(known, id);
    if (cancelledIds.has(id)) return false;
    if (!checked.ok) {
      track(report(policy.finalUpdate({ requestId: id, status: 'failed', message: checked.reason })));
      return true;
    }
    const request = checked.request;
    // A request from another message on the same task ends that task's allowance.
    allowance.seen(request);
    apps.set(request.app.id, request.app);
    const entry = addEntry(request);
    if (entry.deadline <= clock.now()) close(entry, 'expired');
    else track(handle(request, entry));
    return true;
  }

  function cancel(id, reason) {
    boundedAdd(cancelledIds, id);
    if (approvals.cancel(id, reason)) return;
    handles.get(id)?.stop(reason);
  }

  function receive(answer) {
    link.touch?.();
    if (answer.name && answer.name !== link.info()?.name) link.rename(answer.name);
    setStatus(answer.enabled ? 'connected' : 'disabled', answer.enabled ? undefined : answer.message);
    for (const id of answer.awayEnded) endAway(id, { tellServer: false, reason: 'elsewhere' });
    for (const id of answer.cancelled) cancel(id, 'cancelled');
    let fresh = 0;
    if (answer.enabled) for (const raw of answer.requests) if (accept(raw)) fresh++;
    onChange();
    return fresh;
  }

  // ── The loop ─────────────────────────────────────────────────────────────

  const current = mine => active && mine === generation;

  async function loop(mine) {
    while (current(mine)) {
      if (suspended) {
        await rest();
        continue;
      }
      const token = await link.token();
      if (!current(mine)) return;
      if (!token) {
        halt(link.info() ? 'unreadable' : 'not-connected');
        return;
      }
      const started = clock.now();
      let answer;
      try {
        answer = await poll(token);
      } catch (error) {
        if (!current(mine)) return;
        if (error.revoked) {
          revoked();
          return;
        }
        if (suspended) continue;
        if (error.blocked) {
          failures = 0;
          setStatus('blocked', error.message);
          await rest(BLOCKED_WAIT_MS);
          continue;
        }
        setStatus(error.challenged ? 'challenged' : 'offline');
        await rest(retryDelay(failures++));
        continue;
      }
      if (!current(mine)) return;
      failures = 0;
      const fresh = receive(answer);
      if (!answer.enabled) await rest(DISABLED_WAIT_MS);
      else if (!fresh && clock.now() - started < QUICK_ANSWER_MS) await rest(QUICK_ANSWER_MS);
    }
  }

  function halt(next, message) {
    active = false;
    generation++;
    pollController?.abort();
    rouse();
    setStatus(next, message);
  }

  function stopEverything(reason) {
    approvals.cancelAll(reason);
    for (const started of handles.values()) started.stop(reason);
  }

  /** Forgets everything tied to this pairing: the token, allowances, away mode, the list of sent messages. */
  function forgetPairing() {
    allowance.clear();
    leases.endAll();
    scheduleAwayEnd();
    messages.clear();
    link.forget();
  }

  // 1904 answered 401: the token was revoked (Disconnect in 1904 Settings), lapsed, or is unknown.
  function revoked() {
    const seenAt = link.seenAt?.();
    const lapsed = Number.isFinite(seenAt) && clock.now() - seenAt > policy.COMPUTER_PAIRING_IDLE_MS;
    halt(lapsed ? 'lapsed' : 'revoked');
    forgetPairing();
    stopEverything('disconnected');
    onDisconnected(lapsed ? 'lapsed' : 'revoked');
  }

  async function settleWithin(ms) {
    await Promise.race([Promise.allSettled([...inFlight]), sleep(ms)]);
  }

  function connection() {
    const info = link.info();
    let shown;
    if (!info) shown = status === 'revoked' || status === 'lapsed' ? status : 'not-connected';
    else if (link.paused()) shown = 'paused';
    else if (active || status === 'unreadable' || status === 'disconnecting') shown = status;
    else shown = 'connecting';
    const text = (shown === 'disabled' || shown === 'blocked') && statusMessage ? statusMessage : CONNECTION_TEXT[shown](info?.name);
    return { connected: Boolean(info), ...(info ? { id: info.id, name: info.name } : {}), platform, status: shown, paused: Boolean(info) && link.paused(), text };
  }

  function visibleRun(entry) {
    return {
      id: entry.id,
      task: { id: entry.task?.id, title: policy.visibleLine(entry.task?.title) },
      sender: { id: entry.sender?.id, name: policy.visibleLine(entry.sender?.name) },
      app: { id: entry.app?.id, name: policy.visibleLine(entry.app?.name) },
      command: policy.visibleText(entry.command), reason: policy.visibleLine(entry.reason),
      folder: policy.visibleLine(entry.folder), cwd: policy.visibleLine(entry.cwd), outside: Boolean(entry.outside),
      access: entry.access, network: Boolean(entry.network), origin: entry.origin,
      status: entry.status, approval: entry.approval, exitCode: entry.exitCode ?? null,
      message: entry.message, createdAt: entry.createdAt ?? entry.at, startedAt: entry.startedAt, endedAt: entry.endedAt,
      durationMs: entry.durationMs, timeoutSeconds: entry.timeoutSeconds,
    };
  }

  scheduleAwayEnd();

  return {
    describe,
    startAway,
    endAway: id => endAway(id, { tellServer: true, reason: 'desktop' }),
    /** Starts polling when this computer is connected and not paused. Returns whether it is now polling. */
    start() {
      if (!link.info()) return false;
      if (link.paused()) {
        setStatus('paused');
        return false;
      }
      if (active) return true;
      active = true;
      failures = 0;
      const mine = ++generation;
      setStatus(suspended ? 'sleeping' : 'connecting');
      void loop(mine);
      return true;
    },
    /** The Pause switch: no polling and no prompts until the person resumes. Running commands carry on. */
    setPaused(paused) {
      link.setPaused(paused);
      if (paused) {
        halt('paused');
        approvals.cancelAll('paused');
      } else {
        this.start();
      }
      onChange();
    },
    suspend() {
      suspended = true;
      pollController?.abort();
      if (active) setStatus('sleeping');
    },
    resume() {
      const wasAsleep = suspended;
      suspended = false;
      failures = 0;
      if (active && wasAsleep) setStatus('connecting');
      rouse();
    },
    /** The person's Stop in Computer Activity. */
    stopRun(id) {
      const started = handles.get(id);
      if (!started) return false;
      started.stop('stopped');
      return true;
    },
    /**
     * The person's Disconnect: stop everything, tell 1904 what was stopped, ask 1904 to revoke the
     * token, then forget it here. Offline or already revoked, it is forgotten here all the same.
     * Resolves whether 1904 confirmed the revocation.
     */
    async disconnect() {
      halt('disconnecting');
      stopEverything('disconnected');
      await settleWithin(SHUTDOWN_WAIT_MS);
      const revokedOnServer = (await call(PAIR_PATH, undefined, { method: 'DELETE', timeoutMs: DISCONNECT_TIMEOUT_MS })).ok;
      forgetPairing();
      setStatus('not-connected');
      return revokedOnServer;
    },
    /** Quitting: stop running commands and close prompts; the link stays for next time. */
    async shutdown() {
      halt('not-connected');
      stopEverything('quit');
      await settleWithin(SHUTDOWN_WAIT_MS);
    },
    busy() {
      return handles.size > 0 || Boolean(approvals.openId()) || approvals.waitingIds().length > 0 ||
        [...entries.values()].some(entry => entry.status === 'starting');
    },
    running() {
      return [...entries.values()].filter(entry => entry.status === 'running').length;
    },
    connection,
    apps() { return [...apps.values()]; },
    away() {
      return leases.list().map(lease => ({ ...lease, taskTitle: policy.visibleLine(lease.taskTitle), commandsLeft: lease.maxCommands - lease.used }));
    },
    /**
     * What Computer Activity shows, with every text 1904 or the agent wrote spelled out the way the
     * prompt shows it. Output (and older commands' output from the log) only when asked for, on the
     * window's first load.
     */
    snapshot({ output = false } = {}) {
      const asking = approvals.openId();
      const live = [...entries.values()].reverse();
      const liveIds = new Set(live.map(entry => entry.id));
      const history = (log?.list(HISTORY_SHOWN * 2 + live.length) ?? [])
        .filter(record => record.kind !== 'note' && !liveIds.has(record.id)).slice(0, HISTORY_SHOWN);
      return {
        connection: connection(),
        away: this.away(),
        runs: live.map(entry => ({
          ...visibleRun(entry), asking: entry.id === asking,
          ...(output ? { output: entry.output.map(segment => ({ ...segment })), outputCut: entry.outputCut } : {}),
        })),
        history: history.map(record => ({
          ...visibleRun(record),
          ...(output ? { output: [
            ...(record.stdout ? [{ stream: 'stdout', text: record.stdout }] : []),
            ...(record.stderr ? [{ stream: 'stderr', text: record.stderr }] : []),
          ] } : {}),
        })),
      };
    },
  };
}

module.exports = {
  POLL_PATH, RESULT_PATH, POLL_TIMEOUT_MS, QUICK_ANSWER_MS, DISABLED_WAIT_MS, BLOCKED_WAIT_MS, RESULT_ATTEMPTS,
  RUNNING_ATTEMPTS, WITHDRAWN_BY_1904, UNCONFIRMED, NO_SANDBOX, createComputerBridge,
};
