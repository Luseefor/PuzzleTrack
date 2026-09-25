import { describe, expect, it } from 'vitest';
import { ATTEMPT_CSV_COLUMNS, attemptsToCsv } from '../src/export/csv.js';
import type { Attempt } from '../src/models/types.js';

function attempt(partial: Partial<Attempt> = {}): Attempt {
  return {
    attempt_id: 'a1111111-1111-4111-8111-111111111111',
    session_id: 's2222222-2222-4222-8222-222222222222',
    attempt_number: 1,
    started_at: '2026-01-01T12:00:00.000Z',
    ended_at: '2026-01-01T12:02:14.567Z',
    elapsed_ms: 134567,
    elapsed_seconds: 134.567,
    time_limit_seconds: 900,
    timed_out: false,
    experimental_result: 'completed',
    focus_loss_count: 1,
    total_time_away_ms: 8000,
    integrity_flag: true,
    possibly_interrupted: false,
    problem_id: null,
    problem_rating: null,
    player_rating_before: null,
    player_rating_after: null,
    chesstempo_result: null,
    moves_used: null,
    average_moves: null,
    rating_change: null,
    difficulty_label: null,
    manual_problem_id: null,
    chesstempo_attempted_at: null,
    chesstempo_time_used_seconds: null,
    chesstempo_import_id: null,
    chesstempo_source_row: null,
    match_confidence: null,
    ...partial,
  };
}

describe('csv export', () => {
  it('has the exact required header', () => {
    const csv = attemptsToCsv(new Map(), []);
    const header = csv.split('\r\n')[0];
    expect(header).toBe([...ATTEMPT_CSV_COLUMNS].join(','));
    expect(ATTEMPT_CSV_COLUMNS).toContain('participant_id');
    expect(ATTEMPT_CSV_COLUMNS).toContain('difficulty_label');
    expect(ATTEMPT_CSV_COLUMNS).toContain('chesstempo_attempted_at');
    expect(ATTEMPT_CSV_COLUMNS).toContain('relative_difficulty');
    expect(ATTEMPT_CSV_COLUMNS).toContain('match_confidence');
    expect(ATTEMPT_CSV_COLUMNS).toHaveLength(31);
  });

  it('row count matches attempts + header', () => {
    const csv = attemptsToCsv(
      new Map([['s2222222-2222-4222-8222-222222222222', 'P01']]),
      [attempt(), attempt({ attempt_id: 'b3333333-3333-4333-8333-333333333333', attempt_number: 2 })],
    );
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
  });

  it('escapes commas and quotes', () => {
    const csv = attemptsToCsv(
      new Map([['s2222222-2222-4222-8222-222222222222', 'P01']]),
      [attempt({ chesstempo_result: 'win, "brilliant"' })],
    );
    expect(csv).toContain('"win, ""brilliant"""');
  });

  it('null ChessTempo fields export as empty cells', () => {
    const csv = attemptsToCsv(new Map([['s2222222-2222-4222-8222-222222222222', 'P01']]), [attempt()]);
    const row = csv.trim().split('\r\n')[1] as string;
    const cells = row.split(',');
    const idx = (c: string): number => [...ATTEMPT_CSV_COLUMNS].indexOf(c as (typeof ATTEMPT_CSV_COLUMNS)[number]);
    expect(cells[idx('problem_id')]).toBe('');
    expect(cells[idx('problem_rating')]).toBe('');
    expect(cells[idx('difficulty_label')]).toBe('');
    // Raw timing preserved exactly, not rounded.
    expect(cells[idx('elapsed_ms')]).toBe('134567');
    expect(cells[idx('elapsed_seconds')]).toBe('134.567');
  });

  it('booleans export as TRUE/FALSE', () => {
    const csv = attemptsToCsv(new Map([['s2222222-2222-4222-8222-222222222222', 'P01']]), [
      attempt({ timed_out: true, integrity_flag: true }),
    ]);
    expect(csv).toContain('TRUE');
  });
});
