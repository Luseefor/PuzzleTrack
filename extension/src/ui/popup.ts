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
import { CHESSTEMPO_LIVE_BRIDGE } from '../integrations/featureFlags.js';
import type { AdapterDiagnostics } from '../integrations/chessTempo/chessTempoTypes.js';
import type { Attempt, PuzzleTrackStore, Session } from '../models/types.js';
import { parseStudyPool, createStudyPlan } from '../research/studyPlan.js';
import { recordSearchChoice, summarizeSearch } from '../research/searchCapture.js';

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
  downloadCsv(downloadFilename(`session-${sessionId.slice(0, 8)}`, new Date().toISOString()), attemptsToCsv(participantMap(store), attempts, store));
}

async function exportAllCsv(): Promise<void> {
  const store = await load();
  downloadCsv(downloadFilename('full-dataset', new Date().toISOString()), attemptsToCsv(participantMap(store), Object.values(store.attempts), store));
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
  const ended = await repo.transact(current => {
    const live = current.attempts[ctx.attempt.attempt_id];
    if (!live || live.ended_at !== null) return false;
    timeoutAttempt(current, live.attempt_id, nowMs);
    return true;
  });
  if (!ended) return false;
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
  const localActive = !!activeSession?.study?.local_pool_sha256;
  $('local-session-note').hidden = !localActive;
  if (localActive) {
    for (const id of ['view-setup', 'view-ready', 'view-active', 'view-summary', 'view-done']) $(id).hidden = true;
    recoveryBanner.hidden = true;
    timeoutBanner.hidden = true;
    return;
  }

  if (ctx && ctx.attempt.ended_at === null) {
    // ---- ACTIVE ----
    const snap = recoverTimer(ctx.attempt.started_at, ctx.attempt.time_limit_seconds, nowMs);
    refreshAttemptIntegrity(s, ctx.attempt.attempt_id, nowMs);
    const converged = await save(s);
    const attempt = converged.attempts[ctx.attempt.attempt_id] as Attempt;

    show('view-active');
    $('research-capture').hidden = !ctx.session.study?.search_capture_enabled;
    const research = summarizeSearch(s.researchEvents?.[attempt.attempt_id] ?? []);
    $('research-capture-status').textContent = `${research.candidate_count} candidate(s) recorded${research.first_candidate ? ` · first: ${research.first_candidate}` : ''}`;
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
    if (CHESSTEMPO_LIVE_BRIDGE && ctx.session.auto_mode) {
      const b = converged.bridgeStatus;
      $('bridge-active').hidden = false;
      $('bridge-problem').textContent = b.problemId ? `#${b.problemId}` : (attempt.problem_id ? `#${attempt.problem_id}` : '–');
      $('bridge-prating').textContent = '–';
      if (b.problemRating !== null) $('bridge-prating').textContent = String(b.problemRating);
      else if (attempt.problem_rating !== null) $('bridge-prating').textContent = String(attempt.problem_rating);
      $('bridge-qrating').textContent = '–';
      if (b.playerRating !== null) $('bridge-qrating').textContent = String(b.playerRating);
      else if (attempt.player_rating_before !== null) $('bridge-qrating').textContent = String(attempt.player_rating_before);
      const steps = attempt.step_durations_ms ?? [];
      $('bridge-steps').textContent = steps.length === 0
        ? 'Waiting for step counter'
        : steps.map((step) => `${step.step_number}: ${step.duration_ms === null ? 'unavailable' : formatDurationMs(step.duration_ms)}`).join(' · ');
      $('bridge-lost').hidden = b.connected || !b.error;
      $('active-auto-note').hidden = false;
      $('btn-complete').hidden = false;
      $('btn-abort').hidden = false;
      $('active-hint').hidden = true;
    } else {
      $('bridge-active').hidden = true;
      $('bridge-lost').hidden = true;
      $('active-auto-note').hidden = true;
      $('btn-complete').hidden = false;
      $('btn-abort').hidden = false;
      $('active-hint').hidden = false;
    }
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
    if (CHESSTEMPO_LIVE_BRIDGE) {
      const conf: Record<string, number> = {};
      for (const a of attempts) {
        const m = s.matches[a.attempt_id];
        if (m) conf[m.confidence] = (conf[m.confidence] ?? 0) + 1;
      }
      const parts = ['exact', 'high', 'medium', 'low']
        .map((c) => `${c} ${conf[c] ?? 0}`)
        .join(' · ');
      $('done-breakdown').textContent = parts;
    }
    return;
  }

  if (activeSession && activeSession.status === 'active') {
    // ---- READY (between attempts) ----
    show('view-ready');
    const done = Repository.attemptsForSession(s, activeSession.session_id).filter((a) => a.ended_at !== null).length;
    $('ready-title').textContent = `Puzzle ${done + 1} of ${activeSession.target_attempts}`;
    const assigned = activeSession.study?.plan?.ordered_puzzles[done];
    $('ready-assignment').hidden = !assigned;
    $('ready-assignment').textContent = assigned ? `Assigned ${assigned.id} · rating ${assigned.rating} (${assigned.rating_source}). Verify the task before starting.` : '';
    $('ready-meta').textContent = `${formatDurationMs(activeSession.time_limit_seconds * 1000)} per puzzle · Participant ${activeSession.participant_id}`;
    $('ready-study').textContent =
      activeSession.study_tab_id != null ? `Study tab designated (tab #${activeSession.study_tab_id})` : 'Study tab: not designated';
    $('ready-study').hidden = activeSession.auto_mode;
    $('btn-designate-tab').hidden = activeSession.auto_mode || activeSession.study_tab_id !== null;
    $('manual-problem-field').hidden = activeSession.auto_mode;
    $('btn-start-attempt').hidden = activeSession.auto_mode;
    $('ready-auto-note').hidden = !activeSession.auto_mode;
    if (CHESSTEMPO_LIVE_BRIDGE) {
      $('bridge-ready').hidden = false;
      const b = s.bridgeStatus;
      const mode = activeSession.auto_mode ? 'auto' : 'manual';
      $('bridge-ready-label').textContent = b.connected ? 'ChessTempo connected' : 'ChessTempo disconnected';
      $('bridge-ready').classList.toggle('is-connected', b.connected);
      if (!b.connected) {
        $('bridge-ready-status').textContent = activeSession.auto_mode
          ? 'Connect this ChessTempo tab to begin.'
          : 'Connect only when you want to capture ChessTempo details.';
      } else if (activeSession.auto_mode && !b.problemId) {
        $('bridge-ready-status').textContent = 'Connected · waiting for a readable problem ID';
      } else {
        $('bridge-ready-status').textContent = `${mode === 'auto' ? 'Automatic capture' : 'Manual capture'}${b.problemId ? ` · Problem #${b.problemId}` : ''}`;
      }
      $('btn-connect-ready').hidden = false;
      $('btn-connect-ready').textContent = b.connected ? 'Reconnect' : 'Connect';
    }
    return;
  }

  // ---- SETUP ----
  show('view-setup');
  if (CHESSTEMPO_LIVE_BRIDGE) {
    // Dev-only short timeout for TEST01 timeout drills (never for participants).
    $('limit-dev-wrap').hidden = false;
    $('bridge-setup').hidden = false;
    const b = s.bridgeStatus;
    $('bridge-setup-status').textContent = b.connected
      ? b.problemId
        ? `Live bridge: connected to problem #${b.problemId}. Reconnect if this tab stopped updating.`
        : 'Live bridge: connected. Waiting for a readable problem ID; reconnect after opening a problem.'
      : b.error ?? 'Live bridge: not connected.';
    ($('btn-connect-bridge') as HTMLButtonElement).textContent = b.connected ? 'Reconnect ChessTempo tab' : 'Connect ChessTempo tab';
    void refreshDiagnostics(b.tabId);
  }
}

function findJustCompletedSession(store: PuzzleTrackStore): string | null {
  const completed = Object.values(store.sessions).filter((x) => x.status === 'completed');
  if (completed.length === 0) return null;
  completed.sort((a, b) => (a.completed_at ?? '') < (b.completed_at ?? '') ? 1 : -1);
  return completed[0]?.session_id ?? null;
}

let lastDiagMs = 0;

/**
 * Calibration diagnostics (idle setup view only, throttled). Values only —
 * never page text or DOM fragments. Disabled during sessions by construction:
 * this view renders only when no session is active.
 */
async function refreshDiagnostics(tabId: number | null): Promise<void> {
  const nowMs = Date.now();
  if (tabId === null || nowMs - lastDiagMs < 5000) return;
  lastDiagMs = nowMs;
  try {
    const res = (await chrome.runtime.sendMessage({ kind: 'pt-diagnostic-request', tabId })) as {
      ok: boolean;
      diagnostics?: AdapterDiagnostics;
    };
    if (!res.ok || !res.diagnostics) return;
    const d = res.diagnostics;
    $('bridge-diagnostics').hidden = false;
    $('diag-state').textContent = d.state;
    $('diag-problem').textContent = d.problemId ? `#${d.problemId}` : 'none';
    $('diag-found').textContent = d.foundFields.length > 0 ? d.foundFields.join(', ') : 'none';
    $('diag-missing').textContent = d.missingFields.length > 0 ? d.missingFields.join(', ') : 'none';
    $('diag-step').textContent = d.stepNumber === null
      ? 'not detected'
      : d.stepTotal === null ? String(d.stepNumber) : `${d.stepNumber} of ${d.stepTotal}`;
  } catch {
    /* background unreachable: diagnostics stay hidden */
  }
}

async function connectCurrentTab(): Promise<boolean> {
  try {
    // Ask only when the researcher explicitly connects a ChessTempo tab. This
    // call must happen before any await so Chrome can associate it with the
    // user's click gesture.
    const granted = await chrome.permissions.request({ origins: ['https://chesstempo.com/*'] });
    if (!granted) {
      const status = document.getElementById('bridge-setup-status') ?? document.getElementById('bridge-ready-status');
      if (status) status.textContent = 'ChessTempo access was not granted. Manual mode still works.';
      return false;
    }
    // No "tabs" permission: only the numeric id is read (no URL/title).
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;
    if (tabId === undefined) {
      window.alert('Could not identify the current tab.');
      return false;
    }
    const res = (await chrome.runtime.sendMessage({ kind: 'pt-bridge-connect', tabId })) as {
      ok: boolean;
      error?: string;
    };
    if (!res.ok) {
      window.alert(res.error ?? 'Could not connect.');
      return false;
    }
    await render();
    return true;
  } catch (e) {
    window.alert(e instanceof Error ? e.message : 'Could not connect.');
    return false;
  }
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
  const capture = async (decision: boolean): Promise<void> => {
    try {
      let attemptId = '';
      const atMs = Date.now();
      await repo.transact(store => {
        const id = store.activeAttemptId;
        if (!id) throw new Error('No active attempt.');
        attemptId = id;
        const move = ($(decision ? 'input-final-choice' : 'input-candidate') as HTMLInputElement).value;
        const reason = ($('input-stop-reason') as HTMLSelectElement).value as 'satisfied' | 'time_pressure' | 'exhausted_options' | 'other';
        recordSearchChoice(store, id, decision ? 'decision' : 'candidate', move, reason, atMs);
        if (decision) completeAttempt(store, id, atMs);
      });
      if (decision) {
        notifyBackground('clear-timeout', attemptId);
        lastSummaryAttemptId = attemptId;
      } else ($('input-candidate') as HTMLInputElement).value = '';
      await render();
    } catch (e) { window.alert(e instanceof Error ? e.message : 'Could not record search decision.'); }
  };
  $('btn-record-candidate').addEventListener('click', () => void capture(false));
  $('btn-record-decision').addEventListener('click', () => void capture(true));
  $('btn-start-session').addEventListener('click', () => {
    void (async () => {
      setError('');
      try {
        const pid = ($('input-participant') as HTMLInputElement).value;
        const count = Number(($('input-count') as HTMLInputElement).value);
        const checked = document.querySelector('input[name="limit"]:checked') as HTMLInputElement | null;
        const limit = Number(checked?.value ?? '900');
        const autoMode =
          CHESSTEMPO_LIVE_BRIDGE && ($('input-automation') as HTMLSelectElement).value === 'auto';
        const value = (id: string): string => ($(id) as HTMLInputElement).value.trim();
        const protocol = value('input-protocol'), source = value('input-task-source');
        if (!protocol || !source) throw new Error('Enter the protocol revision and task source.');
        const skillRaw = value('input-skill-rating'), skillSource = value('input-skill-source');
        const skill = skillRaw === '' ? null : Number(skillRaw);
        if (skill !== null && (!Number.isFinite(skill) || skill < 0 || !skillSource)) throw new Error('Skill rating needs a valid value and source / scale.');
        const poolFile = ($('input-study-pool') as HTMLInputElement).files?.[0];
        if (poolFile && poolFile.size > 4_000_000) throw new Error('Use a reviewed pool under 4 MB.');
        if (poolFile && autoMode) throw new Error('A planned pool cannot be enforced by ChessTempo Auto mode. Use manual collection with an authorized puzzle source.');
        const plan = poolFile ? await createStudyPlan(parseStudyPool(await poolFile.text()), value('input-study-seed'), Number(value('input-count-min')), Number(value('input-count-max'))) : null;
        await repo.transact(store => {
        if (autoMode && !store.bridgeStatus.connected) throw new Error('Connect this ChessTempo tab before starting Auto mode.');
        const session = createSession(store, pid, plan?.ordered_puzzles.length ?? count, limit, Date.now(), autoMode);
        session.protocol_id = protocol;
        session.study = { protocol_id: protocol, task_source: source, skill_rating: skill, skill_rating_source: skill === null ? null : skillSource, skill_recorded_at: skill === null ? null : new Date().toISOString(), search_capture_enabled: ($('input-search-capture') as HTMLInputElement).checked, plan };
        if (autoMode) session.study_tab_id = store.bridgeStatus.tabId;
        });
        lastSummaryAttemptId = null;
        lastDoneSessionId = null;
        if (autoMode) await chrome.runtime.sendMessage({ kind: 'pt-session-started' });
        await render();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not start session.');
      }
    })();
  });

  if (CHESSTEMPO_LIVE_BRIDGE) {
    $('btn-connect-bridge').addEventListener('click', () => {
      void connectCurrentTab();
    });
    $('btn-connect-ready').addEventListener('click', () => {
      void connectCurrentTab();
    });
    $('btn-reconnect').addEventListener('click', () => {
      void connectCurrentTab();
    });
    $('btn-manual-fallback').addEventListener('click', () => {
      void (async () => {
        const store = await load();
        const sid = store.activeSessionId;
        if (!sid) return;
        const session = store.sessions[sid];
        if (!session) return;
        // Safe fallback: automation off, active attempt untouched, timer untouched.
        session.auto_mode = false;
        await save(store);
        try {
          await chrome.runtime.sendMessage({ kind: 'pt-bridge-disconnect', reason: 'Switched to manual.' });
        } catch {
          /* background unreachable */
        }
        await render();
      })();
    });
  }

  $('btn-start-attempt').addEventListener('click', () => {
    void (async () => {
      const nowMs = Date.now();
      const attempt = await repo.transact(store => {
      if (!store.activeSessionId) return null;
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
      return attempt;
      });
      if (!attempt) return;
      for (const field of ['input-problem-id', 'input-candidate', 'input-final-choice']) {
        const input = document.getElementById(field) as HTMLInputElement | null;
        if (input) input.value = '';
      }
      ($('input-stop-reason') as HTMLSelectElement).value = '';
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
        await repo.transact(store => setManualProblemId(store, lastSummaryAttemptId!, value, Date.now()));
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
        await repo.transact(store => { if (store.activeSessionId) designateStudyTab(store, store.activeSessionId, tabId); });
        await render();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : 'Could not designate study tab.');
      }
    })();
  });

  $('btn-complete').addEventListener('click', () => {
    void (async () => {
      const atMs = Date.now();
      const id = await repo.transact(store => {
        if (!store.activeAttemptId) return null;
        const id = store.activeAttemptId;
        completeAttempt(store, id, atMs);
        return id;
      });
      if (!id) return;
      notifyBackground('clear-timeout', id);
      lastSummaryAttemptId = id;
      await render();
    })();
  });

  $('btn-abort').addEventListener('click', () => {
    void (async () => {
      if (!window.confirm('Abort this attempt? Elapsed time will be saved as aborted.')) return;
      const atMs = Date.now();
      const id = await repo.transact(store => {
        if (!store.activeAttemptId) return null;
        const id = store.activeAttemptId;
        abortAttempt(store, id, atMs);
        return id;
      });
      if (!id) return;
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

  $('btn-local-trainer').addEventListener('click', () => { void chrome.tabs.create({url: chrome.runtime.getURL('trainer.html')}); });
  const openDataset = (): void => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('dataset.html') });
  };
  for (const id of ['btn-dataset-setup', 'btn-dataset-ready', 'btn-dataset-done']) {
    const el = document.getElementById(id);
    el?.addEventListener('click', openDataset);
  }
  const openSidePanel = (): void => {
    if (!chrome.sidePanel) {
      window.alert('Side panel requires Chrome 114 or newer.');
      return;
    }
    // Keep the API call directly inside the click gesture; Chrome requires
    // recent user activation when opening a side panel programmatically.
    void chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT }).catch((e: unknown) => {
      window.alert(e instanceof Error ? `Could not open the side panel: ${e.message}` : 'Could not open the side panel.');
    });
  };
  for (const id of ['btn-sidepanel-setup', 'btn-sidepanel-ready']) {
    document.getElementById(id)?.addEventListener('click', openSidePanel);
  }
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
