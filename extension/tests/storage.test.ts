import { describe, expect, it } from 'vitest';
import { emptyStore } from '../src/models/types.js';
import { MemoryStorageAdapter } from '../src/storage/storageAdapter.js';
import { Repository } from '../src/storage/repository.js';
import { completeAttempt, createSession, startAttempt } from '../src/session/sessionManager.js';

describe('storage persistence', () => {
  it('session survives reload (same bytes, fresh handle)', async () => {
    const mem = new MemoryStorageAdapter();
    const repo = new Repository(mem);
    const store = await repo.loadStore();
    createSession(store, 'P01', 10, 900, 1_000_000);
    await repo.saveStore(store);

    // Simulate popup reload: new Repository over the same snapshot.
    const mem2 = new MemoryStorageAdapter();
    mem2.restore(mem.snapshot());
    const repo2 = new Repository(mem2);
    const reloaded = await repo2.loadStore();
    expect(reloaded.activeSessionId).toBe(store.activeSessionId);
    expect(Object.keys(reloaded.sessions)).toHaveLength(1);
  });

  it('attempt survives reload with started_at intact (timer recovery)', async () => {
    const mem = new MemoryStorageAdapter();
    const repo = new Repository(mem);
    const store = await repo.loadStore();
    const session = createSession(store, 'P01', 10, 900, 1_000_000);
    const attempt = startAttempt(store, session.session_id, 1_000_000);
    await repo.saveStore(store);

    const mem2 = new MemoryStorageAdapter();
    mem2.restore(mem.snapshot());
    const reloaded = await new Repository(mem2).loadStore();
    expect(reloaded.activeAttemptId).toBe(attempt.attempt_id);
    expect(reloaded.attempts[attempt.attempt_id]?.started_at).toBe(attempt.started_at);
    expect(reloaded.attempts[attempt.attempt_id]?.ended_at).toBeNull();
  });

  it('completed records remain immutable through normal UI path', async () => {
    const mem = new MemoryStorageAdapter();
    const repo = new Repository(mem);
    const store = await repo.loadStore();
    const session = createSession(store, 'P01', 10, 900, 1_000_000);
    const attempt = startAttempt(store, session.session_id, 1_000_000);
    completeAttempt(store, attempt.attempt_id, 1_100_000);
    await repo.saveStore(store);

    const reloaded = await repo.loadStore();
    const finished = reloaded.attempts[attempt.attempt_id];
    expect(finished?.ended_at).not.toBeNull();
    expect(() => Repository.putAttempt(reloaded, { ...(finished as NonNullable<typeof finished>), elapsed_ms: 999 })).toThrow();
  });

  it('empty adapter yields a clean store', async () => {
    const store = await new Repository(new MemoryStorageAdapter()).loadStore();
    expect(store).toEqual(emptyStore());
  });
});
