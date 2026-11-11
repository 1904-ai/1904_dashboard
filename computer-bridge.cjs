// Use My Computer: keeps this computer reachable from 1904 while it is connected.
// One long poll at a time asks 1904 for requests. Each request is shown to the person (unless their
// "Allow for this message" already covers it), confirmed with 1904, run, and reported back. Network
// failures back off the way the dashboard's own recovery does; the loop rests while the computer
// sleeps and stops for good when 1904 no longer accepts this computer's token. Everything it touches
// is passed in, so tests drive it with a stand-in 1904, a stand-in shell and a stand-in clock.

const { retryDelay } = require('./desktop-recovery.cjs');
const policy = require('./computer-policy.cjs');
const { TOO_LONG, createApprovalQueue, promptFits } = require('./computer-approval.cjs');
const { PAIR_PATH } = require('./computer-link.cjs');
const { startRun } = require('./computer-runner.cjs');

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
/** Output kept per command for the activity window, in characters. */
const ACTIVITY_OUTPUT_MAX = 64 * 1024;

const CONNECTION_TEXT = {
  'not-connected': () => 'This computer isn’t connected to 1904. Choose Use My Computer… in the 1904 menu to connect it.',
  revoked: () => 'This computer was disconnected from 1904. Choose Use My Computer… in the 1904 menu to connect it again.',
  connecting: () => 'Connecting to 1904…',
  connected: name => `Connected to 1904 as ${name}. Nothing runs until you approve it on this computer.`,
  offline: () => 'Can’t reach 1904. Trying again automatically.',
  challenged: () => '1904 needs to check this connection. Open the 1904 Desktop window and it reconnects by itself.',
  disabled: () => 'Use My Computer is turned off for your workspace.',
  blocked: () => '1904 isn’t sending commands to this computer for your account right now. Trying again every few minutes.',
  sleeping: () => 'Paused while this computer sleeps.',
  unreadable: () => 'This computer’s 1904 key could not be read. Choose Disconnect This Computer in the 1904 menu, then connect it again.',
  disconnecting: () => 'Disconnecting…',
};

const DECLINED = 'The person declined.';
const WITHDRAWN = {
  disconnected: 'This computer was disconnected from 1904.',
  quit: '1904 Desktop quit before the person answered.',
};
const WITHDRAWN_BY_1904 = '1904 withdrew this request before it started, so it did not run.';
const UNCONFIRMED = '1904 Desktop could not confirm this command with 1904, so it did not run it.';

function boundedAdd(set, value) {
  set.add(value);
  if (set.size > KEEP_IDS) set.delete(set.values().next().value);
}

function readPoll(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('1904 sent an answer this computer could not read.');
  return {
    enabled: body.enabled !== false,
    message: policy.label(body.message, 300) || undefined,
    name: policy.label(body.computer?.name, policy.COMPUTER_NAME_MAX) || undefined,
    requests: Array.isArray(body.requests) ? body.requests : [],
    cancelled: Array.isArray(body.cancelled) ? body.cancelled.filter(id => policy.computerId(id)) : [],
  };
}

/**
 * - `fetch(url, init)`: requests to 1904 (the dashboard's session, in the app).
 * - `link`: computer-link.cjs (info, token, forget, rename, folders.get).
 * - `ask(request, { signal, describe })`: shows the prompt; resolves 'once', 'allow' or 'decline'.
 * - `fs`: `{ mkdir(path, options), stat(path) }` returning promises.
 * - `spawn`, `kill`, `clock` (`now`, `setTimeout`, `clearTimeout`): passed to the runner.
 */
function createComputerBridge({
  origin, fetch, link, platform, home, env = {}, exists = () => false, fs, spawn, kill, clock, ask,
  onChange = () => {}, onOutput = () => {}, onDisconnected = () => {}, run = startRun,
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
  // 1904's clock minus this computer's, from the Date header of the last poll; undefined until known.
  let skew;

  const describe = request => policy.placeFor({
    platform, home, app: request.app, chosen: link.folders.get(request.app.id), cwd: request.cwd,
  });

  const approvals = createApprovalQueue({
    clock,
    ask: (request, options) => ask(request, { ...options, describe }),
    precheck: request => allowance.covers(request, describe(request)) ? 'covered' : undefined,
    onAnswer: (request, choice) => { if (choice === 'allow') allowance.allow(request, describe(request)); },
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

  function close(entry, next, fields = {}) {
    Object.assign(entry, fields, { status: next, endedAt: clock.now() });
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

  /** Sends one update once: `{ ok, status }`, or `{ ok: false, network: true }` when 1904 did not answer. */
  async function send(update) {
    const token = await link.token();
    if (!token) return { ok: false, status: 0 };
    const controller = new AbortController();
    const timer = clock.setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    try {
      const response = await fetch(origin + RESULT_PATH, {
        method: 'POST', credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(update),
      });
      if (response.status === 401 && active) revoked();
      return { ok: response.ok, status: response.status };
    } catch {
      return { ok: false, network: true };
    } finally {
      clock.clearTimeout(timer);
    }
  }

  /** Sends a final result. Network errors and 5xx are retried while the computer stays connected. */
  async function report(update, { retry = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      const sent = await send(update);
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
      const sent = await send(policy.runningUpdate(request.id, cwd));
      if (sent.ok) return 'confirmed';
      if (sent.status === 401) return 'revoked';
      if (!sent.network && sent.status > 0 && sent.status < 500) return 'withdrawn';
      if (!sent.network && sent.status === 0) return 'unconfirmed';
    }
    return 'unconfirmed';
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

  async function execute(request, entry) {
    const place = describe(request);
    Object.assign(entry, { folder: place.root, cwd: place.path, outside: place.outside, status: 'starting' });
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
    const plan = policy.commandPlan({ shell: policy.computerShell({ platform, env, exists }), command: request.command });
    if (plan.error) return fail(plan.error);

    const confirmation = await confirmRunning(request, place.path);
    if (confirmation === 'withdrawn') {
      close(entry, 'withdrawn', { message: WITHDRAWN_BY_1904 });
      return;
    }
    if (confirmation === 'revoked') {
      close(entry, 'cancelled', { message: WITHDRAWN.disconnected });
      return;
    }
    if (confirmation === 'unconfirmed') return fail(UNCONFIRMED);
    if (cancelled()) {
      await report(policy.finalUpdate({ requestId: request.id, status: 'cancelled', cwd: place.path, message: 'The task cancelled this command.' }), { retry: false });
      return;
    }

    const started = run({
      plan, cwd: place.path, env: policy.childEnvironment(env), timeoutSeconds: request.timeoutSeconds,
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
  }

  async function handle(request, entry) {
    try {
      // The prompt must show all of what runs. What it cannot show is never run, asked about or not.
      if (!promptFits(request.command)) {
        close(entry, 'failed', { message: TOO_LONG });
        await report(policy.finalUpdate({ requestId: request.id, status: 'failed', cwd: describe(request).path, message: TOO_LONG }), { retry: active });
        return;
      }
      const decision = allowance.covers(request, describe(request)) ? 'covered' : await approvals.enqueue(request, { deadline: entry.deadline });
      if (decision === 'once' || decision === 'allow' || decision === 'covered') {
        entry.approval = decision;
        await execute(request, entry);
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
    if (answer.name && answer.name !== link.info()?.name) link.rename(answer.name);
    setStatus(answer.enabled ? 'connected' : 'disabled', answer.enabled ? undefined : answer.message);
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

  // 1904 answered 401: the token was revoked (Disconnect in 1904 Settings) or is unknown.
  function revoked() {
    halt('revoked');
    link.forget();
    allowance.clear();
    stopEverything('disconnected');
    onDisconnected('revoked');
  }

  async function settleWithin(ms) {
    await Promise.race([Promise.allSettled([...inFlight]), sleep(ms)]);
  }

  /** Asks 1904 to revoke this computer's token. Whether or not that works, the caller forgets it here. */
  async function revokeOnServer() {
    const token = await link.token().catch(() => undefined);
    if (!token) return false;
    const controller = new AbortController();
    const timer = clock.setTimeout(() => controller.abort(), DISCONNECT_TIMEOUT_MS);
    try {
      const response = await fetch(origin + PAIR_PATH, {
        method: 'DELETE', credentials: 'include', cache: 'no-store', signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clock.clearTimeout(timer);
    }
  }

  function connection() {
    const info = link.info();
    let shown;
    if (!info) shown = status === 'revoked' ? 'revoked' : 'not-connected';
    else if (active || status === 'unreadable' || status === 'disconnecting') shown = status;
    else shown = 'connecting';
    const text = (shown === 'disabled' || shown === 'blocked') && statusMessage ? statusMessage : CONNECTION_TEXT[shown](info?.name);
    return { connected: Boolean(info), ...(info ? { id: info.id, name: info.name } : {}), platform, status: shown, text };
  }

  return {
    describe,
    /** Starts polling when this computer is connected. Returns whether it is now polling. */
    start() {
      if (!link.info()) return false;
      if (active) return true;
      active = true;
      failures = 0;
      const mine = ++generation;
      setStatus(suspended ? 'sleeping' : 'connecting');
      void loop(mine);
      return true;
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
      const revokedOnServer = await revokeOnServer();
      allowance.clear();
      link.forget();
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
    /**
     * What Computer Activity shows, with every text 1904 or the agent wrote spelled out the way the
     * prompt shows it. Output is included only when asked for (the window's first load).
     */
    snapshot({ output = false } = {}) {
      const asking = approvals.openId();
      return {
        connection: connection(),
        runs: [...entries.values()].reverse().map(entry => ({
          id: entry.id,
          task: { id: entry.task.id, title: policy.visibleLine(entry.task.title) },
          sender: { id: entry.sender.id, name: policy.visibleLine(entry.sender.name) },
          app: { id: entry.app.id, name: policy.visibleLine(entry.app.name) },
          command: policy.visibleText(entry.command), reason: policy.visibleLine(entry.reason),
          folder: policy.visibleLine(entry.folder), cwd: policy.visibleLine(entry.cwd), outside: entry.outside,
          status: entry.status, asking: entry.id === asking, approval: entry.approval, exitCode: entry.exitCode,
          message: entry.message, createdAt: entry.createdAt, startedAt: entry.startedAt, endedAt: entry.endedAt,
          durationMs: entry.durationMs, timeoutSeconds: entry.timeoutSeconds,
          ...(output ? { output: entry.output.map(segment => ({ ...segment })), outputCut: entry.outputCut } : {}),
        })),
      };
    },
  };
}

module.exports = {
  POLL_PATH, RESULT_PATH, POLL_TIMEOUT_MS, QUICK_ANSWER_MS, DISABLED_WAIT_MS, BLOCKED_WAIT_MS, RESULT_ATTEMPTS,
  RUNNING_ATTEMPTS, WITHDRAWN_BY_1904, UNCONFIRMED, createComputerBridge,
};
