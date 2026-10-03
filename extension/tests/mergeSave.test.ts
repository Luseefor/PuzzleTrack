import { describe, expect, it } from 'vitest';
import { emptyStore, type PuzzleTrackStore } from '../src/models/types.js';
import { MemoryStorageAdapter } from '../src/storage/storageAdapter.js';
import { Repository, mergeStores } from '../src/storage/repository.js';
import { buildBackup, parseBackup, serializeBackup } from '../src/export/jsonBackup.js';
import {
  completeAttempt,
  createSession,
  setPilotReview,
  startAttempt,
} from '../src/session/sessionManager.js';
import { recordFocusSignal } from '../src/session/sessionManager.js';

const T0 = Date.parse('2026-09-20T13:02:00.000Z');

function seedActive(): { store: PuzzleTrackStore; attemptId: string } {
  const store = emptyStore();
  const session = createSession(store, 'P01', 10, 900, T0);
  const a = startAttempt(store, session.session_id, T0);
  return { store, attemptId: a.attempt_id };
}

describe('merge-save concurrency', () => {
  it('reproduces the pilot race: plain save drops a concurrent focus event', async () => {
    const mem = new MemoryStorageAdapter();
    const repo = new Repository(mem);
    const { store, attemptId } = seedActive();
    await repo.saveStore(store);

    // Popup tick loads S0...
    const tickBase = await repo.loadStore();
    // ...background appends a focus event and saves S1...
    const bg = await repo.loadStore();
    recordFocusSignal(bg, attemptId, 'window_blur', T0 + 5_000);
    await repo.saveStore(bg);
    // ...popup tick refreshes derived fields from stale S0 and saves (plain).
    const { refreshAttemptIntegrity } = await import('../src/session/sessionManager.js');
    refreshAttemptIntegrity(tickBase, attemptId, T0 + 6_000);
    await repo.saveStore(tickBase);

    const final = await repo.loadStore();
    // Event lost under last-write-wins:
    expect((final.events[attemptId] ?? []).some((e) => e.event_type === 'window_blur')).toBe(false);
  });

  it('merge-save preserves the concurrent event and converges derived fields', async () => {
    const mem = new MemoryStorageAdapter();
    const repo = new Repository(mem);
    const { store, attemptId } = seedActive();
    await repo.saveStore(store);

    const tickBase = await repo.loadStore();
    const bg = await repo.loadStore();
    recordFocusSignal(bg, attemptId, 'window_blur', T0 + 5_000);
    await repo.saveMerged(bg, T0 + 5_000);

    const { refreshAttemptIntegrity } = await import('../src/session/sessionManager.js');
    refreshAttemptIntegrity(tickBase, attemptId, T0 + 6_000);
    const merged = await repo.saveMerged(tickBase, T0 + 6_000);

    const events = merged.events[attemptId] ?? [];
    expect(events.some((e) => e.event_type === 'window_blur')).toBe(true);
    // Away window still open at T0+6s: 1 s away, one interruption, flag true.
    const attempt = merged.attempts[attemptId];
    expect(attempt?.focus_loss_count).toBe(1);
    expect(attempt?.total_time_away_ms).toBe(1_000);
    expect(attempt?.integrity_flag).toBe(true);
  });

  it('a finish in either copy wins; in-progress state is never resurrected', () => {
    const { store, attemptId } = seedActive();
    const staleInProgress = JSON.parse(JSON.stringify(store)) as PuzzleTrackStore;
    completeAttempt(store, attemptId, T0 + 60_000);
    const merged = mergeStores(staleInProgress, store, T0 + 60_000);
    expect(merged.attempts[attemptId]?.ended_at).not.toBeNull();
    expect(merged.activeAttemptId).toBeNull();
  });

  it('stale nulls never erase freshly matched chess fields', () => {
    const { store, attemptId } = seedActive();
    const stale = JSON.parse(JSON.stringify(store)) as PuzzleTrackStore;
    const attempt = store.attempts[attemptId];
    if (!attempt) throw new Error('missing');
    attempt.problem_id = '81496';
    attempt.match_confidence = 'high';
    attempt.chesstempo_import_id = 'imp1';
    attempt.chesstempo_source_row = 3;
    const merged = mergeStores(stale, store, T0 + 1_000);
    const out = merged.attempts[attemptId];
    expect(out?.problem_id).toBe('81496');
    expect(out?.match_confidence).toBe('high');
  });

  it('latches and heartbeats converge (possibly_interrupted OR, heartbeat max)', () => {
    const { store, attemptId } = seedActive();
    const other = JSON.parse(JSON.stringify(store)) as PuzzleTrackStore;
    const otherAttempt = other.attempts[attemptId];
    if (!otherAttempt) throw new Error('missing');
    otherAttempt.possibly_interrupted = true;
    other.lastHeartbeatMs = T0 + 9_000;
    store.lastHeartbeatMs = T0 + 5_000;
    const merged = mergeStores(store, other, T0 + 9_000);
    expect(merged.attempts[attemptId]?.possibly_interrupted).toBe(true);
    expect(merged.lastHeartbeatMs).toBe(T0 + 9_000);
  });

  it('finished-path merge preserves freshly matched chess fields (regression)', () => {
    const { store, attemptId } = seedActive();
    completeAttempt(store, attemptId, T0 + 60_000);
    // Stale tick copy loaded before the dataset applied a history match.
    const stale = JSON.parse(JSON.stringify(store)) as PuzzleTrackStore;
    const fresh = store.attempts[attemptId];
    if (!fresh) throw new Error('missing');
    fresh.problem_id = '81496';
    fresh.problem_rating = 702;
    fresh.capture_origin = 'history';
    fresh.match_confidence = 'high';
    fresh.chesstempo_import_id = 'imp1';
    fresh.chesstempo_source_row = 3;
    const merged = mergeStores(stale, store, T0 + 61_000);
    const out = merged.attempts[attemptId];
    expect(out?.ended_at).not.toBeNull();
    expect(out?.problem_id).toBe('81496');
    expect(out?.capture_origin).toBe('history');
  });

  it('bridge status is recency-wins, never clobbered by a stale tick', () => {
    const { store } = seedActive();
    const stale = JSON.parse(JSON.stringify(store)) as PuzzleTrackStore;
    store.bridgeStatus = {
      connected: true, tabId: 42, problemId: '81496', problemRating: 702,
      playerRating: 1507, lastEvent: 'problem_loaded', error: null,
      updatedAt: new Date(T0 + 5_000).toISOString(),
    };
    const merged = mergeStores(stale, store, T0 + 6_000);
    expect(merged.bridgeStatus.connected).toBe(true);
    expect(merged.bridgeStatus.problemId).toBe('81496');
    // Stale side wins only when genuinely newer.
    const staleNewer = JSON.parse(JSON.stringify(merged)) as PuzzleTrackStore;
    staleNewer.bridgeStatus = {
      connected: false, tabId: null, problemId: null, problemRating: null,
      playerRating: null, lastEvent: null, error: 'Closed.',
      updatedAt: new Date(T0 + 9_000).toISOString(),
    };
    const merged2 = mergeStores(staleNewer, merged, T0 + 10_000);
    expect(merged2.bridgeStatus.connected).toBe(false);
  });
});

describe('backup round-trip with review metadata', () => {
  it('full v2 state survives export/restore with zero loss', async () => {
    const mem = new MemoryStorageAdapter();
    const repo = new Repository(mem);
    const store = emptyStore();
    const session = createSession(store, 'P01', 2, 900, T0);
    const a = startAttempt(store, session.session_id, T0);
    recordFocusSignal(store, a.attempt_id, 'window_blur', T0 + 5_000);
    recordFocusSignal(store, a.attempt_id, 'window_focus', T0 + 9_000);
    completeAttempt(store, a.attempt_id, T0 + 60_000);
    setPilotReview(store, a.attempt_id, 'verified', 'pilot note', T0 + 61_000);
    await repo.saveStore(store);

    const loaded = await repo.loadStore();
    const text = serializeBackup(buildBackup(loaded, T0 + 62_000));
    const restored = parseBackup(text);
    // Semantic equality across every collection.
    expect(restored).toEqual(loaded);
    expect(restored.pilotReview[a.attempt_id]).toEqual({
      attempt_id: a.attempt_id,
      status: 'verified',
      note: 'pilot note',
      updated_at: new Date(T0 + 61_000).toISOString(),
    });
    expect(restored.events[a.attempt_id]).toHaveLength((loaded.events[a.attempt_id] ?? []).length);
  });
});
