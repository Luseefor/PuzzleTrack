import { describe, expect, it } from 'vitest';
import { SCHEMA_VERSION, emptyStore } from '../src/models/types.js';
import { migrateStore } from '../src/storage/migration.js';
import { MemoryStorageAdapter } from '../src/storage/storageAdapter.js';
import { Repository } from '../src/storage/repository.js';

/** Representative v0.1 blob: no schemaVersion, no study_tab_id, no v0.2 attempt fields. */
function v1Blob(): string {
  return JSON.stringify({
    participants: { P01: { participant_id: 'P01', created_at: '2026-09-20T13:00:00.000Z' } },
    sessions: {
      's-1': {
        session_id: 's-1', participant_id: 'P01', target_attempts: 10, time_limit_seconds: 900,
        started_at: '2026-09-20T13:00:00.000Z', completed_at: null, status: 'active',
      },
    },
    attempts: {
      'a-1': {
        attempt_id: 'a-1', session_id: 's-1', attempt_number: 1,
        started_at: '2026-09-20T13:02:00.000Z', ended_at: '2026-09-20T13:02:43.000Z',
        elapsed_ms: 43000, elapsed_seconds: 43, time_limit_seconds: 900,
        timed_out: false, experimental_result: 'completed',
        focus_loss_count: 1, total_time_away_ms: 15000, integrity_flag: true,
        possibly_interrupted: false,
        problem_id: null, problem_rating: null, player_rating_before: null,
        player_rating_after: null, chesstempo_result: null, moves_used: null,
        average_moves: null, rating_change: null, difficulty_label: null,
      },
    },
    events: {
      'a-1': [
        { event_id: 'e1', attempt_id: 'a-1', timestamp: '2026-09-20T13:02:00.000Z', event_type: 'attempt_started' },
        { event_id: 'e2', attempt_id: 'a-1', timestamp: '2026-09-20T13:02:10.000Z', event_type: 'tab_hidden' },
      ],
    },
    activeSessionId: null,
    activeAttemptId: null,
    lastHeartbeatMs: 123456789,
  });
}

describe('migration v1 -> v2', () => {
  it('preserves every record and fills v0.2 defaults', () => {
    const store = migrateStore(JSON.parse(v1Blob()) as unknown);
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(store.participants['P01']?.participant_id).toBe('P01');
    const session = store.sessions['s-1'];
    expect(session?.status).toBe('active');
    expect(session?.target_attempts).toBe(10);
    expect(session?.study_tab_id).toBeNull();
    const attempt = store.attempts['a-1'];
    expect(attempt?.elapsed_ms).toBe(43000); // raw timing intact
    expect(attempt?.total_time_away_ms).toBe(15000);
    expect(attempt?.integrity_flag).toBe(true);
    expect(attempt?.manual_problem_id).toBeNull();
    expect(attempt?.chesstempo_import_id).toBeNull();
    expect(attempt?.match_confidence).toBeNull();
    // v0.3 additions default safely on pre-bridge records.
    expect(session?.auto_mode).toBe(false);
    expect(attempt?.capture_origin).toBeNull();
    expect(attempt?.cross_validation).toBeNull();
    expect(attempt?.requires_review).toBe(false);
    expect(store.liveObservations).toEqual({});
    expect(store.bridgeStatus.connected).toBe(false);
    expect(store.events['a-1']).toHaveLength(2); // raw events intact
    expect(store.lastHeartbeatMs).toBe(123456789);
    expect(store.imports).toEqual({});
    expect(store.matches).toEqual({});
  });

  it('migrates on load through the repository (storage key unchanged)', async () => {
    const mem = new MemoryStorageAdapter();
    await mem.save(v1Blob());
    const store = await new Repository(mem).loadStore();
    expect(store.schemaVersion).toBe(SCHEMA_VERSION);
    expect(store.attempts['a-1']?.experimental_result).toBe('completed');
    expect(store.sessions['s-1']?.study_tab_id).toBeNull();
  });

  it('v2 stores pass through untouched', () => {
    const v2 = emptyStore();
    const out = migrateStore(JSON.parse(JSON.stringify(v2)) as unknown);
    expect(out).toEqual(v2);
  });

  it('refuses non-objects and newer schemas instead of destroying data', () => {
    expect(() => migrateStore(null)).toThrow();
    expect(() => migrateStore('nope')).toThrow();
    expect(() => migrateStore({ schemaVersion: 999 })).toThrow();
  });
});
