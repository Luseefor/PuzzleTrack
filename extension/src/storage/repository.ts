import { emptyStore, type Attempt, type IntegrityEvent, type PuzzleTrackStore, type Session } from '../models/types.js';
import { deriveIntegrity } from '../integrity/focusTracker.js';
import { migrateStore } from './migration.js';
import type { StorageAdapter } from './storageAdapter.js';

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
    await this.adapter.save(JSON.stringify(store));
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
   * - lastHeartbeatMs: max (monotonic).
   *
   * Use saveMerged for concurrent event/derived mutation paths (UI tick, focus
   * handlers, match application). Keep plain saveStore for intentional
   * replace/remove operations (delete session, backup restore).
   */
  async saveMerged(base: PuzzleTrackStore, nowMs: number = Date.now()): Promise<PuzzleTrackStore> {
    const fresh = await this.loadStore();
    const merged = mergeStores(base, fresh, nowMs);
    await this.saveStore(merged);
    return merged;
  }

  async clearAll(): Promise<void> {
    await this.adapter.clear();
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
  'chesstempo_import_id',
  'chesstempo_source_row',
  'match_confidence',
] as const;

type ChessAuthorableField = (typeof CHESS_AUTHORABLE_FIELDS)[number];

function mergeInProgressAttempt(b: Attempt, f: Attempt): Attempt {
  const winner: Attempt = { ...f, ...b };
  // A stale writer's nulls must not erase freshly matched/annotated values:
  // the tick loop never authors these fields, so null on one side + value on
  // the other always resolves to the value. (Intentional nulling only happens
  // via unmatch, which uses plain saveStore, never the merge path.)
  for (const field of CHESS_AUTHORABLE_FIELDS) {
    const key = field as ChessAuthorableField;
    if ((winner[key] as unknown) === null && (f[key] as unknown) !== null) {
      (winner[key] as unknown) = f[key] as unknown;
    }
  }
  winner.possibly_interrupted = b.possibly_interrupted || f.possibly_interrupted;
  return winner;
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
    // but preserve the interruption latch from either side.
    if (b.ended_at !== null || f.ended_at !== null) {
      const winner: Attempt = b.ended_at !== null ? { ...f, ...b } : { ...b, ...f };
      winner.possibly_interrupted = b.possibly_interrupted || f.possibly_interrupted;
      attempts[id] = winner;
    } else {
      attempts[id] = mergeInProgressAttempt(b, f);
    }
  }

  const sessions = unionMaps(base.sessions, fresh.sessions);
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
  };
  if (merged.lastHeartbeatMs === -1) merged.lastHeartbeatMs = null;

  // Recompute derived integrity for in-progress attempts from the merged log
  // so every writer converges to identical values.
  for (const attempt of Object.values(merged.attempts)) {
    if (attempt.ended_at !== null) continue;
    const session = merged.sessions[attempt.session_id];
    const d = deriveIntegrity(merged.events[attempt.attempt_id] ?? [], nowMs, session?.study_tab_id != null);
    attempt.focus_loss_count = d.focus_loss_count;
    attempt.total_time_away_ms = d.total_time_away_ms;
    attempt.integrity_flag = d.integrity_flag;
  }

  // Reconcile dangling active pointers (clear, never resurrect).
  const activeAttempt = merged.activeAttemptId ? merged.attempts[merged.activeAttemptId] : undefined;
  if (merged.activeAttemptId && (!activeAttempt || activeAttempt.ended_at !== null)) {
    merged.activeAttemptId = null;
  }
  if (merged.activeSessionId && !merged.sessions[merged.activeSessionId]) {
    merged.activeSessionId = null;
  }
  return merged;
}
