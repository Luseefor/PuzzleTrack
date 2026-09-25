import { describe, expect, it } from 'vitest';
import { emptyStore } from '../src/models/types.js';
import { Repository } from '../src/storage/repository.js';
import {
  abortAttempt,
  completeAttempt,
  createSession,
  startAttempt,
  summarizeSession,
  timeoutAttempt,
} from '../src/session/sessionManager.js';

function setup() {
  const store = emptyStore();
  const session = createSession(store, 'P01', 3, 900, 1_000_000);
  return { store, session };
}

describe('sessions', () => {
  it('generates unique IDs', () => {
    const a = setup();
    const b = emptyStore();
    const s2 = createSession(b, 'P01', 3, 900, 1_000_000);
    expect(a.session.participant_id).toBe('P01');
    expect(a.session.session_id).not.toBe(s2.session_id);
  });

  it('increments attempt numbers correctly', () => {
    const { store, session } = setup();
    const a1 = startAttempt(store, session.session_id, 1_000_000);
    expect(a1.attempt_number).toBe(1);
    completeAttempt(store, a1.attempt_id, 1_100_000);
    const a2 = startAttempt(store, session.session_id, 1_200_000);
    expect(a2.attempt_number).toBe(2);
  });

  it('cannot exceed target count', () => {
    const { store, session } = setup(); // target 3
    for (let i = 0; i < 3; i++) {
      const a = startAttempt(store, session.session_id, 1_000_000 + i * 1000);
      completeAttempt(store, a.attempt_id, 1_000_000 + i * 1000 + 500);
    }
    expect(() => startAttempt(store, session.session_id, 2_000_000)).toThrow();
  });

  it('final attempt completes the session', () => {
    const { store, session } = setup();
    for (let i = 0; i < 3; i++) {
      const a = startAttempt(store, session.session_id, 1_000_000 + i * 1000);
      completeAttempt(store, a.attempt_id, 1_000_000 + i * 1000 + 500);
    }
    expect(store.sessions[session.session_id]?.status).toBe('completed');
    expect(store.activeSessionId).toBeNull();
  });

  it('timeout locks result and uses full limit as elapsed', () => {
    const { store, session } = setup();
    const a = startAttempt(store, session.session_id, 1_000_000);
    const finished = timeoutAttempt(store, a.attempt_id, 1_000_000 + 900_000);
    expect(finished.timed_out).toBe(true);
    expect(finished.experimental_result).toBe('timeout');
    expect(finished.elapsed_ms).toBe(900_000);
    expect(finished.elapsed_seconds).toBe(900);
  });

  it('abort saves elapsed without completed/timeout flags', () => {
    const { store, session } = setup();
    const a = startAttempt(store, session.session_id, 1_000_000);
    const finished = abortAttempt(store, a.attempt_id, 1_050_000);
    expect(finished.experimental_result).toBe('aborted');
    expect(finished.timed_out).toBe(false);
    expect(finished.elapsed_ms).toBe(50_000);
  });

  it('summary counts + median are correct', () => {
    const { store, session } = setup();
    const a1 = startAttempt(store, session.session_id, 1_000_000);
    completeAttempt(store, a1.attempt_id, 1_060_000); // 60s
    const a2 = startAttempt(store, session.session_id, 2_000_000);
    timeoutAttempt(store, a2.attempt_id, 2_000_000 + 900_000); // 900s
    const s = summarizeSession(store, session.session_id);
    expect(s.completed).toBe(1);
    expect(s.timedOut).toBe(1);
    expect(s.medianElapsedMs).toBe((60_000 + 900_000) / 2);
  });

  it('enforces one active session and one active attempt', () => {
    const { store } = setup();
    expect(() => createSession(store, 'P02', 5, 900, 2_000_000)).toThrow();
    const sid = store.activeSessionId as string;
    startAttempt(store, sid, 2_000_000);
    expect(() => startAttempt(store, sid, 2_000_001)).toThrow();
  });

  it('completed attempts are immutable through the repository guard', () => {
    const { store, session } = setup();
    const a = startAttempt(store, session.session_id, 1_000_000);
    completeAttempt(store, a.attempt_id, 1_010_000);
    const finished = store.attempts[a.attempt_id];
    expect(finished).toBeDefined();
    expect(() => Repository.putAttempt(store, { ...(finished as NonNullable<typeof finished>), elapsed_ms: 1 })).toThrow();
  });
});
