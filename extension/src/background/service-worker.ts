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
import { CHESSTEMPO_LIVE_BRIDGE } from '../integrations/featureFlags.js';
import { BRIDGE_CONTENT_SCRIPT_FILE, BRIDGE_HOST_MATCHES, BRIDGE_SCRIPT_ID } from '../integrations/bridgeConfig.js';
import { handleSiteEvent, type AutoDirective } from '../integrations/autoController.js';
import type { SiteEvent } from '../integrations/chessTempo/chessTempoTypes.js';
import { emptyBridgeStatus, type PuzzleTrackStore } from '../models/types.js';

const HEARTBEAT_ALARM = 'puzzletrack-heartbeat';
const attemptAlarmName = (attemptId: string): string => `pt-attempt-${attemptId}`;
const RESTART_GAP_MS = 2 * 60 * 1000;

const adapter = new ChromeStorageAdapter();
const repo = new Repository(adapter);

async function withStore<T>(fn: (store: import('../models/types.js').PuzzleTrackStore) => Promise<T> | T): Promise<T> {
  return repo.transact(fn);
}

function touchBridge(store: PuzzleTrackStore, patch: Partial<PuzzleTrackStore['bridgeStatus']>): void {
  store.bridgeStatus = {
    ...emptyBridgeStatus(),
    ...store.bridgeStatus,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
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
  // Browser relaunch orphans any injected bridge: require explicit reconnect.
  // (Service-worker restarts do NOT reset this — only full browser startup.)
  void withStore((store) => {
    if (store.bridgeStatus.connected) {
      touchBridge(store, { connected: false, tabId: null, error: 'Browser restarted — reconnect the study tab.' });
    }
  });
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
      // v0.3: experimental timeout is authoritative. Tell the bridge the
      // attempt ended so a later site result is recorded separately, never
      // overwriting the timeout.
      if (CHESSTEMPO_LIVE_BRIDGE && attempt.problem_id !== null) {
        notifyBridgeTab(store, { kind: 'pt-attempt-ended', problemId: attempt.problem_id });
      }
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
    if (!attemptId) {
      if (CHESSTEMPO_LIVE_BRIDGE && store.bridgeStatus.tabId === tabId) {
        touchBridge(store, { connected: false, tabId: null, error: 'Study tab closed.' });
      }
      return;
    }
    const attempt = store.attempts[attemptId];
    if (!attempt || attempt.ended_at !== null) return;
    const session = store.sessions[attempt.session_id];
    if (session?.study_tab_id === tabId) {
      handleStudyTabState(null);
    }
    if (CHESSTEMPO_LIVE_BRIDGE && store.bridgeStatus.tabId === tabId) {
      // Connection lost; the research timer continues on timestamps.
      touchBridge(store, { connected: false, tabId: null, error: 'ChessTempo tab closed. Timer continues.' });
    }
  });
});

// ---------------------------------------------------------------------------
// v0.3 live bridge (flag-gated; inert unless CHESSTEMPO_LIVE_BRIDGE is on).
// ---------------------------------------------------------------------------

/** Best-effort message to the connected study tab. Never throws. */
function notifyBridgeTab(
  store: PuzzleTrackStore,
  message: { kind: string; problemId?: string },
): void {
  const tabId = store.bridgeStatus.tabId;
  if (tabId === null) return;
  try {
    void chrome.tabs.sendMessage(tabId, message).catch(() => {
      // Tab unreachable (closed/navigated): status update happens on next
      // observed event or explicit reconnect. Timer data is unaffected.
    });
  } catch {
    /* ignore */
  }
}

function applyAutoDirectives(store: PuzzleTrackStore, directives: AutoDirective[]): void {
  for (const d of directives) {
    if (d.kind === 'schedule-timeout' && d.deadlineMs !== undefined) {
      void scheduleTimeoutAlarm(d.attemptId, d.deadlineMs);
      notifyBridgeTab(store, { kind: 'pt-attempt-started', problemId: d.problemId });
    } else if (d.kind === 'clear-timeout') {
      void clearTimeoutAlarm(d.attemptId);
      notifyBridgeTab(store, { kind: 'pt-attempt-ended', problemId: d.problemId });
    } else if (d.kind === 'notify-attempt-started' || d.kind === 'notify-attempt-ended') {
      notifyBridgeTab(store, { kind: d.kind === 'notify-attempt-started' ? 'pt-attempt-started' : 'pt-attempt-ended', problemId: d.problemId });
    }
  }
}

async function connectBridge(tabId: number): Promise<{ ok: boolean; error?: string }> {
  if (!CHESSTEMPO_LIVE_BRIDGE) return { ok: false, error: 'Live bridge is disabled in this build.' };
  if (!Number.isInteger(tabId) || tabId < 0) return { ok: false, error: 'Invalid tab id.' };
  try {
    // Dynamic registration: nothing is injected into any page until the
    // researcher explicitly connects. Non-persistent across sessions.
    // (Unregister-first instead of getRegisteredContentScripts, which needs a
    // newer Chrome than our minimum version.)
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
    } catch {
      /* was not registered */
    }
    await chrome.scripting.registerContentScripts([
      {
        id: BRIDGE_SCRIPT_ID,
        matches: BRIDGE_HOST_MATCHES,
        js: [BRIDGE_CONTENT_SCRIPT_FILE],
        runAt: 'document_idle',
        persistAcrossSessions: false,
      },
    ]);
    await withStore(store => {
      touchBridge(store, { connected: true, tabId, error: null, lastEvent: 'connected' });
    });
    // Scope is persisted before injection so only this tab starts an observer.
    await chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE_CONTENT_SCRIPT_FILE] });
  } catch (e) {
    await disconnectBridge('Bridge injection failed.');
    return { ok: false, error: e instanceof Error ? e.message : 'Could not inject bridge script.' };
  }
  await withStore((store) => {
    touchBridge(store, { connected: true, tabId, error: null, lastEvent: 'connected' });
  });
  return { ok: true };
}

async function disconnectBridge(reason: string): Promise<void> {
  const tabId = (await repo.loadStore()).bridgeStatus.tabId;
  if (tabId !== null) {
    try {
      await chrome.tabs.sendMessage(tabId, { kind: 'pt-bridge-shutdown' });
    } catch {
      /* tab already gone */
    }
  }
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
  } catch {
    /* was not registered */
  }
  await withStore((store) => {
    touchBridge(store, { connected: false, tabId: null, error: reason });
  });
}

async function handleSiteMessage(event: SiteEvent, eventId: string, senderTabId?: number): Promise<void> {
  if (!CHESSTEMPO_LIVE_BRIDGE) return;
  await withStore((store) => {
    if (senderTabId !== store.bridgeStatus.tabId) throw new Error('Observation came from an unconnected study tab.');
    store.bridgeReceipts ??= {};
    if (store.bridgeReceipts[eventId]) return;
    const processedMs = Date.now();
    if (!Number.isFinite(event.atMs) || event.atMs > processedMs + 1000) throw new Error('Invalid site observation timestamp.');
    const outcome = handleSiteEvent(store, event, event.atMs);
    for (const d of outcome.directives) {
      const log = store.events[d.attemptId];
      const lifecycle = log?.find(e => e.event_type === (event.kind === 'problem_loaded' ? 'attempt_started' : 'attempt_completed'));
      if (lifecycle) lifecycle.metadata = { ...lifecycle.metadata, source: 'live-bridge', observed_at: new Date(event.atMs).toISOString(), processed_at: new Date(processedMs).toISOString() };
    }
    applyAutoDirectives(store, outcome.directives);
    const patch: Partial<PuzzleTrackStore['bridgeStatus']> = { lastEvent: event.kind, error: null };
    if (event.kind === 'problem_loaded' && event.problem) {
      patch.problemId = event.problem.problemId;
      patch.problemRating = event.problem.problemRating;
      if (event.context?.displayedRating != null) patch.playerRating = event.context.displayedRating;
    }
    if (event.kind === 'adapter_lost') {
      patch.connected = false;
      patch.error = event.reason ?? 'Adapter lost connection. Timer continues.';
    }
    if (event.kind === 'adapter_recovered') {
      patch.connected = true;
      patch.error = null;
    }
    store.bridgeReceipts[eventId] = new Date(processedMs).toISOString();
    touchBridge(store, patch);
  });
}

export interface UiMessage {
  kind:
    | 'schedule-timeout'
    | 'clear-timeout'
    | 'heartbeat'
    | 'detect-restart-gap'
    | 'pt-bridge-connect'
    | 'pt-bridge-disconnect'
    | 'pt-diagnostic-request'
    | 'pt-session-started';
  attemptId?: string;
  deadlineMs?: number;
  tabId?: number;
  reason?: string;
}

chrome.runtime.onMessage.addListener((msg: UiMessage, sender, sendResponse) => {
  // Content-script semantic events (flag-gated inside the handler).
  const siteMsg = msg as UiMessage & { event?: SiteEvent; eventId?: string };
  if ((msg.kind as string) === 'pt-outbox-scope') {
    void repo.loadStore().then(store => sendResponse({ tabId: store.bridgeStatus.connected && store.bridgeStatus.tabId === sender.tab?.id ? sender.tab.id : undefined })).catch(() => sendResponse({}));
    return true;
  }
  if ((msg.kind as string) === 'pt-site-event' && siteMsg.event && typeof siteMsg.eventId === 'string') {
    void handleSiteMessage(siteMsg.event, siteMsg.eventId, sender.tab?.id).then(() => sendResponse({ ok: true }), e => sendResponse({ ok: false, error: e instanceof Error ? e.message : 'Observation failed.' }));
    return true;
  }
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
    } else if (msg.kind === 'pt-bridge-connect' && msg.tabId !== undefined) {
      sendResponse(await connectBridge(msg.tabId));
    } else if (msg.kind === 'pt-bridge-disconnect') {
      await disconnectBridge(msg.reason ?? 'Disconnected by researcher.');
      sendResponse({ ok: true });
    } else if (msg.kind === 'pt-session-started') {
      const store = await repo.loadStore();
      if (store.bridgeStatus.tabId === null) throw new Error('Study tab is not connected.');
      sendResponse(await chrome.tabs.sendMessage(store.bridgeStatus.tabId, { kind: 'pt-session-started' }));
    } else if (msg.kind === 'pt-diagnostic-request' && msg.tabId !== undefined) {
      try {
        const diagnostics = await chrome.tabs.sendMessage(msg.tabId, { kind: 'pt-diagnostic-request' });
        sendResponse(diagnostics);
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : 'Tab unreachable.' });
      }
    } else {
      sendResponse({ ok: false, error: 'unknown-message' });
    }
  })().catch(e => sendResponse({ ok: false, error: e instanceof Error ? e.message : 'Operation failed.' }));
  return true;
});
