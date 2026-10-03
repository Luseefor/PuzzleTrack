import { emptyStore, type Attempt, type IntegrityEvent, type PuzzleTrackStore, type Session } from '../models/types.js';
import { deriveIntegrity } from '../integrity/focusTracker.js';
import { migrateStore } from './migration.js';
import type { StorageAdapter } from './storageAdapter.js';
import { withStorageLock } from './storageAdapter.js';

/**
 * Repository: typed load/save over a StorageAdapter + append-only guards.
 * - Completed attempts are immutable: updateAttempt refuses to mutate finished records.
 * - Events are append-only.
 * - Active session/attempt pointers survive reload (crash recovery).
 */
export class Repository {
  constructor(private readonly adapter: StorageAdapter) {}

  async loadStore(): Promise<PuzzleTrackStore> {
    const raw = await this.adapter.load();
    if (!raw) return emptyStore();
    try {
      const parsed = JSON.parse(raw) as PuzzleTrackStore;
      // Explicit migration: v1 blobs (no schemaVersion) upgrade safely in place.
      return migrateStore({ ...emptyStore(), ...parsed });
    } catch (e) {
      if (e instanceof SyntaxError) {
        // Never silently delete research data: surface corruption instead of resetting.
        throw new Error('PuzzleTrack local store is corrupted and could not be parsed. Export/backup before clearing.');
      }
      throw e;
    }
  }

  async saveStore(store: PuzzleTrackStore): Promise<void> {
    await withStorageLock(this.adapter, () => this.adapter.save(JSON.stringify(store)));
  }

  /**
   * Merge-save: reload the latest persisted state, union it with the writer's
   * in-memory copy, and persist the converged result.
   *
   * Why this exists: the popup/side-panel tick loop saves every 250 ms during
   * an active attempt while the background service worker concurrently appends
   * focus events. A plain last-write-wins save drops whichever write landed
   * first. Merge rules (deterministic, tested):
   * - events: union by event_id across both copies, sorted by timestamp.
   *   Events are append-only with unique ids, so union is lossless.
   * - attempts: finished records win over in-progress ones (a finish is
   *   authoritative and never resurrected); otherwise field-merge with the
   *   writer's copy winning, except: the `possibly_interrupted` latch (OR),
   *   chess/provenance fields where a stale null never erases a fresh value,
   *   and derived integrity fields, which are RECOMPUTED from the merged event
   *   log so all writers converge to identical values.
   * - sessions/participants/imports/importRows/matches/pilotReview: per-key
   *   union, writer's copy winning on key conflicts.
   * - activeSessionId/activeAttemptId: writer's copy wins, then dangling
   *   pointers (missing/finished targets) are cleared, never resurrected.
   * - lastHeartbeatMs: max (monotonic). bridgeStatus: newest updatedAt wins.
   *
   * Use saveMerged for concurrent event/derived mutation paths (UI tick, focus
   * handlers, match application). Keep plain saveStore for intentional
   * replace/remove operations (delete session, backup restore).
   */
  async saveMerged(base: PuzzleTrackStore, nowMs: number = Date.now()): Promise<PuzzleTrackStore> {
    return withStorageLock(this.adapter, async () => {
      const fresh = await this.loadStore();
      const merged = mergeStores(base, fresh, nowMs);
      await this.adapter.save(JSON.stringify(merged));
      return merged;
    });
  }

  async clearAll(): Promise<void> {
    await withStorageLock(this.adapter, () => this.adapter.clear());
  }

  /** Worker mutations run against current state under the same cross-context lock. */
  async transact<T>(operation: (store: PuzzleTrackStore) => T | Promise<T>): Promise<T> {
    return withStorageLock(this.adapter, async () => {
      const store = await this.loadStore();
      const result = await operation(store);
      await this.adapter.save(JSON.stringify(store));
      return result;
    });
  }

  // --- guarded mutations ---

  static putSession(store: PuzzleTrackStore, session: Session): void {
    store.sessions[session.session_id] = session;
  }

  static putAttempt(store: PuzzleTrackStore, attempt: Attempt): void {
    const existing = store.attempts[attempt.attempt_id];
    if (existing && existing.ended_at !== null) {
      throw new Error('Completed attempt records are immutable and cannot be modified.');
    }
    store.attempts[attempt.attempt_id] = attempt;
  }

  static appendEvent(store: PuzzleTrackStore, event: IntegrityEvent): void {
    const list = store.events[event.attempt_id] ?? [];
    list.push(event);
    store.events[event.attempt_id] = list;
  }

  static attemptsForSession(store: PuzzleTrackStore, sessionId: string): Attempt[] {
    return Object.values(store.attempts)
      .filter((a) => a.session_id === sessionId)
      .sort((a, b) => a.attempt_number - b.attempt_number);
  }

  static eventsForAttempt(store: PuzzleTrackStore, attemptId: string): IntegrityEvent[] {
    return [...(store.events[attemptId] ?? [])].sort(
      (a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
    );
  }
}

/** Union two event lists by event_id, sorted by timestamp. Lossless: ids are unique. */
function unionEvents(a: IntegrityEvent[], b: IntegrityEvent[]): IntegrityEvent[] {
  const byId = new Map<string, IntegrityEvent>();
  for (const e of [...a, ...b]) {
    if (!byId.has(e.event_id)) byId.set(e.event_id, e);
  }
  return [...byId.values()].sort((x, y) => Date.parse(x.timestamp) - Date.parse(y.timestamp));
}

function unionEventMaps(
  base: PuzzleTrackStore['events'],
  fresh: PuzzleTrackStore['events'],
): PuzzleTrackStore['events'] {
  const out: PuzzleTrackStore['events'] = {};
  for (const key of new Set([...Object.keys(base), ...Object.keys(fresh)])) {
    out[key] = unionEvents(base[key] ?? [], fresh[key] ?? []);
  }
  return out;
}

/** Per-key union of plain record maps; `base` wins on key conflicts. */
function unionMaps<T>(base: Record<string, T>, fresh: Record<string, T>): Record<string, T> {
  return { ...fresh, ...base };
}

/** Chess + provenance fields authored by match/manual flows (never by the UI tick). */
const CHESS_AUTHORABLE_FIELDS = [
  'problem_id',
  'problem_rating',
  'player_rating_before',
  'player_rating_after',
  'chesstempo_result',
  'moves_used',
  'average_moves',
  'rating_change',
  'difficulty_label',
  'manual_problem_id',
  'chesstempo_attempted_at',
  'chesstempo_time_used_seconds',
  'step_durations_ms',
  'chesstempo_import_id',
  'chesstempo_source_row',
  'match_confidence',
] as const;

type ChessAuthorableField = (typeof CHESS_AUTHORABLE_FIELDS)[number];

function mergeInProgressAttempt(b: Attempt, f: Attempt): Attempt {
  const winner: Attempt = { ...f, ...b };
  preserveAuthoredFields(winner, f);
  winner.possibly_interrupted = b.possibly_interrupted || f.possibly_interrupted;
  return winner;
}

/**
 * Provenance-aware field preservation applied to BOTH merge paths.
 * - Chess/manual/match fields: a stale null never erases a fresh value
 *   (intentional nulling happens only via unmatch + plain saveStore).
 * - capture_origin / cross_validation: stickiest informative value wins.
 * - requires_review: latch, like possibly_interrupted.
 */
function preserveAuthoredFields(winner: Attempt, other: Attempt): void {
  for (const field of CHESS_AUTHORABLE_FIELDS) {
    const key = field as ChessAuthorableField;
    if ((winner[key] as unknown) === null && (other[key] as unknown) !== null) {
      (winner[key] as unknown) = other[key] as unknown;
    }
  }
  const steps = new Map<number, NonNullable<Attempt['step_durations_ms']>[number]>();
  for (const s of [...(other.step_durations_ms ?? []), ...(winner.step_durations_ms ?? [])]) {
    const previous = steps.get(s.step_number);
    if (!previous || (previous.duration_ms === null && s.duration_ms !== null)) {
      steps.set(s.step_number, s);
    } else if (previous.duration_ms !== null && s.duration_ms !== null && previous.duration_ms !== s.duration_ms) {
      winner.requires_review = true;
    }
  }
  winner.step_durations_ms = steps.size > 0 ? [...steps.values()].sort((a, b) => a.step_number - b.step_number) : null;
  const originRank = (v: Attempt['capture_origin']): number =>
    v === 'live+history' ? 4 : v === 'live' ? 3 : v === 'history' ? 2 : v === 'manual' ? 1 : 0;
  if (originRank(other.capture_origin) > originRank(winner.capture_origin)) {
    winner.capture_origin = other.capture_origin;
  }
  const validationRank = (v: Attempt['cross_validation']): number =>
    v === 'conflict' ? 2 : v === 'confirmed' ? 1 : 0;
  if (validationRank(other.cross_validation) > validationRank(winner.cross_validation)) {
    winner.cross_validation = other.cross_validation;
  }
  winner.requires_review = winner.requires_review || other.requires_review;
}

/**
 * Pure deterministic merge of two store copies (see saveMerged for the rules).
 * Exported for unit testing the concurrency behavior without adapters.
 */
export function mergeStores(base: PuzzleTrackStore, fresh: PuzzleTrackStore, nowMs: number): PuzzleTrackStore {
  const events = unionEventMaps(base.events, fresh.events);

  const attempts: Record<string, Attempt> = {};
  for (const id of new Set([...Object.keys(base.attempts), ...Object.keys(fresh.attempts)])) {
    const b = base.attempts[id];
    const f = fresh.attempts[id];
    if (!b) {
      if (f) attempts[id] = { ...f };
      continue;
    }
    if (!f) {
      attempts[id] = { ...b };
      continue;
    }
    // Finished records are authoritative: never resurrect in-progress state,
    // but preserve authored fields, latches, and provenance from either side.
    if (b.ended_at !== null || f.ended_at !== null) {
      const finishedFirst = f.ended_at !== null ? f : b;
      const other = finishedFirst === f ? b : f;
      const winner: Attempt = { ...other, ...finishedFirst };
      preserveAuthoredFields(winner, other);
      winner.possibly_interrupted = b.possibly_interrupted || f.possibly_interrupted;
      attempts[id] = winner;
    } else {
      attempts[id] = mergeInProgressAttempt(b, f);
    }
  }

  const sessions = unionMaps(base.sessions, fresh.sessions);
  for (const [id, session] of Object.entries(fresh.sessions)) {
    if (session.status !== 'active' && sessions[id]?.status === 'active') sessions[id] = { ...session };
  }
  const liveObservations = { ...fresh.liveObservations };
  for (const [id, obs] of Object.entries(base.liveObservations)) {
    if (!liveObservations[id] || obs.observedAt >= liveObservations[id].observedAt) liveObservations[id] = { ...obs };
  }
  const merged: PuzzleTrackStore = {
    schemaVersion: base.schemaVersion,
    participants: unionMaps(base.participants, fresh.participants),
    sessions,
    attempts,
    events,
    activeSessionId: base.activeSessionId,
    activeAttemptId: base.activeAttemptId,
    lastHeartbeatMs: Math.max(base.lastHeartbeatMs ?? -1, fresh.lastHeartbeatMs ?? -1),
    imports: unionMaps(base.imports, fresh.imports),
    importRows: unionMaps(base.importRows, fresh.importRows),
    matches: unionMaps(base.matches, fresh.matches),
    pilotReview: unionMaps(base.pilotReview, fresh.pilotReview),
    liveObservations,
    // Bridge status is recency-wins: the UI tick never authors it, so its
    // stale copy must not overwrite a fresher background update.
    bridgeStatus: (base.bridgeStatus.updatedAt ?? '') >= (fresh.bridgeStatus.updatedAt ?? '')
      ? { ...base.bridgeStatus }
      : { ...fresh.bridgeStatus },
    localPools: { ...fresh.localPools, ...base.localPools },
    researchEvents: Object.fromEntries([...new Set([...Object.keys(base.researchEvents ?? {}), ...Object.keys(fresh.researchEvents ?? {})])].map(id => [id, [...new Map([...(fresh.researchEvents?.[id] ?? []), ...(base.researchEvents?.[id] ?? [])].map(e => [e.event_id, e])).values()].sort((a, b) => a.recorded_at.localeCompare(b.recorded_at))])),
    bridgeReceipts: { ...fresh.bridgeReceipts, ...base.bridgeReceipts },
  };
  if (merged.lastHeartbeatMs === -1) merged.lastHeartbeatMs = null;

  // Recompute derived integrity for in-progress attempts from the merged log
  // so every writer converges to identical values.
  for (const attempt of Object.values(merged.attempts)) {
    const session = merged.sessions[attempt.session_id];
    const endMs = attempt.ended_at === null ? nowMs : Date.parse(attempt.ended_at);
    const eventsInTrial = (merged.events[attempt.attempt_id] ?? []).filter(e => Date.parse(e.timestamp) <= endMs);
    const d = deriveIntegrity(eventsInTrial, endMs, session?.study_tab_id != null);
    attempt.focus_loss_count = d.focus_loss_count;
    attempt.total_time_away_ms = d.total_time_away_ms;
    attempt.integrity_flag = d.integrity_flag;
  }

  // Reconcile dangling active pointers (clear, never resurrect).
  const activeAttempt = merged.activeAttemptId ? merged.attempts[merged.activeAttemptId] : undefined;
  if (merged.activeAttemptId && (!activeAttempt || activeAttempt.ended_at !== null)) {
    merged.activeAttemptId = null;
  }
  if (merged.activeSessionId && merged.sessions[merged.activeSessionId]?.status !== 'active') {
    merged.activeSessionId = null;
  }
  // A stale idle UI must not clear an attempt/session created by the worker.
  merged.activeAttemptId ??= Object.values(attempts).find(a => a.ended_at === null)?.attempt_id ?? null;
  merged.activeSessionId ??= Object.values(sessions).find(s => s.status === 'active')?.session_id ?? null;
  return merged;
}
