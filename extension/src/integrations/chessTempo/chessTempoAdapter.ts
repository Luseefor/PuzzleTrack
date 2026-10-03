/**
 * ChessTempo site adapter (v0.3). The ONLY module allowed to interpret page
 * state. All DOM knowledge enters through an injected `readPage` function;
 * the state machine itself is a pure reducer over semantic readings and is
 * fully unit-tested without any live page.
 *
 * Duplicate protection:
 * - A problem is reported (`problem_loaded`) exactly once per stable new id.
 * - Stability requires the same id across consecutive readings (sightings) or
 *   a dwell time — rerenders of the SAME id never re-emit.
 * - A result is reported exactly once per problem (RESULT_DETECTED latches).
 * - Rapid next-problem transitions are caught via the RESULT_DETECTED fast path.
 */
import type {
  AdapterDiagnostics,
  AdapterState,
  PageReading,
  SiteEvent,
  SiteParticipantContext,
  SiteProblem,
} from './chessTempoTypes.js';
import type { StudySiteAdapter } from '../siteAdapter.js';

/** Consecutive same-id readings required to confirm stability. */
export const STABLE_SIGHTINGS = 3;
/** Dwell time (ms) that alternatively confirms stability. */
export const STABLE_MS = 1500;
/** Missed readings before a tracked problem is dropped back to NO_PROBLEM. */
export const MISS_THRESHOLD = 5;

export interface AdapterMachine {
  state: AdapterState;
  currentId: string | null;
  candidateId: string | null;
  candidateSinceMs: number;
  sightings: number;
  misses: number;
  /** New-problem id already reported via problem_changed (duplicate suppression). */
  reportedChangeFor: string | null;
  activeStepNumber: number | null;
  activeStepStartedAtMs: number | null;
}

export function initialMachine(): AdapterMachine {
  return { state: 'NO_PROBLEM', currentId: null, candidateId: null, candidateSinceMs: 0, sightings: 0, misses: 0, reportedChangeFor: null, activeStepNumber: null, activeStepStartedAtMs: null };
}

function toSiteProblem(r: PageReading, problemId: string): SiteProblem {
  return { problemId, problemRating: r.problemRating, difficultyLabel: r.difficultyLabel, mode: r.mode };
}

function completedEvent(
  atMs: number,
  reading: PageReading,
  currentId: string | null,
): SiteEvent {
  const result: SiteEvent['result'] = {
    problemId: currentId as string,
    result: reading.result as NonNullable<PageReading['result']>,
    timeUsedSeconds: reading.timeUsedSeconds,
    movesUsed: reading.movesUsed,
    averageMoves: null,
    playerRatingAfter: reading.playerRatingAfter,
    ratingChange: reading.ratingChange,
  };
  if (currentId === null) return { kind: 'problem_completed', atMs, result };
  return { kind: 'problem_completed', atMs, problem: toSiteProblem(reading, currentId), result };
}

function stable(m: AdapterMachine, nowMs: number): boolean {
  return m.sightings >= STABLE_SIGHTINGS || (m.sightings > 0 && nowMs - m.candidateSinceMs >= STABLE_MS);
}

function trackCandidate(m: AdapterMachine, id: string | null, nowMs: number): AdapterMachine {
  const next: AdapterMachine = { ...m, misses: 0 };
  if (id === null) {
    next.misses = m.misses + 1;
    return next;
  }
  if (id === m.currentId) {
    next.candidateId = id;
    next.sightings = Math.max(m.sightings, STABLE_SIGHTINGS);
    return next;
  }
  if (id === m.candidateId) {
    next.sightings = m.sightings + 1;
    return next;
  }
  next.candidateId = id;
  next.candidateSinceMs = nowMs;
  next.sightings = 1;
  return next;
}

/**
 * Pure reducer: fold one page reading into machine state, yielding semantic
 * events. Deterministic; invalid readings never produce guessed events.
 */
export function stepMachine(
  machine: AdapterMachine,
  reading: PageReading,
  nowMs: number,
): { machine: AdapterMachine; events: SiteEvent[] } {
  let m: AdapterMachine = { ...machine };
  const events: SiteEvent[] = [];

  // Not (or no longer) a training page.
  if (!reading.trainingPage) {
    if (m.state !== 'NO_PROBLEM' && m.state !== 'ADAPTER_ERROR') {
      m = { ...initialMachine(), state: 'ADAPTER_ERROR' };
      events.push({ kind: 'adapter_lost', atMs: nowMs, reason: 'page no longer looks like training' });
    } else if (m.state === 'NO_PROBLEM') {
      m = initialMachine();
    }
    return { machine: m, events };
  }

  // Recovery path out of ADAPTER_ERROR.
  if (m.state === 'ADAPTER_ERROR') {
    m = initialMachine();
    events.push({ kind: 'adapter_recovered', atMs: nowMs });
  }

  m = trackCandidate(m, reading.problemId, nowMs);

  if (
    m.state === 'ATTEMPT_ACTIVE' && m.currentId !== null && reading.problemId === m.currentId &&
    reading.stepNumber !== null && m.activeStepNumber === null
  ) {
    m = { ...m, activeStepNumber: reading.stepNumber, activeStepStartedAtMs: nowMs };
  }

  // Measure only visible step-counter transitions. The counter text and chess
  // moves are never retained. A skipped counter produces null timings.
  if (
    m.state === 'ATTEMPT_ACTIVE' && m.currentId !== null && reading.problemId === m.currentId &&
    reading.stepNumber !== null && m.activeStepNumber !== null && m.activeStepStartedAtMs !== null &&
    reading.stepNumber > m.activeStepNumber
  ) {
    const sequential = reading.stepNumber === m.activeStepNumber + 1;
    for (let n = m.activeStepNumber; n < reading.stepNumber; n++) {
      events.push({
        kind: 'step_completed',
        atMs: nowMs,
        problemId: m.currentId,
        stepNumber: n,
        durationMs: sequential && n === m.activeStepNumber ? Math.max(0, nowMs - m.activeStepStartedAtMs) : null,
      });
    }
    m = { ...m, activeStepNumber: reading.stepNumber, activeStepStartedAtMs: nowMs };
  }

  const stepAdvancedThisReading =
    machine.state === 'ATTEMPT_ACTIVE' && machine.activeStepNumber !== null &&
    reading.stepNumber !== null && reading.stepNumber > machine.activeStepNumber;
  if (
    !stepAdvancedThisReading && m.state === 'ATTEMPT_ACTIVE' && m.activeStepNumber !== null &&
    m.activeStepStartedAtMs !== null && reading.problemId === m.currentId && reading.result !== null
  ) {
    events.push({
      kind: 'step_completed',
      atMs: nowMs,
      problemId: m.currentId as string,
      stepNumber: m.activeStepNumber,
      durationMs: Math.max(0, nowMs - m.activeStepStartedAtMs),
    });
    m = { ...m, activeStepNumber: null, activeStepStartedAtMs: null };
  }

  // Tracked problem vanished repeatedly → drop silently (attempt timing
  // continues on PuzzleTrack timestamps; no event noise).
  if (reading.problemId === null && m.misses >= MISS_THRESHOLD && m.state !== 'NO_PROBLEM') {
    const reset = initialMachine();
    return { machine: reset, events };
  }

  const stableNewId =
    m.candidateId !== null && m.candidateId !== m.currentId && stable(m, nowMs) ? (m.candidateId as string) : null;

  const hasResult = reading.result !== null && reading.problemId !== null && reading.problemId === m.currentId;

  switch (m.state) {
    case 'NO_PROBLEM': {
      if (stableNewId !== null) {
        const alreadyCompleted = reading.result !== null && reading.problemId === stableNewId;
        m = {
          ...m,
          state: alreadyCompleted ? 'RESULT_DETECTED' : 'PROBLEM_READY',
          currentId: stableNewId,
        };
        if (alreadyCompleted) {
          events.push(completedEvent(nowMs, reading, stableNewId));
        } else {
          events.push({
            kind: 'problem_loaded',
            atMs: nowMs,
            problem: toSiteProblem(reading, stableNewId),
            context: { displayedRating: reading.displayedRating },
          });
        }
      }
      break;
    }
    case 'PROBLEM_READY': {
      if (stableNewId !== null) {
        // New stable id without an attempt (manual mode / no session): report
        // the transition; the controller decides whether to act.
        const previous = m.currentId;
        m = { ...m, state: 'PROBLEM_READY', currentId: stableNewId };
        const ev: SiteEvent = {
          kind: 'problem_loaded',
          atMs: nowMs,
          problem: toSiteProblem(reading, stableNewId),
          context: { displayedRating: reading.displayedRating },
        };
        if (previous !== null) ev.previousProblemId = previous;
        events.push(ev);
      } else if (hasResult) {
        m = { ...m, state: 'RESULT_DETECTED' };
        events.push(completedEvent(nowMs, reading, m.currentId));
      }
      break;
    }
    case 'ATTEMPT_ACTIVE': {
      if (hasResult) {
        m = { ...m, state: 'RESULT_DETECTED' };
        events.push(completedEvent(nowMs, reading, m.currentId));
      } else if (stableNewId !== null) {
        // Stable DIFFERENT problem while our attempt is active: informational
        // only — the controller flags the attempt for review, never guesses.
        // Reported once per new id; rerenders stay silent.
        if (m.reportedChangeFor !== stableNewId) {
          const ev: SiteEvent = {
            kind: 'problem_changed',
            atMs: nowMs,
            problem: toSiteProblem(reading, stableNewId),
            context: { displayedRating: reading.displayedRating },
          };
          if (m.currentId !== null) ev.previousProblemId = m.currentId;
          events.push(ev);
          m = { ...m, reportedChangeFor: stableNewId };
        }
        m = { ...m, candidateId: m.currentId, sightings: STABLE_SIGHTINGS };
      }
      break;
    }
    case 'RESULT_DETECTED': {
      if (stableNewId !== null) {
        m = { ...m, state: 'PROBLEM_READY', currentId: stableNewId };
        events.push({
          kind: 'problem_loaded',
          atMs: nowMs,
          problem: toSiteProblem(reading, stableNewId),
          context: { displayedRating: reading.displayedRating },
        });
      } else if (!hasResult && reading.problemId === m.currentId) {
        // Result UI cleared but same problem shown → wait for a new problem.
        m = { ...m, state: 'WAITING_FOR_NEXT' };
      }
      // Duplicate result readings for the same problem: ignored.
      break;
    }
    case 'WAITING_FOR_NEXT': {
      if (stableNewId !== null) {
        m = { ...m, state: 'PROBLEM_READY', currentId: stableNewId };
        events.push({
          kind: 'problem_loaded',
          atMs: nowMs,
          problem: toSiteProblem(reading, stableNewId),
          context: { displayedRating: reading.displayedRating },
        });
      }
      break;
    }
    case 'ADAPTER_ERROR': {
      break;
    }
  }

  return { machine: m, events };
}

export interface AdapterOptions {
  readPage: () => PageReading;
  /** Wires DOM change notifications; returns an unsubscribe function. */
  observe: (onChange: () => void) => () => void;
  now?: () => number;
}

/**
 * Live adapter binding the pure machine to a page. Constructed ONLY inside
 * the flag-gated content script — never in core, popup, or background code.
 */
export class ChessTempoAdapter implements StudySiteAdapter {
  private machine: AdapterMachine = initialMachine();
  private listeners = new Set<(event: SiteEvent) => void>();
  private lastReading: PageReading | null = null;
  private disposeObserver: (() => void) | null = null;
  private stabilityTimer: ReturnType<typeof setTimeout> | null = null;
  private lastResultSignature: string | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: AdapterOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Start observing. Emits site_ready when the page qualifies. */
  start(): boolean {
    const reading = this.opts.readPage();
    this.lastReading = reading;
    if (!reading.trainingPage) return false;
    this.disposeObserver = this.opts.observe(() => this.tick());
    this.tick();
    this.emit({ kind: 'site_ready', atMs: this.now() });
    return true;
  }

  tick(): void {
    const reading = this.opts.readPage();
    this.lastReading = reading;
    const { machine, events } = stepMachine(this.machine, reading, this.now());
    this.machine = machine;
    for (const e of events) this.emit(e);
    if (this.stabilityTimer !== null) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = null;
    if (machine.candidateId !== null && machine.candidateId !== machine.currentId && machine.sightings > 0) {
      this.stabilityTimer = setTimeout(() => { this.stabilityTimer = null; this.tick(); }, Math.max(1, STABLE_MS - (this.now() - machine.candidateSinceMs)));
    }
    if (reading.result !== null && machine.currentId === reading.problemId && machine.state === 'RESULT_DETECTED') {
      const signature = JSON.stringify([reading.problemId, reading.result, reading.problemRating, reading.timeUsedSeconds, reading.movesUsed, reading.playerRatingAfter, reading.ratingChange]);
      if (signature !== this.lastResultSignature && !events.some(e => e.kind === 'problem_completed')) {
        this.emit({ ...completedEvent(this.now(), reading, machine.currentId), kind: 'result_updated' });
      }
      this.lastResultSignature = signature;
    } else this.lastResultSignature = null;
  }

  detectPage(): boolean {
    return this.opts.readPage().trainingPage;
  }

  getParticipantContext(): SiteParticipantContext | null {
    const r = this.lastReading;
    if (!r || !r.trainingPage) return null;
    return { displayedRating: r.displayedRating };
  }

  getCurrentProblem(): SiteProblem | null {
    const r = this.lastReading;
    if (!r || !r.trainingPage || this.machine.currentId === null) return null;
    return toSiteProblem(r, this.machine.currentId);
  }

  getDiagnostics(): AdapterDiagnostics {
    const r = this.lastReading;
    return {
      connected: true,
      state: this.machine.state,
      problemId: this.machine.currentId,
      problemRating: r?.problemRating ?? null,
      playerRating: r?.displayedRating ?? null,
      result: r?.result ?? null,
      stepNumber: r?.stepNumber ?? null,
      stepTotal: r?.stepTotal ?? null,
      foundFields: r?.foundFields ?? [],
      missingFields: r?.missingFields ?? [],
    };
  }

  notifyAttemptStarted(problemId: string): void {
    if (this.machine.state === 'PROBLEM_READY' && this.machine.currentId === problemId) {
      this.machine = {
        ...this.machine,
        state: 'ATTEMPT_ACTIVE',
        activeStepNumber: this.lastReading?.stepNumber ?? null,
        activeStepStartedAtMs: this.lastReading?.stepNumber === null || this.lastReading?.stepNumber === undefined ? null : this.now(),
      };
    }
  }

  notifyAttemptEnded(problemId: string): void {
    if (this.machine.currentId === problemId &&
        (this.machine.state === 'ATTEMPT_ACTIVE' || this.machine.state === 'RESULT_DETECTED')) {
      this.machine = { ...this.machine, state: this.machine.state === 'RESULT_DETECTED' ? 'RESULT_DETECTED' : 'PROBLEM_READY', activeStepNumber: null, activeStepStartedAtMs: null };
    }
  }

  subscribe(listener: (event: SiteEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.stabilityTimer !== null) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = null;
    if (this.disposeObserver) {
      this.disposeObserver();
      this.disposeObserver = null;
    }
    this.listeners.clear();
  }

  /** Replay a ready problem when a research session starts after connection. */
  replayReadyProblem(): boolean {
    const r = this.lastReading;
    if (this.machine.state !== 'PROBLEM_READY' || !r || r.result !== null || this.machine.currentId === null) return false;
    this.emit({ kind: 'problem_loaded', atMs: this.now(), problem: toSiteProblem(r, this.machine.currentId), context: { displayedRating: r.displayedRating } });
    return true;
  }

  private emit(event: SiteEvent): void {
    for (const l of [...this.listeners]) l(event);
  }
}
