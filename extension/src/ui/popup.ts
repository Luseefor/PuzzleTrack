/**
 * Popup / side-panel controller (shared). Timestamp-driven UI over the domain layer.
 *
 * The side panel loads the same bundle via sidepanel.html — same session state,
 * same logic, no duplication. Closing the popup or side panel never stops the
 * timer: state is re-read from storage on every tick.
 *
 * - Tick loop recomputes remaining/elapsed from stored started_at every 250ms.
 * - Popup close/reload never resets the clock: state is re-read from storage.
 * - Integrity listeners (visibilitychange, blur/focus) only record the FACT
 *   of focus change for the ACTIVE attempt. No URLs, titles, keys, contents.
 * - Abort requires confirmation. Timeout result is locked (no override).
 */
import { Repository } from '../storage/repository.js';
import { ChromeStorageAdapter } from '../storage/chromeAdapter.js';
import {
  abortAttempt,
  completeAttempt,
  createSession,
  designateStudyTab,
  markInterruptedAborted,
  recordFocusSignal,
  refreshAttemptIntegrity,
  setManualProblemId,
  startAttempt,
  summarizeSession,
  timeoutAttempt,
} from '../session/sessionManager.js';
import { summarizeChess } from '../analysis/derived.js';
import { recoverTimer } from '../timer/attemptTimer.js';
import { formatDurationMs, formatMMSS } from '../utils/time.js';
import { attemptsToCsv, downloadFilename } from '../export/csv.js';
import { backupFilename, buildBackup, serializeBackup } from '../export/jsonBackup.js';
import type { Attempt, PuzzleTrackStore, Session } from '../models/types.js';

const adapter = new ChromeStorageAdapter();
const repo = new Repository(adapter);

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
};

let lastSummaryAttemptId: string | null = null;
let lastDoneSessionId: string | null = null;
let tickHandle: number | null = null;

async function load(): Promise<PuzzleTrackStore> {
  return repo.loadStore();
}
/**
 * Merge-save (not last-write-wins): the 250 ms tick loop races the background
 * focus handlers, so every write unions concurrent events instead of dropping
 * them. Returns the converged store.
 */
async function save(store: PuzzleTrackStore): Promise<PuzzleTrackStore> {
  return repo.saveMerged(store, Date.now());
}

const VIEW_STATUS: Record<string, 'is-idle' | 'is-ready' | 'is-live' | 'is-done'> = {
  'view-setup': 'is-idle',
  'view-ready': 'is-ready',
  'view-active': 'is-live',
  'view-summary': 'is-done',
  'view-done': 'is-done',
};

function show(viewId: string): void {
  for (const id of ['view-setup', 'view-ready', 'view-active', 'view-summary', 'view-done']) {
    $(id).hidden = id !== viewId;
  }
  const dot = $('status-dot');
  dot.classList.remove('is-idle', 'is-ready', 'is-live', 'is-done');
  dot.classList.add(VIEW_STATUS[viewId] ?? 'is-idle');
}

function setError(msg: string): void {
  const el = $('setup-error');
  el.textContent = msg;
  el.hidden = msg.length === 0;
}

function downloadFile(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv(filename: string, text: string): void {
  downloadFile(filename, text, 'text/csv;charset=utf-8');
}

function notifyBackground(kind: 'schedule-timeout' | 'clear-timeout', attemptId: string, deadlineMs?: number): void {
  try {
    chrome.runtime.sendMessage({ kind, attemptId, deadlineMs }, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* background may be unavailable in tests */
  }
}

function participantMap(store: PuzzleTrackStore): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of Object.values(store.sessions)) m.set(s.session_id, s.participant_id);
  return m;
}

async function exportSessionCsv(sessionId: string): Promise<void> {
  const store = await load();
  const session = store.sessions[sessionId];
  if (!session) return;
  const attempts = Repository.attemptsForSession(store, sessionId);
  downloadCsv(downloadFilename(`session-${sessionId.slice(0, 8)}`, new Date().toISOString()), attemptsToCsv(participantMap(store), attempts));
}

async function exportAllCsv(): Promise<void> {
  const store = await load();
  downloadCsv(downloadFilename('full-dataset', new Date().toISOString()), attemptsToCsv(participantMap(store), Object.values(store.attempts)));
}

function attemptContext(store: PuzzleTrackStore): { session: Session; attempt: Attempt } | null {
  const attemptId = store.activeAttemptId;
  if (!attemptId) return null;
  const attempt = store.attempts[attemptId];
  if (!attempt) return null;
  const session = store.sessions[attempt.session_id];
  if (!session) return null;
  return { session, attempt };
}

/** Check timeout deterministically from timestamps; persist if reached. */
async function maybeTimeoutActive(store: PuzzleTrackStore, nowMs: number): Promise<boolean> {
  const ctx = attemptContext(store);
  if (!ctx || ctx.attempt.ended_at !== null) return false;
  const snap = recoverTimer(ctx.attempt.started_at, ctx.attempt.time_limit_seconds, nowMs);
  if (!snap.timedOut) return false;
  timeoutAttempt(store, ctx.attempt.attempt_id, nowMs);
  await save(store);
  notifyBackground('clear-timeout', ctx.attempt.attempt_id);
  lastSummaryAttemptId = ctx.attempt.attempt_id;
  return true;
}

async function render(): Promise<void> {
  const nowMs = Date.now();
  const store = await load();
  await maybeTimeoutActive(store, nowMs);
  // Re-read after potential timeout write.
  const s = await load();
  const recoveryBanner = $('recovery-banner');
  const timeoutBanner = $('timeout-banner');

  const ctx = attemptContext(s);

  // Session-complete view takes precedence when the last session finished.
  const activeSession = s.activeSessionId ? s.sessions[s.activeSessionId] : undefined;
  const doneSessionId = lastDoneSessionId ?? findJustCompletedSession(s);

  if (ctx && ctx.attempt.ended_at === null) {
    // ---- ACTIVE ----
    const snap = recoverTimer(ctx.attempt.started_at, ctx.attempt.time_limit_seconds, nowMs);
    refreshAttemptIntegrity(s, ctx.attempt.attempt_id, nowMs);
    const converged = await save(s);
    const attempt = converged.attempts[ctx.attempt.attempt_id] as Attempt;

    show('view-active');
    timeoutBanner.hidden = true;
    const interrupted = attempt.possibly_interrupted;
    recoveryBanner.hidden = !interrupted;

    $('active-title').textContent = `Puzzle ${attempt.attempt_number} of ${ctx.session.target_attempts}`;
    const cd = $('countdown');
    cd.textContent = formatMMSS(Math.ceil(snap.remainingClampedMs / 1000));
    const urgent = snap.remainingClampedMs < 60_000;
    cd.classList.toggle('urgent', urgent);
    const totalMs = ctx.session.time_limit_seconds * 1000;
    const frac = totalMs > 0 ? Math.max(0, Math.min(1, snap.remainingClampedMs / totalMs)) : 0;
    const bar = $('countdown-bar');
    bar.style.width = `${frac * 100}%`;
    bar.classList.toggle('urgent', urgent);
    $('stat-elapsed').textContent = formatDurationMs(Math.max(0, snap.elapsedMs));
    $('stat-limit').textContent = formatDurationMs(ctx.session.time_limit_seconds * 1000);
    $('stat-focus').textContent = String(attempt.focus_loss_count);
    $('stat-problem').textContent = attempt.manual_problem_id ?? attempt.problem_id ?? '–';
    return;
  }

  recoveryBanner.hidden = true;

  if (lastSummaryAttemptId) {
    const summary = s.attempts[lastSummaryAttemptId];
    if (summary && summary.ended_at !== null) {
      const session = s.sessions[summary.session_id];
      show('view-summary');
      const justTimedOut = summary.experimental_result === 'timeout';
      timeoutBanner.hidden = !justTimedOut;
      if (justTimedOut) {
        $('summary-title').textContent = `Puzzle ${summary.attempt_number} — TIME LIMIT REACHED`;
      } else {
        $('summary-title').textContent = `Puzzle ${summary.attempt_number} complete`;
      }
      $('sum-result').textContent =
        summary.experimental_result === 'completed' ? 'Completed' : summary.experimental_result === 'timeout' ? 'Timeout' : 'Aborted';
      $('sum-elapsed').textContent = formatDurationMs(summary.elapsed_ms);
      $('sum-focus').textContent = String(summary.focus_loss_count);
      $('sum-away').textContent = formatDurationMs(summary.total_time_away_ms);
      const match = s.matches[summary.attempt_id];
      $('sum-match').textContent = match
        ? `${match.confidence} (${match.matchedBy})`
        : summary.manual_problem_id
          ? `Unmatched · Problem #${summary.manual_problem_id}`
          : 'Unmatched';
      ($('input-problem-id-after') as HTMLInputElement).value = summary.manual_problem_id ?? '';
      // If that was the final puzzle, Next goes to session-complete.
      if (session && session.status === 'completed') lastDoneSessionId = session.session_id;
      return;
    }
    lastSummaryAttemptId = null;
  }

  timeoutBanner.hidden = true;

  if (doneSessionId && s.sessions[doneSessionId]) {
    // ---- SESSION COMPLETE ----
    const session = s.sessions[doneSessionId] as Session;
    const summary = summarizeSession(s, session.session_id);
    const attempts = Repository.attemptsForSession(s, session.session_id);
    const chess = summarizeChess(attempts);
    const finished = attempts.filter((a) => a.ended_at !== null);
    show('view-done');
    $('done-participant').textContent = session.participant_id;
    $('done-attempts').textContent = String(summary.total);
    $('done-completed').textContent = String(summary.completed);
    $('done-timeout').textContent = String(summary.timedOut);
    $('done-aborted').textContent = String(summary.aborted);
    $('done-median').textContent = formatDurationMs(summary.medianElapsedMs);
    // Chess (matched only; null-safe — never misleading).
    const total = finished.length;
    $('done-correct').textContent = chess.correct === null ? `– / ${total}` : `${chess.correct} / ${chess.withResult}`;
    $('done-med-rating').textContent = chess.medianProblemRating === null ? '–' : String(Math.round(chess.medianProblemRating));
    $('done-med-reldiff').textContent =
      chess.medianRelativeDifficulty === null
        ? '–'
        : (chess.medianRelativeDifficulty > 0 ? '+' : '') + String(Math.round(chess.medianRelativeDifficulty));
    $('done-avg-change').textContent =
      chess.averageRatingChange === null ? '–' : (chess.averageRatingChange > 0 ? '+' : '') + chess.averageRatingChange.toFixed(1);
    // Integrity.
    $('done-focus').textContent = String(summary.totalFocusInterruptions);
    $('done-flagged').textContent = String(summary.attemptsWithIntegrityFlags);
    $('done-away').textContent = formatDurationMs(finished.reduce((sum, a) => sum + a.total_time_away_ms, 0));
    // Matching.
    $('done-matched').textContent = `${chess.matched} / ${total}`;
    $('done-unmatched').textContent = String(chess.unmatched);
    return;
  }

  if (activeSession && activeSession.status === 'active') {
    // ---- READY (between attempts) ----
    show('view-ready');
    const done = Repository.attemptsForSession(s, activeSession.session_id).filter((a) => a.ended_at !== null).length;
    $('ready-title').textContent = `Puzzle ${done + 1} of ${activeSession.target_attempts}`;
    $('ready-meta').textContent = `${formatDurationMs(activeSession.time_limit_seconds * 1000)} per puzzle · Participant ${activeSession.participant_id}`;
    $('ready-study').textContent =
      activeSession.study_tab_id != null ? `Study tab designated (tab #${activeSession.study_tab_id})` : 'Study tab: not designated';
    return;
  }

  // ---- SETUP ----
  show('view-setup');
}

function findJustCompletedSession(store: PuzzleTrackStore): string | null {
  const completed = Object.values(store.sessions).filter((x) => x.status === 'completed');
  if (completed.length === 0) return null;
  completed.sort((a, b) => (a.completed_at ?? '') < (b.completed_at ?? '') ? 1 : -1);
  return completed[0]?.session_id ?? null;
}

async function persistFocusSignal(type: 'tab_hidden' | 'tab_visible' | 'window_blur' | 'window_focus'): Promise<void> {
  try {
    const store = await load();
    const id = store.activeAttemptId;
    if (!id) return;
    const attempt = store.attempts[id];
    if (!attempt || attempt.ended_at !== null) return;
    recordFocusSignal(store, id, type, Date.now());
    await save(store);
  } catch {
    /* never break the participant flow on telemetry failure */
  }
}

function wireIntegrityListeners(): void {
  document.addEventListener('visibilitychange', () => {
    void persistFocusSignal(document.visibilityState === 'hidden' ? 'tab_hidden' : 'tab_visible');
  });
  window.addEventListener('blur', () => void persistFocusSignal('window_blur'));
  window.addEventListener('focus', () => void persistFocusSignal('window_focus'));
}

function wireButtons(): void {
  $('btn-start-session').addEventListener('click', () => {
    void (async () => {
      setError('');
      try {
        const pid = ($('input-participant') as HTMLInputElement).value;
        const count = Number(($('input-count') as HTMLInputElement).value);
        const checked = document.querySelector('input[name="limit"]:checked') as HTMLInputElement | null;
        const limit = Number(checked?.value ?? '900');
        const store = await load();
        createSession(store, pid, count, limit, Date.now());
        await save(store);
        lastSummaryAttemptId = null;
        lastDoneSessionId = null;
        await render();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not start session.');
      }
    })();
  });

  $('btn-start-attempt').addEventListener('click', () => {
    void (async () => {
      const store = await load();
      if (!store.activeSessionId) return;
      const nowMs = Date.now();
      const attempt = startAttempt(store, store.activeSessionId, nowMs);
      // Optional problem-ID annotation aids later ChessTempo matching.
      const manualId = ($('input-problem-id') as HTMLInputElement).value.trim();
      if (manualId !== '') {
        try {
          setManualProblemId(store, attempt.attempt_id, manualId, nowMs);
        } catch (e) {
          // Annotation is optional — never block the attempt on it.
          console.warn('Could not save problem ID:', e);
        }
      }
      ($('input-problem-id') as HTMLInputElement).value = '';
      await save(store);
      notifyBackground('schedule-timeout', attempt.attempt_id, Date.parse(attempt.started_at) + attempt.time_limit_seconds * 1000);
      lastSummaryAttemptId = null;
      await render();
    })();
  });

  $('btn-save-problem-id').addEventListener('click', () => {
    void (async () => {
      if (!lastSummaryAttemptId) return;
      const value = ($('input-problem-id-after') as HTMLInputElement).value.trim();
      if (value === '') return;
      try {
        const store = await load();
        setManualProblemId(store, lastSummaryAttemptId, value, Date.now());
        await save(store);
        await render();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : 'Could not save problem ID.');
      }
    })();
  });

  $('btn-designate-tab').addEventListener('click', () => {
    void (async () => {
      try {
        // No "tabs" permission: query returns the active tab with its numeric
        // id only (no URL/title), which is exactly what we store.
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tabId = tabs[0]?.id;
        if (tabId === undefined) {
          window.alert('Could not identify the current tab.');
          return;
        }
        const store = await load();
        if (!store.activeSessionId) return;
        designateStudyTab(store, store.activeSessionId, tabId);
        await save(store);
        await render();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : 'Could not designate study tab.');
      }
    })();
  });

  $('btn-complete').addEventListener('click', () => {
    void (async () => {
      const store = await load();
      if (!store.activeAttemptId) return;
      const id = store.activeAttemptId;
      completeAttempt(store, id, Date.now());
      await save(store);
      notifyBackground('clear-timeout', id);
      lastSummaryAttemptId = id;
      await render();
    })();
  });

  $('btn-abort').addEventListener('click', () => {
    void (async () => {
      if (!window.confirm('Abort this attempt? Elapsed time will be saved as aborted.')) return;
      const store = await load();
      if (!store.activeAttemptId) return;
      const id = store.activeAttemptId;
      abortAttempt(store, id, Date.now());
      await save(store);
      notifyBackground('clear-timeout', id);
      lastSummaryAttemptId = id;
      await render();
    })();
  });

  $('btn-next').addEventListener('click', () => {
    void (async () => {
      lastSummaryAttemptId = null;
      await render();
    })();
  });

  $('btn-mark-aborted').addEventListener('click', () => {
    void (async () => {
      const store = await load();
      if (!store.activeAttemptId) return;
      const id = store.activeAttemptId;
      markInterruptedAborted(store, id, Date.now());
      await save(store);
      notifyBackground('clear-timeout', id);
      lastSummaryAttemptId = id;
      await render();
    })();
  });

  $('btn-abandon').addEventListener('click', () => {
    void (async () => {
      if (!window.confirm('Abandon this session? Completed attempts are kept; no new attempts can be added.')) return;
      const store = await load();
      const sid = store.activeSessionId;
      if (!sid) return;
      const session = store.sessions[sid];
      if (session) {
        session.status = 'abandoned';
        session.completed_at = new Date().toISOString();
      }
      store.activeSessionId = null;
      await save(store);
      lastDoneSessionId = sid;
      await render();
    })();
  });

  $('btn-export-session').addEventListener('click', () => {
    void (async () => {
      if (lastDoneSessionId) await exportSessionCsv(lastDoneSessionId);
    })();
  });
  $('btn-export-all').addEventListener('click', () => void exportAllCsv());
  $('btn-export-json').addEventListener('click', () => {
    void (async () => {
      const store = await load();
      const backup = buildBackup(store, Date.now());
      downloadFile(backupFilename(backup.exportedAt), serializeBackup(backup), 'application/json;charset=utf-8');
    })();
  });
  $('btn-import-done').addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dataset.html') + '#import' });
  });
  $('btn-new-session').addEventListener('click', () => {
    lastDoneSessionId = null;
    lastSummaryAttemptId = null;
    void render();
  });

  const openDataset = (): void => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dataset.html') });
  };
  for (const id of ['btn-dataset-setup', 'btn-dataset-ready', 'btn-dataset-done']) {
    const el = document.getElementById(id);
    el?.addEventListener('click', openDataset);
  }
  const openSidePanel = (): void => {
    void (async () => {
      try {
        const win = await chrome.windows.getCurrent();
        if (win.id !== undefined) await chrome.sidePanel.open({ windowId: win.id });
      } catch {
        window.alert('Side panel is not available in this Chrome version (requires Chrome 114+).');
      }
    })();
  };
  for (const id of ['btn-sidepanel-setup', 'btn-sidepanel-ready']) {
    document.getElementById(id)?.addEventListener('click', openSidePanel);
  }
  $('btn-open-tab-setup')?.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  });

  // Keyboard accessibility: Enter on participant input starts session.
  ($('input-participant') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') ($('btn-start-session') as HTMLButtonElement).click();
  });
}

wireButtons();
wireIntegrityListeners();
void render();
tickHandle = window.setInterval(() => void render(), 250);
void tickHandle;
