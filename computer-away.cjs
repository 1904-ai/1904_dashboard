// Use My Computer, away mode: a lease the person starts on this computer, for one task, so its
// agent can keep running sandboxed commands while they are away. It ends at its time, when its
// command budget is used, from 1904 Desktop, or from any of the person's devices through 1904.
// The cloud can never start or extend one: only this computer's own record of the lease counts.
// No Electron in here; the dialogs are described here and shown by main.cjs.

const fs = require('node:fs');
const path = require('node:path');
const { COMPUTER_AWAY_MAX_COMMANDS, COMPUTER_AWAY_MINUTES, computerId, label, visibleLine } = require('./computer-policy.cjs');

const AWAY_PATH = '/api/desktop/computer/away';
const AWAY_BUDGETS = Object.freeze([10, 25, 50, 100, 200]);
const DURATION_NAMES = { 30: '30 minutes', 60: '1 hour', 120: '2 hours', 240: '4 hours', 480: '8 hours' };

/** First question: for how long, and whether commands may use the internet (off unless ticked). Cancel is the default. */
function awayDurationPrompt(taskTitle) {
  return {
    type: 'question', title: 'Away mode',
    message: `Keep “${label(taskTitle, 120) || 'this task'}” working while you’re away?`,
    detail: 'For the time you choose, this task’s agent can run commands on this computer without asking, for messages you send ' +
      'from a browser or a phone. Every command runs in the sandbox: it can change files only in the app’s folder and can’t read your keys ' +
      'or personal folders. Messages you send from this window still ask, and a command that needs full access still waits for you here. ' +
      'Each command is listed in Computer Activity and announced with a notification. You can end away mode at any time from the 1904 menu, ' +
      'Computer Activity or the dashboard.',
    buttons: ['Cancel', ...COMPUTER_AWAY_MINUTES.map(minutes => DURATION_NAMES[minutes])],
    minutes: [null, ...COMPUTER_AWAY_MINUTES],
    defaultId: 0, cancelId: 0, noLink: true,
    checkboxLabel: 'Let these commands use the internet', checkboxChecked: false,
  };
}

/** Second question: how many commands at most. 50 is the default. */
function awayBudgetPrompt() {
  return {
    type: 'question', title: 'Away mode',
    message: 'How many commands may it run at most?',
    detail: 'Away mode ends when this many commands have run, even if time is left.',
    buttons: ['Cancel', ...AWAY_BUDGETS.map(count => `${count} commands`)],
    budgets: [null, ...AWAY_BUDGETS],
    defaultId: 1 + AWAY_BUDGETS.indexOf(COMPUTER_AWAY_MAX_COMMANDS.default), cancelId: 0, noLink: true,
  };
}

/** Without Touch ID, the last question after 1904 started the lease: its own task title and the limits. Cancel is the default. */
function awayConfirmPrompt(lease) {
  const hours = lease.minutes >= 60 ? `${lease.minutes / 60} hour${lease.minutes === 60 ? '' : 's'}` : `${lease.minutes} minutes`;
  return {
    type: 'warning', title: 'Away mode',
    message: `Start away mode for “${visibleLine(lease.taskTitle)}”?`,
    detail: `For ${hours}, up to ${lease.maxCommands} sandboxed commands from this task may run on this computer without asking, ` +
      `${lease.network ? 'with' : 'without'} internet access. A command that needs full access still waits for you here.`,
    buttons: ['Cancel', 'Start away mode'], defaultId: 0, cancelId: 0, noLink: true,
  };
}

/** A lease as 1904 returned it, checked against what this computer asked for. Undefined when it does not match. */
function readLease(value, asked) {
  const lease = value?.lease;
  if (!lease || typeof lease !== 'object') return undefined;
  const id = computerId(lease.id);
  if (!id || lease.taskId !== asked.taskId || lease.appId !== asked.appId) return undefined;
  // This computer asked for these limits; 1904 can only narrow them.
  const maxCommands = Number.isSafeInteger(lease.maxCommands) ? Math.min(lease.maxCommands, asked.maxCommands) : asked.maxCommands;
  return {
    // 1904's own name for the task, not whatever the page passed in.
    id, taskId: asked.taskId, appId: asked.appId, taskTitle: label(lease.taskTitle, 200) || label(asked.taskTitle, 200) || 'Task',
    network: asked.network && lease.network !== false,
    maxCommands, used: Number.isSafeInteger(lease.used) && lease.used > 0 ? Math.min(lease.used, maxCommands) : 0,
  };
}

/**
 * The leases on this computer, kept in memory and in a small file so a restart does not end them
 * (in memory only when no file is given).
 * `endsAt` is on this computer's clock: when the person started it plus the length they chose.
 */
function createAwayLeases({ file, now = Date.now }) {
  let leases;
  function load() {
    if (leases) return;
    leases = new Map();
    if (!file) return;
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const lease of Array.isArray(value) ? value : []) {
        if (computerId(lease?.id) && typeof lease.taskId === 'string' && Number.isFinite(lease.endsAt) && Number.isSafeInteger(lease.maxCommands)) {
          leases.set(lease.id, lease);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('1904 Desktop could not read its away mode.');
    }
  }
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify([...leases.values()]), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch {
      console.warn('1904 Desktop could not save its away mode.');
    }
  }
  const live = lease => lease && now() < lease.endsAt && lease.used < lease.maxCommands;
  /** Ends leases whose time or budget ran out; returns them. */
  function expire() {
    load();
    const ended = [...leases.values()].filter(lease => !live(lease));
    for (const lease of ended) leases.delete(lease.id);
    if (ended.length) save();
    return ended;
  }

  return {
    expire,
    start(lease, minutes) {
      load();
      // One lease per task: a new one replaces the old.
      for (const old of leases.values()) if (old.taskId === lease.taskId) leases.delete(old.id);
      const started = { ...lease, startedAt: now(), endsAt: now() + minutes * 60_000 };
      leases.set(started.id, started);
      save();
      return started;
    },
    get(id) { expire(); return leases.get(id); },
    forTask(taskId) { expire(); return [...leases.values()].find(lease => lease.taskId === taskId); },
    list() { expire(); return [...leases.values()]; },
    /** The next time a lease runs out, for a timer. */
    nextEnd() { load(); return Math.min(Infinity, ...[...leases.values()].map(lease => lease.endsAt)); },
    /** Counts one command. Returns the lease, with `ended` when that used its budget. */
    use(id) {
      load();
      const lease = leases.get(id);
      if (!live(lease)) return undefined;
      lease.used++;
      const ended = lease.used >= lease.maxCommands;
      if (ended) leases.delete(id);
      save();
      return { ...lease, ended };
    },
    end(id) {
      load();
      const lease = leases.get(id);
      if (!lease) return undefined;
      leases.delete(id);
      save();
      return lease;
    },
    endAll() {
      load();
      const all = [...leases.values()];
      leases.clear();
      save();
      return all;
    },
  };
}

/**
 * Whether a lease lets this request run without asking. `full`: the request needs full access (or the
 * computer has no sandbox), which away mode never covers. `place`: where it would start.
 * Returns `{ ok: true }` or `{ ok: false, message }`, the message written for the agent.
 */
function leaseCovers(lease, request, { full, place }) {
  // Only a request 1904 marked as sent from elsewhere under this very lease. A message from this window always asks.
  if (!lease || request.origin?.kind !== 'away' || request.origin.leaseId !== lease.id ||
      lease.taskId !== request.task.id || lease.appId !== request.app.id) {
    return { ok: false, message: 'Away mode is not on for this task on this computer, so 1904 Desktop will not run commands for it.' };
  }
  if (full) return { ok: false, message: 'Away mode covers sandboxed commands only. A command that needs full access waits for the person at the computer.' };
  if (request.network && !lease.network) return { ok: false, message: 'Away mode for this task has no internet access, so this command did not run.' };
  if (place?.outside) return { ok: false, message: 'Away mode covers commands that start in the app’s folder only, so this command did not run.' };
  if (lease.used >= lease.maxCommands) return { ok: false, message: 'Away mode for this task has used its command budget.' };
  return { ok: true };
}

module.exports = { AWAY_PATH, AWAY_BUDGETS, awayDurationPrompt, awayBudgetPrompt, awayConfirmPrompt, readLease, createAwayLeases, leaseCovers };
