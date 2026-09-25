/**
 * Background service worker (MV3 module).
 *
 * Responsibilities:
 * 1. Timeout enforcement via chrome.alarms (survives popup close + throttling).
 * 2. Window-level focus signals via chrome.windows.onFocusChanged — records
 *    ONLY the fact + timestamp of leaving/returning to Chrome. Never URLs,
 *    titles, app names, keys, or contents.
 * 3. Study-tab tracking (v0.2): compares the activated tab id against the
 *    session's designated study_tab_id and records study_tab_inactive/active.
 *    Only numeric ids are compared — no URLs, titles, or contents read.
 * 4. Heartbeat + restart-gap detection: if Chrome restarts mid-attempt we set
 *    possibly_interrupted (never fabricate a result) so the UI can show a
 *    recovery banner and the researcher can abort.
 * 5. Message bridge for popup/dataset/side-panel pages.
 *
 * No network requests. No analytics.
 */
import { Repository } from '../storage/repository.js';
import { ChromeStorageAdapter } from '../storage/chromeAdapter.js';
import { refreshAttemptIntegrity, recordFocusSignal, timeoutAttempt } from '../session/sessionManager.js';

const HEARTBEAT_ALARM = 'puzzletrack-heartbeat';
const attemptAlarmName = (attemptId: string): string => `pt-attempt-${attemptId}`;
const RESTART_GAP_MS = 2 * 60 * 1000;

const adapter = new ChromeStorageAdapter();
const repo = new Repository(adapter);

async function withStore<T>(fn: (store: import('../models/types.js').PuzzleTrackStore) => Promise<T> | T): Promise<T> {
  const store = await repo.loadStore();
  const out = await fn(store);
  // Merge-save: popup/side-panel ticks and concurrent focus handlers must not
  // drop each other's appended events (last-write-wins loses data here).
  await repo.saveMerged(store, Date.now());
  return out;
}

async function scheduleTimeoutAlarm(attemptId: string, deadlineMs: number): Promise<void> {
  try {
    await chrome.alarms.create(attemptAlarmName(attemptId), { when: deadlineMs });
  } catch {
    // alarms unavailable in some test contexts — popup timestamp logic still enforces timeout.
  }
}

async function clearTimeoutAlarm(attemptId: string): Promise<void> {
  try {
    await chrome.alarms.clear(attemptAlarmName(attemptId));
  } catch {
    /* ignore */
  }
}

async function heartbeat(): Promise<void> {
  try {
    await withStore((store) => {
      store.lastHeartbeatMs = Date.now();
    });
  } catch {
    /* storage may be locked briefly; next beat retries */
  }
}

/** Detect restart gap: heartbeat far in the past while an attempt is still open. */
async function detectRestartGap(): Promise<void> {
  try {
    await withStore((store) => {
      const attemptId = store.activeAttemptId;
      if (!attemptId) return;
      const attempt = store.attempts[attemptId];
      if (!attempt || attempt.ended_at !== null) return;
      const last = store.lastHeartbeatMs;
      const now = Date.now();
      if (last !== null && now - last > RESTART_GAP_MS && !attempt.possibly_interrupted) {
        attempt.possibly_interrupted = true;
        Repository.appendEvent(store, {
          event_id: crypto.randomUUID(),
          attempt_id: attemptId,
          timestamp: new Date(now).toISOString(),
          event_type: 'window_blur',
          metadata: { source: 'restart-gap-detected', gapMs: now - last },
        });
      }
      store.lastHeartbeatMs = now;
    });
  } catch {
    /* ignore */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
  void heartbeat();
});

chrome.runtime.onStartup.addListener(() => {
  void detectRestartGap();
});

// Top-level run also fires on service-worker restart.
void detectRestartGap();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) {
    void heartbeat();
    return;
  }
  if (alarm.name.startsWith('pt-attempt-')) {
    const attemptId = alarm.name.slice('pt-attempt-'.length);
    void withStore((store) => {
      const attempt = store.attempts[attemptId];
      if (!attempt || attempt.ended_at !== null) return;
      timeoutAttempt(store, attemptId, Date.now());
    }).then(() => clearTimeoutAlarm(attemptId));
  }
});

// Window focus changes: record ONLY blur/focus fact. WINDOW_ID_NONE = Chrome not focused.
chrome.windows.onFocusChanged.addListener((windowId) => {
  void withStore((store) => {
    const attemptId = store.activeAttemptId;
    if (!attemptId) return;
    const attempt = store.attempts[attemptId];
    if (!attempt || attempt.ended_at !== null) return;
    const now = Date.now();
    const type = windowId === chrome.windows.WINDOW_ID_NONE ? 'window_blur' : 'window_focus';
    Repository.appendEvent(store, {
      event_id: crypto.randomUUID(),
      attempt_id: attemptId,
      timestamp: new Date(now).toISOString(),
      event_type: type,
      metadata: { source: 'background-windows-api' },
    });
    refreshAttemptIntegrity(store, attemptId, now);
  });
});

/** Last study-tab event type for an attempt (transition suppression). */
function lastStudyState(store: import('../models/types.js').PuzzleTrackStore, attemptId: string): 'active' | 'inactive' | null {
  const events = Repository.eventsForAttempt(store, attemptId);
  for (let i = events.length - 1; i >= 0; i--) {
    const t = (events[i] as { event_type: string }).event_type;
    if (t === 'study_tab_active') return 'active';
    if (t === 'study_tab_inactive') return 'inactive';
  }
  return null;
}

/**
 * Study-tab tracking. Compares ONLY numeric tab ids against the session's
 * designated study_tab_id. Duplicate consecutive states are suppressed so the
 * raw log stays clean (transitions only).
 */
function handleStudyTabState(activeTabId: number | null): void {
  void withStore((store) => {
    const attemptId = store.activeAttemptId;
    if (!attemptId) return;
    const attempt = store.attempts[attemptId];
    if (!attempt || attempt.ended_at !== null) return;
    const session = store.sessions[attempt.session_id];
    const studyTabId = session?.study_tab_id;
    if (studyTabId == null) return; // no designated study tab: v0.1 behavior
    const nowActive = activeTabId !== null && activeTabId === studyTabId;
    const last = lastStudyState(store, attemptId);
    // No prior study event: the attempt is assumed to start on the study tab
    // (designation captures the current tab), so only record departures.
    if (last === null && nowActive) return;
    if (last === 'active' && nowActive) return;
    if (last === 'inactive' && !nowActive) return;
    recordFocusSignal(store, attemptId, nowActive ? 'study_tab_active' : 'study_tab_inactive', Date.now());
  });
}

// chrome.tabs.onActivated fires with {tabId, windowId} — no "tabs"
// permission needed, and we never read url/title/contents.
chrome.tabs.onActivated.addListener((info) => {
  handleStudyTabState(info.tabId);
});

// Study tab closed mid-attempt: it can no longer be active.
chrome.tabs.onRemoved.addListener((tabId) => {
  void withStore((store) => {
    const attemptId = store.activeAttemptId;
    if (!attemptId) return;
    const attempt = store.attempts[attemptId];
    if (!attempt || attempt.ended_at !== null) return;
    const session = store.sessions[attempt.session_id];
    if (session?.study_tab_id === tabId) {
      handleStudyTabState(null);
    }
  });
});

export interface UiMessage {
  kind:
    | 'schedule-timeout'
    | 'clear-timeout'
    | 'heartbeat'
    | 'detect-restart-gap';
  attemptId?: string;
  deadlineMs?: number;
}

chrome.runtime.onMessage.addListener((msg: UiMessage, _sender, sendResponse) => {
  (async () => {
    if (msg.kind === 'schedule-timeout' && msg.attemptId && msg.deadlineMs) {
      await scheduleTimeoutAlarm(msg.attemptId, msg.deadlineMs);
      sendResponse({ ok: true });
    } else if (msg.kind === 'clear-timeout' && msg.attemptId) {
      await clearTimeoutAlarm(msg.attemptId);
      sendResponse({ ok: true });
    } else if (msg.kind === 'heartbeat') {
      await heartbeat();
      sendResponse({ ok: true });
    } else if (msg.kind === 'detect-restart-gap') {
      await detectRestartGap();
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false, error: 'unknown-message' });
    }
  })();
  return true;
});
