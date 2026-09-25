/**
 * Deterministic PuzzleTrack <-> ChessTempo matching (v0.2).
 *
 * NEVER matches by row order. Signals (in priority order):
 *  1. exact problem-ID match (manual_problem_id annotation wins)
 *  2. ChessTempo timestamp inside the PuzzleTrack attempt interval
 *  3. time-used similarity (supporting signal when available)
 *
 * Confidence:
 *  - exact:  ID match + CT timestamp in tight window + time-used agrees (or missing)
 *  - high:   ID match (wide window / missing timestamp) OR single candidate in tight window
 *  - medium: single candidate in wide window
 *  - low:    ambiguous (>=2 plausible candidates) — researcher MUST resolve manually
 *  - unmatched: no candidate at all
 *
 * Only auto-apply matches when confidence is sufficiently high: `exact`
 * (a single problem-ID match disambiguates), or `high` with a single
 * candidate. For ambiguous data the researcher must resolve manually.
 */
import type { Attempt } from '../models/types.js';
import type { ChessTempoAttempt, MatchResult } from '../models/chesstempo.js';

/** CT timestamp may precede PT start by this much (clock skew / click delay). */
export const MATCH_BEFORE_START_MS = 60_000;
/** Tight window after PT end: auto-match territory. */
export const MATCH_TIGHT_AFTER_END_MS = 120_000;
/** Wide window after PT end: manual-review territory. */
export const MATCH_WIDE_AFTER_END_MS = 600_000;
/** Time-used agreement tolerance for `exact` confidence. */
export const TIME_USED_AGREEMENT_S = 60;

export interface MatchableAttempt {
  attemptId: string;
  startedAtMs: number;
  endedAtMs: number | null;
  elapsedSeconds: number | null;
  manualProblemId: string | null;
}

export function toMatchable(a: Attempt): MatchableAttempt {
  return {
    attemptId: a.attempt_id,
    startedAtMs: Date.parse(a.started_at),
    endedAtMs: a.ended_at ? Date.parse(a.ended_at) : null,
    elapsedSeconds: a.ended_at ? a.elapsed_seconds : null,
    manualProblemId: a.manual_problem_id,
  };
}

function normId(id: string | null): string | null {
  if (id === null) return null;
  const t = id.trim().replace(/^#/, '');
  return t === '' ? null : t;
}

interface Scored {
  row: ChessTempoAttempt;
  rowMs: number | null;
  inTight: boolean;
  inWide: boolean;
  idMatch: boolean;
  timeDeltaMs: number | null;
}

/**
 * Auto-apply gate.
 * - exact: a single problem-ID match disambiguates timestamp-only neighbours,
 *   so it is always auto-appliable (multiple ID matches never reach `exact` —
 *   the scorer reports those as ambiguous `low`).
 * - high: auto-appliable only with a single candidate.
 * Everything else requires explicit manual resolution.
 */
export function isAutoAppliable(r: MatchResult): boolean {
  if (r.chessTempoRowId === null) return false;
  if (r.confidence === 'exact') return true;
  return r.confidence === 'high' && r.candidates.length <= 1;
}

export function scoreAttempt(attempt: MatchableAttempt, rows: ChessTempoAttempt[]): MatchResult {
  const manualId = normId(attempt.manualProblemId);
  const start = attempt.startedAtMs;
  // Open attempts match against "now" as provisional end; matching UI targets finished attempts.
  const end = attempt.endedAtMs ?? Date.now();

  const scored: Scored[] = [];
  for (const row of rows) {
    if (row.validity === 'invalid') continue;
    const rowMs = row.attemptedAt ? Date.parse(row.attemptedAt) : null;
    const rowId = normId(row.problemId);
    const idMatch = manualId !== null && rowId !== null && rowId.toLowerCase() === manualId.toLowerCase();
    let inTight = false;
    let inWide = false;
    let timeDeltaMs: number | null = null;
    if (rowMs !== null) {
      timeDeltaMs = rowMs - end;
      inTight = rowMs >= start - MATCH_BEFORE_START_MS && rowMs <= end + MATCH_TIGHT_AFTER_END_MS;
      inWide = !inTight && rowMs > end + MATCH_TIGHT_AFTER_END_MS && rowMs <= end + MATCH_WIDE_AFTER_END_MS;
    }
    if (idMatch || inTight || inWide) {
      scored.push({ row, rowMs, inTight, inWide, idMatch, timeDeltaMs });
    }
  }

  const noMatch = (reasons: string[]): MatchResult => ({
    attemptId: attempt.attemptId,
    chessTempoRowId: null,
    confidence: 'unmatched',
    reasons,
    timeDeltaMs: null,
    candidates: [],
  });

  if (scored.length === 0) return noMatch(['No ChessTempo row with matching problem ID or timestamp in window.']);

  const candidates = scored.map((s) => ({
    rowId: s.row.rowId,
    problemId: s.row.problemId,
    attemptedAt: s.row.attemptedAt,
    timeDeltaMs: s.timeDeltaMs,
  }));

  // Ambiguity gate: more than one ID match, or >1 tight candidate without a
  // distinguishing ID match → researcher must choose. Never guess silently.
  const idMatches = scored.filter((s) => s.idMatch);
  if (idMatches.length > 1) {
    return {
      attemptId: attempt.attemptId,
      chessTempoRowId: null,
      confidence: 'low',
      reasons: [`Ambiguous: ${idMatches.length} rows share problem ID "${manualId}". Manual resolution required.`],
      timeDeltaMs: null,
      candidates,
    };
  }
  const tight = scored.filter((s) => s.inTight);
  if (idMatches.length === 0 && tight.length > 1) {
    return {
      attemptId: attempt.attemptId,
      chessTempoRowId: null,
      confidence: 'low',
      reasons: [`Ambiguous: ${tight.length} ChessTempo records near this attempt. Manual resolution required.`],
      timeDeltaMs: null,
      candidates,
    };
  }

  const best = (idMatches[0] ?? tight[0] ?? scored.filter((s) => s.inWide)[0]) as Scored | undefined;
  if (!best) {
    return {
      attemptId: attempt.attemptId,
      chessTempoRowId: null,
      confidence: 'low',
      reasons: ['Plausible rows exist but none is decisive. Manual resolution required.'],
      timeDeltaMs: null,
      candidates,
    };
  }

  const reasons: string[] = [];
  if (best.idMatch) reasons.push(`Problem ID matches (${manualId}).`);
  if (best.inTight && best.rowMs !== null) {
    reasons.push(
      best.timeDeltaMs !== null && best.timeDeltaMs >= 0
        ? `ChessTempo timestamp ${Math.round((best.timeDeltaMs as number) / 1000)}s after attempt end.`
        : 'ChessTempo timestamp inside attempt interval.',
    );
  } else if (best.inWide) {
    reasons.push('ChessTempo timestamp outside tight window — review manually.');
  } else if (best.rowMs === null) {
    reasons.push('ChessTempo row has no timestamp — matched by problem ID only.');
  }

  // Time-used similarity (supporting signal when both exist).
  let timeAgrees: boolean | null = null;
  if (best.row.timeUsedSeconds !== null && attempt.elapsedSeconds !== null) {
    const diff = Math.abs(best.row.timeUsedSeconds - (attempt.elapsedSeconds as number));
    timeAgrees = diff <= TIME_USED_AGREEMENT_S;
    reasons.push(
      timeAgrees
        ? `Time-used agrees (PuzzleTrack ${Math.round(attempt.elapsedSeconds as number)}s vs ChessTempo ${best.row.timeUsedSeconds}s).`
        : `Time-used differs (PuzzleTrack ${Math.round(attempt.elapsedSeconds as number)}s vs ChessTempo ${best.row.timeUsedSeconds}s) — review.`,
    );
  }

  let confidence: MatchResult['confidence'];
  if (best.idMatch && best.inTight && timeAgrees !== false) confidence = 'exact';
  else if (best.idMatch || (best.inTight && candidates.length === 1)) confidence = 'high';
  else if (best.inWide && candidates.length === 1) confidence = 'medium';
  else confidence = 'low';

  return {
    attemptId: attempt.attemptId,
    chessTempoRowId: best.row.rowId,
    confidence,
    reasons,
    timeDeltaMs: best.timeDeltaMs,
    candidates,
  };
}

/**
 * Greedy 1:1 assignment across attempts: exact first, then high, then medium.
 * A claimed row is never given to two attempts; bumped losers become `low`
 * with candidates preserved for manual resolution. Medium/low are reported
 * but NOT auto-appliable (researcher confirms in UI).
 */
export function assignMatches(results: MatchResult[]): MatchResult[] {
  const claimed = new Set<string>();
  const order = { exact: 0, high: 1, medium: 2, low: 3, unmatched: 4 } as const;
  const sorted = [...results].sort((a, b) => order[a.confidence] - order[b.confidence]);
  const final = new Map<string, MatchResult>();

  for (const r of sorted) {
    if (r.chessTempoRowId === null || !isAutoAppliable(r)) {
      final.set(r.attemptId, r);
      if (r.chessTempoRowId !== null) claimed.add(r.chessTempoRowId);
      continue;
    }
    const rowId = r.chessTempoRowId as string;
    if (claimed.has(rowId)) {
      final.set(r.attemptId, {
        ...r,
        chessTempoRowId: null,
        confidence: 'low',
        reasons: [...r.reasons, 'Best row already matched to another attempt. Manual resolution required.'],
        timeDeltaMs: null,
      });
    } else {
      claimed.add(rowId);
      final.set(r.attemptId, r);
    }
  }
  return results.map((r) => final.get(r.attemptId) as MatchResult);
}
