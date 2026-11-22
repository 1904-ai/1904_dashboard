const { taskUrl } = require('./desktop-links.cjs');

const TASK_NOTICE_TIMEOUT_MS = 12_000;
const TASK_NOTICE_HOVER_RESUME_MIN_MS = 2_500;
const TASK_NOTICE_HIDE_MS = 180;
const TASK_NOTICE_WIDTH = 384;
const TASK_NOTICE_DEFAULT_HEIGHT = 176;
const TASK_NOTICE_MIN_HEIGHT = 124;
const TASK_NOTICE_MAX_HEIGHT = 260;
const TASK_NOTICE_MARGIN = 16;
const MAX_NOTIFIED_IDS = 1024;
const MAX_QUEUED_NOTICES = 16;

const DEFAULTS = {
  task_needs_you: {
    badge: 'Needs attention',
    title: 'A task needs your input',
    body: 'Open 1904 Desktop to view the task.',
  },
  task_ready: {
    badge: 'Task ready',
    title: 'A task is ready for review',
    body: 'Open 1904 Desktop to view the task.',
  },
};

function cleanText(value, maxLength) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Validates and normalizes an incoming task notification from the dashboard.
 * Returns null if the destination, id, or kind is not allowed.
 */
function normalizeTaskNotice(item, origin) {
  const target = taskUrl(item?.href, origin);
  if (!target || typeof item?.id !== 'string' || !/^[a-z0-9:_-]{1,128}$/i.test(item.id) ||
      !Object.hasOwn(DEFAULTS, item.kind)) {
    return null;
  }
  const fallback = DEFAULTS[item.kind];
  const title = cleanText(item.title, 100) || fallback.title;
  const body = cleanText(item.body, 220) || fallback.body;
  return {
    id: item.id,
    kind: item.kind,
    href: target.href,
    path: target.pathname + target.search,
    badge: fallback.badge,
    title,
    body,
  };
}

/**
 * Computes bottom-right coordinates inside a display's workArea (above the taskbar).
 */
function noticeBounds(workArea, width = TASK_NOTICE_WIDTH, height = TASK_NOTICE_DEFAULT_HEIGHT, margin = TASK_NOTICE_MARGIN) {
  const area = workArea || { x: 0, y: 0, width: 1280, height: 800 };
  const clampedWidth = Math.max(240, Math.min(Math.round(width), Math.max(240, area.width - margin * 2)));
  const clampedHeight = Math.max(TASK_NOTICE_MIN_HEIGHT, Math.min(Math.round(height), TASK_NOTICE_MAX_HEIGHT, Math.max(TASK_NOTICE_MIN_HEIGHT, area.height - margin * 2)));
  return {
    x: Math.round(area.x + Math.max(0, area.width - clampedWidth - margin)),
    y: Math.round(area.y + Math.max(0, area.height - clampedHeight - margin)),
    width: clampedWidth,
    height: clampedHeight,
  };
}

/**
 * Coordinates the Windows bottom-right task notification drawer:
 * - Deduplicates by notification id.
 * - Shows one notice at a time with a 12-second auto-dismiss timer.
 * - Pauses the countdown while hovered and resumes cleanly when the pointer leaves.
 * - Close and timeout ONLY dismiss the popup; only explicit 'open' opens the task.
 */
function createTaskNoticeController({
  timeoutMs = TASK_NOTICE_TIMEOUT_MS,
  resumeMinMs = TASK_NOTICE_HOVER_RESUME_MIN_MS,
  hideDelayMs = TASK_NOTICE_HIDE_MS,
  maxQueue = MAX_QUEUED_NOTICES,
  clock = {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: timer => clearTimeout(timer),
  },
  createNonce = () => `${clock.now()}-${Math.random().toString(36).slice(2, 10)}`,
  onShow = () => {},
  onHide = () => {},
  onOpen = () => {},
  onTimer = () => {},
} = {}) {
  const seen = new Set();
  const queue = [];
  let active = null;
  let dismissTimer;
  let nextTimer;
  let disposed = false;

  function clearDismissTimer() {
    if (dismissTimer !== undefined) {
      clock.clearTimeout(dismissTimer);
      dismissTimer = undefined;
    }
  }

  function clearNextTimer() {
    if (nextTimer !== undefined) {
      clock.clearTimeout(nextTimer);
      nextTimer = undefined;
    }
  }

  function remember(id) {
    seen.add(id);
    if (seen.size > MAX_NOTIFIED_IDS) {
      seen.delete(seen.values().next().value);
    }
  }

  function armTimer(ms) {
    clearDismissTimer();
    if (!active || disposed) return;
    const duration = Math.max(0, Math.round(ms));
    active.hovered = false;
    active.remainingMs = duration;
    active.deadline = clock.now() + duration;
    dismissTimer = clock.setTimeout(() => {
      dismissTimer = undefined;
      dismissCurrent('timeout');
    }, duration);
  }

  function showNext() {
    clearNextTimer();
    if (disposed || active || queue.length === 0) return;
    const notice = queue.shift();
    const nonce = createNonce();
    active = { notice, nonce, hovered: false, remainingMs: timeoutMs, deadline: 0 };
    armTimer(timeoutMs);
    onShow({
      nonce,
      notice,
      timeoutMs,
      remainingMs: timeoutMs,
      queuedCount: queue.length,
    });
  }

  function dismissCurrent(reason) {
    if (!active) return null;
    clearDismissTimer();
    const current = active;
    active = null;
    onHide({ nonce: current.nonce, reason, hasNext: queue.length > 0 });
    if (reason === 'open') {
      onOpen(current.notice);
    }
    if (!disposed && queue.length > 0) {
      clearNextTimer();
      nextTimer = clock.setTimeout(() => {
        nextTimer = undefined;
        showNext();
      }, hideDelayMs);
    }
    return current.notice;
  }

  return {
    enqueue(notice) {
      if (disposed || !notice) return false;
      if (seen.has(notice.id)) return true;
      remember(notice.id);
      const existingQueued = queue.findIndex(entry => entry.path === notice.path);
      if (existingQueued >= 0) {
        queue[existingQueued] = notice;
      } else {
        if (queue.length >= maxQueue) queue.shift();
        queue.push(notice);
      }
      if (!active && nextTimer === undefined) {
        showNext();
      } else if (active) {
        onTimer({ nonce: active.nonce, paused: active.hovered, remainingMs: active.hovered ? active.remainingMs : Math.max(0, active.deadline - clock.now()), queuedCount: queue.length });
      }
      return true;
    },

    act(nonce, action) {
      if (disposed || !active || typeof nonce !== 'string' || nonce !== active.nonce) return false;
      if (action !== 'open' && action !== 'close') return false;
      dismissCurrent(action);
      return true;
    },

    setHovered(nonce, hovered) {
      if (disposed || !active || typeof nonce !== 'string' || nonce !== active.nonce || typeof hovered !== 'boolean') return false;
      if (hovered === active.hovered) return true;
      if (hovered) {
        const remaining = Math.max(0, active.deadline - clock.now());
        clearDismissTimer();
        active.hovered = true;
        active.remainingMs = remaining;
        onTimer({ nonce: active.nonce, paused: true, remainingMs: remaining, queuedCount: queue.length });
      } else {
        const resumeMs = Math.max(resumeMinMs, active.remainingMs);
        armTimer(resumeMs);
        onTimer({ nonce: active.nonce, paused: false, remainingMs: resumeMs, queuedCount: queue.length });
      }
      return true;
    },

    active() {
      return active ? { nonce: active.nonce, notice: active.notice, hovered: active.hovered, queuedCount: queue.length } : null;
    },

    dispose() {
      disposed = true;
      clearDismissTimer();
      clearNextTimer();
      queue.length = 0;
      active = null;
    },
  };
}

module.exports = {
  TASK_NOTICE_TIMEOUT_MS,
  TASK_NOTICE_HOVER_RESUME_MIN_MS,
  TASK_NOTICE_HIDE_MS,
  TASK_NOTICE_WIDTH,
  TASK_NOTICE_DEFAULT_HEIGHT,
  TASK_NOTICE_MIN_HEIGHT,
  TASK_NOTICE_MAX_HEIGHT,
  TASK_NOTICE_MARGIN,
  normalizeTaskNotice,
  noticeBounds,
  createTaskNoticeController,
};
