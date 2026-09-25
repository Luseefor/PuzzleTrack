import { describe, expect, it } from 'vitest';
import { ATTEMPT_CSV_COLUMNS, attemptsToCsv } from '../src/export/csv.js';
import { backupFilename, buildBackup, parseBackup, serializeBackup } from '../src/export/jsonBackup.js';
import { emptyStore } from '../src/models/types.js';
import { MemoryStorageAdapter } from '../src/storage/storageAdapter.js';
import { Repository } from '../src/storage/repository.js';
import { completeAttempt, createSession, designateStudyTab, setManualProblemId, startAttempt } from '../src/session/sessionManager.js';
import { applyMatch, registerImport } from '../src/matching/applyMatch.js';
import { parseChessTempoCsv } from '../src/importer/chesstempoImporter.js';
import { recoverTimer } from '../src/timer/attemptTimer.js';

const T0 = Date.parse('2026-09-20T13:02:00.000Z');

describe('v2 export', () => {
  it('CSV contains raw, provenance, and derived columns with correct values', () => {
    const store = emptyStore();
    const session = createSession(store, 'P01', 2, 900, T0);
    const a = startAttempt(store, session.session_id, T0);
    setManualProblemId(store, a.attempt_id, '81496', T0 + 1000);
    completeAttempt(store, a.attempt_id, T0 + 102_000); // 102s elapsed
    const parsed = parseChessTempoCsv(
      'Problem ID,Date,Problem Rating,Player Rating,Result,Time Used (s)\n81496,2026-09-20 13:03:50,1200,1000,Win,100',
      'h.csv', T0,
    );
    const row = parsed.rows[0];
    if (!row) throw new Error('missing row');
    const res = applyMatch(store, { attemptId: a.attempt_id, row, confidence: 'high', reasons: ['t'], timeDeltaMs: 8000, matchedBy: 'manual' });
    expect(res.applied).toBe(true);

    const m = new Map([[session.session_id, 'P01']]);
    const csv = attemptsToCsv(m, Object.values(store.attempts));
    const header = (csv.split('\r\n')[0] as string).split(',');
    expect(header).toEqual([...ATTEMPT_CSV_COLUMNS]);
    const cells = (csv.trim().split('\r\n')[1] as string).split(',');
    const idx = (c: string): number => header.indexOf(c);
    // RAW preserved.
    expect(cells[idx('problem_id')]).toBe('81496');
    expect(cells[idx('problem_rating')]).toBe('1200');
    expect(cells[idx('chesstempo_time_used_seconds')]).toBe('100');
    // PROVENANCE.
    expect(cells[idx('match_confidence')]).toBe('high');
    expect(cells[idx('chesstempo_source_row')]).toBe('1');
    expect((cells[idx('chesstempo_import_id')] as string).length).toBeGreaterThan(0);
    // DERIVED computed at export.
    expect(cells[idx('relative_difficulty')]).toBe('200');
    expect(cells[idx('timer_difference_seconds')]).toBe('2');
    expect(cells[idx('away_time_percentage')]).toBe('0');
  });

  it('nulls export as empty cells in new columns', () => {
    const store = emptyStore();
    const session = createSession(store, 'P01', 2, 900, T0);
    const a = startAttempt(store, session.session_id, T0);
    completeAttempt(store, a.attempt_id, T0 + 60_000);
    const m = new Map([[session.session_id, 'P01']]);
    const csv = attemptsToCsv(m, Object.values(store.attempts));
    const header = (csv.split('\r\n')[0] as string).split(',');
    const cells = (csv.trim().split('\r\n')[1] as string).split(',');
    const idx = (c: string): number => header.indexOf(c);
    expect(cells[idx('relative_difficulty')]).toBe('');
    expect(cells[idx('match_confidence')]).toBe('');
    expect(cells[idx('away_time_percentage')]).toBe('0');
  });

  it('JSON backup round-trips participants/sessions/attempts/events/imports/matches', async () => {
    const store = emptyStore();
    const session = createSession(store, 'P01', 2, 900, T0);
    designateStudyTab(store, session.session_id, 42);
    const a = startAttempt(store, session.session_id, T0);
    completeAttempt(store, a.attempt_id, T0 + 60_000);
    const parsed = parseChessTempoCsv('Problem ID,Date\n81496,2026-09-20 13:03:10', 'h.csv', T0);
    registerImport(store, parsed.import, parsed.rows);
    const row = parsed.rows[0];
    if (!row) throw new Error('missing');
    applyMatch(store, { attemptId: a.attempt_id, row, confidence: 'high', reasons: ['t'], timeDeltaMs: 1, matchedBy: 'auto' });

    const backup = buildBackup(store, T0);
    const text = serializeBackup(backup);
    expect(backupFilename(backup.exportedAt)).toMatch(/^puzzletrack-backup-.*\.json$/);
    const restored = parseBackup(text);
    expect(restored.sessions[session.session_id]?.study_tab_id).toBe(42);
    expect(restored.attempts[a.attempt_id]?.problem_id).toBe('81496');
    expect(Object.keys(restored.imports)).toHaveLength(1);
    expect(Object.keys(restored.matches)).toHaveLength(1);
    expect(restored.events[a.attempt_id]?.length).toBeGreaterThan(0);

    // Restored store persists through the repository.
    const mem = new MemoryStorageAdapter();
    const repo = new Repository(mem);
    await repo.saveStore(restored);
    const reloaded = await repo.loadStore();
    expect(reloaded.matches[a.attempt_id]?.confidence).toBe('high');
  });

  it('backup rejects non-backup and corrupt payloads', () => {
    expect(() => parseBackup('not json')).toThrow();
    expect(() => parseBackup('{"format":"other"}')).toThrow();
  });
});

describe('side-panel session continuity (domain level)', () => {
  it('closing and reopening the UI does not stop or reset the timer', async () => {
    // Open UI #1 (popup): start session + attempt, then "close" (drop handle).
    const mem = new MemoryStorageAdapter();
    const repo1 = new Repository(mem);
    const s1 = await repo1.loadStore();
    const session = createSession(s1, 'P01', 10, 900, T0);
    const attempt = startAttempt(s1, session.session_id, T0);
    await repo1.saveStore(s1);

    // Open UI #2 (side panel): fresh handle over same bytes, 60s later.
    const mem2 = new MemoryStorageAdapter();
    mem2.restore(mem.snapshot());
    const repo2 = new Repository(mem2);
    const s2 = await repo2.loadStore();
    expect(s2.activeAttemptId).toBe(attempt.attempt_id);
    const snap = recoverTimer(
      (s2.attempts[attempt.attempt_id] as NonNullable<typeof s2.attempts[string]>).started_at, 900, T0 + 60_000,
    );
    expect(snap.elapsedMs).toBe(60_000);
    expect(snap.remainingMs).toBe(840_000);
    expect(snap.timedOut).toBe(false);
  });
});
