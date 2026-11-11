// Use My Computer: this computer's own record of every command it was asked to run, what the person
// decided and what came out. One JSON line per command in the app's data folder, the newest 1,000
// kept, each stream's output cut to its last 4 KB. Computer Activity shows it; nothing sends it anywhere.

const fs = require('node:fs');
const path = require('node:path');
const { COMPUTER_COMMAND_MAX, createTail } = require('./computer-policy.cjs');

const LOG_MAX = 1000;
const LOG_OUTPUT_MAX = 4 * 1024;

const tailOf = (text, max) => {
  const tail = createTail(max);
  tail.push(text);
  return tail.text();
};

/** The line kept for one finished entry. */
function logRecord(entry, max = LOG_OUTPUT_MAX) {
  const stream = name => tailOf((entry.output || []).filter(segment => segment.stream === name).map(segment => segment.text).join(''), max);
  return {
    id: entry.id, messageId: entry.messageId, at: entry.createdAt, endedAt: entry.endedAt,
    task: { id: entry.task?.id, title: entry.task?.title }, sender: { id: entry.sender?.id, name: entry.sender?.name },
    app: { id: entry.app?.id, name: entry.app?.name },
    command: String(entry.command ?? '').slice(0, COMPUTER_COMMAND_MAX), reason: entry.reason,
    folder: entry.folder, cwd: entry.cwd, outside: Boolean(entry.outside),
    access: entry.access, network: Boolean(entry.network), origin: entry.origin, approval: entry.approval,
    status: entry.status, exitCode: entry.exitCode ?? null, durationMs: entry.durationMs, message: entry.message,
    stdout: stream('stdout'), stderr: stream('stderr'),
  };
}

function createActivityLog({ file, max = LOG_MAX }) {
  let lines;
  function load() {
    if (lines !== undefined) return;
    try {
      lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('1904 Desktop could not read its activity log.');
      lines = 0;
    }
  }
  function read() {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
    } catch {
      return [];
    }
  }
  function write(record) {
    load();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
      lines++;
      // Rewritten now and then rather than on every line.
      if (lines > max + Math.ceil(max / 5)) {
        const kept = read().slice(-max);
        fs.writeFileSync(file + '.tmp', kept.map(line => JSON.stringify(line) + '\n').join(''), { mode: 0o600 });
        fs.renameSync(file + '.tmp', file);
        lines = kept.length;
      }
    } catch {
      console.warn('1904 Desktop could not write its activity log.');
    }
  }
  return {
    /** One finished command. */
    append(entry) {
      write(logRecord(entry));
    },
    /** Something worth keeping that is not a command, such as a message that left without its stamp. */
    note({ text, ...fields }) {
      write({ kind: 'note', at: Date.now(), ...fields, note: String(text ?? '').slice(0, 500) });
    },
    /** The newest `limit` records, newest first. */
    list(limit = max) {
      return read().slice(-max).reverse().slice(0, limit);
    },
  };
}

module.exports = { LOG_MAX, LOG_OUTPUT_MAX, logRecord, createActivityLog };
