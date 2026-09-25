/**
 * Explicit schema migration. v0.1 data (key puzzletrack.v1, no version field)
 * migrates safely into the v0.2 shape. Never resets storage; unknown fields
 * pass through untouched. Pure function — fully unit-tested.
 */
import { SCHEMA_VERSION, type Attempt, type PuzzleTrackStore, type Session } from '../models/types.js';

interface V1Attempt extends Record<string, unknown> {
  attempt_id: string;
}

interface V1Session extends Record<string, unknown> {
  session_id: string;
}

function migrateAttemptV1(raw: V1Attempt): Attempt {
  const get = (k: string): unknown => raw[k];
  const numOrNull = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  return {
    attempt_id: String(raw['attempt_id']),
    session_id: String(get('session_id') ?? ''),
    attempt_number: typeof get('attempt_number') === 'number' ? (get('attempt_number') as number) : 0,
    started_at: String(get('started_at') ?? new Date(0).toISOString()),
    ended_at: (get('ended_at') as string | null) ?? null,
    elapsed_ms: typeof get('elapsed_ms') === 'number' ? (get('elapsed_ms') as number) : 0,
    elapsed_seconds: typeof get('elapsed_seconds') === 'number' ? (get('elapsed_seconds') as number) : 0,
    time_limit_seconds: typeof get('time_limit_seconds') === 'number' ? (get('time_limit_seconds') as number) : 900,
    timed_out: get('timed_out') === true,
    experimental_result: (get('experimental_result') as Attempt['experimental_result']) ?? null,
    focus_loss_count: typeof get('focus_loss_count') === 'number' ? (get('focus_loss_count') as number) : 0,
    total_time_away_ms: typeof get('total_time_away_ms') === 'number' ? (get('total_time_away_ms') as number) : 0,
    integrity_flag: get('integrity_flag') === true,
    possibly_interrupted: get('possibly_interrupted') === true,
    problem_id: strOrNull(get('problem_id')),
    problem_rating: numOrNull(get('problem_rating')),
    player_rating_before: numOrNull(get('player_rating_before')),
    player_rating_after: numOrNull(get('player_rating_after')),
    chesstempo_result: strOrNull(get('chesstempo_result')),
    moves_used: numOrNull(get('moves_used')),
    average_moves: numOrNull(get('average_moves')),
    rating_change: numOrNull(get('rating_change')),
    difficulty_label: strOrNull(get('difficulty_label')),
    // v0.2 additions default to unmatched/unannotated.
    manual_problem_id: strOrNull(get('manual_problem_id')),
    chesstempo_attempted_at: strOrNull(get('chesstempo_attempted_at')),
    chesstempo_time_used_seconds: numOrNull(get('chesstempo_time_used_seconds')),
    chesstempo_import_id: strOrNull(get('chesstempo_import_id')),
    chesstempo_source_row:
      typeof get('chesstempo_source_row') === 'number' ? (get('chesstempo_source_row') as number) : null,
    match_confidence: (get('match_confidence') as Attempt['match_confidence']) ?? null,
  };
}

function migrateSessionV1(raw: V1Session): Session {
  const get = (k: string): unknown => raw[k];
  return {
    session_id: String(raw['session_id']),
    participant_id: String(get('participant_id') ?? ''),
    target_attempts: typeof get('target_attempts') === 'number' ? (get('target_attempts') as number) : 0,
    time_limit_seconds: typeof get('time_limit_seconds') === 'number' ? (get('time_limit_seconds') as number) : 900,
    started_at: String(get('started_at') ?? new Date(0).toISOString()),
    completed_at: (get('completed_at') as string | null) ?? null,
    status: (get('status') as Session['status']) ?? 'active',
    study_tab_id: typeof get('study_tab_id') === 'number' ? (get('study_tab_id') as number) : null,
  };
}

/**
 * Migrate any parsed store blob to the current shape.
 * - v1 (no schemaVersion): fill v0.2 defaults, keep every record.
 * - v2: pass through (forward-compatible: preserves unknown top-level keys).
 * Throws on non-object input instead of fabricating a store.
 */
export function migrateStore(parsed: unknown): PuzzleTrackStore {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('PuzzleTrack store blob is not an object; refusing to migrate.');
  }
  const raw = parsed as Record<string, unknown>;
  const version = typeof raw['schemaVersion'] === 'number' ? (raw['schemaVersion'] as number) : 1;
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `PuzzleTrack store schema v${version} is newer than supported v${SCHEMA_VERSION}; refusing to migrate.`,
    );
  }
  const attemptsRaw = (raw['attempts'] ?? {}) as Record<string, V1Attempt>;
  const sessionsRaw = (raw['sessions'] ?? {}) as Record<string, V1Session>;
  const attempts: Record<string, Attempt> = {};
  for (const [k, v] of Object.entries(attemptsRaw)) attempts[k] = migrateAttemptV1(v);
  const sessions: Record<string, Session> = {};
  for (const [k, v] of Object.entries(sessionsRaw)) sessions[k] = migrateSessionV1(v);

  return {
    schemaVersion: SCHEMA_VERSION,
    participants: (raw['participants'] ?? {}) as PuzzleTrackStore['participants'],
    sessions,
    attempts,
    events: (raw['events'] ?? {}) as PuzzleTrackStore['events'],
    activeSessionId: (raw['activeSessionId'] as string | null) ?? null,
    activeAttemptId: (raw['activeAttemptId'] as string | null) ?? null,
    lastHeartbeatMs: (raw['lastHeartbeatMs'] as number | null) ?? null,
    imports: (raw['imports'] ?? {}) as PuzzleTrackStore['imports'],
    importRows: (raw['importRows'] ?? {}) as PuzzleTrackStore['importRows'],
    matches: (raw['matches'] ?? {}) as PuzzleTrackStore['matches'],
    // Pilot review metadata is additive; older stores simply have none.
    pilotReview: (raw['pilotReview'] ?? {}) as PuzzleTrackStore['pilotReview'],
  };
}
