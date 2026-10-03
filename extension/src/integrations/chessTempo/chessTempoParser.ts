/**
 * Pure string parsers for visible ChessTempo metadata (v0.3). Every parser
 * takes already-extracted element text and returns a validated value or null.
 * Parsers NEVER guess: unrecognized input yields null, and the adapter records
 * the field as missing. Fully unit-tested with representative strings.
 */
import type { SiteResult } from './chessTempoTypes.js';

/** Accepts "Problem #81496", "#81496", "81496" → "81496". Null otherwise. */
export function parseProblemId(text: string): string | null {
  const t = text.trim();
  if (t.length === 0 || t.length > 64) return null;
  const m = t.match(/^(?:problem\s*)?#?\s*(\d{2,10})$/i);
  if (!m) return null;
  // Bare-digit strings are only trusted when short and purely numeric —
  // the caller scopes this parser to problem-id elements.
  if (!t.includes('#') && !/problem/i.test(t) && !/^\d{2,10}$/.test(t)) return null;
  return m[1] as string;
}

/** First plausible chess rating (100–4000, decimals preserved) in the text, else null. */
export function parseRating(text: string): number | null {
  const m = text.replace(/,/g, '').match(/(?<![\d.+-])(\d{3,4}(?:\.\d+)?)(?![\d.])/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 100 && n <= 4000 ? n : null;
}

/** Rating change like "+16", "-11", "+6.9", "-0.08" → number, else null. */
export function parseRatingChange(text: string): number | null {
  const m = text.replace(/,/g, '').match(/^\s*([+-]?\d{1,4}(?:\.\d+)?)\s*(?:pts?|points?)?\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && Math.abs(n) <= 2000 ? n : null;
}

export interface RatingWithChange {
  rating: number | null;
  /** Only set when a second, explicitly signed number is present. */
  change: number | null;
}

/**
 * Combined rating display like "1506.9 +6.9" or "702.17 -0.08".
 * The FIRST number is the current rating; a SECOND number counts as the
 * change ONLY when it carries an explicit sign — otherwise change stays null
 * (never guess which number means what). Single unsigned numbers yield
 * { rating, change: null }; single signed numbers yield { rating: null,
 * change } only when they look like a delta (absolute value < 100)… no:
 * ambiguity resolves to null/change by position alone — a lone number is the
 * rating, never the change.
 */
export function parseRatingWithChange(text: string): RatingWithChange {
  const clean = text.replace(/,/g, '');
  const ratingMatch = clean.match(/(?<![\d.+-])(\d{3,4}(?:\.\d+)?)(?![\d.])/);
  const rating = ratingMatch ? Number(ratingMatch[1]) : Number.NaN;
  const rest = ratingMatch ? clean.slice((ratingMatch.index ?? 0) + ratingMatch[0].length) : clean;
  // Only an explicitly signed number AFTER the rating counts as the change.
  const changeMatch = rest.match(/([+-]\d{1,4}(?:\.\d+)?)/);
  const change = changeMatch ? Number(changeMatch[1]) : Number.NaN;
  return {
    rating: Number.isFinite(rating) && rating >= 100 && rating <= 4000 ? rating : null,
    change: Number.isFinite(change) && Math.abs(change) <= 2000 ? change : null,
  };
}

/**
 * Visible result state → semantic result. Returns null when the text cannot
 * be interpreted confidently (caller treats null as "no result shown").
 */
export function parseResult(text: string): SiteResult['result'] | null {
  const t = text.trim().toLowerCase();
  if (t === '') return null;
  if (/\b(not|never|unsolved)\b/.test(t)) return null;
  if (/\b(incorrect|wrong|fail|failed|mistake|loss|lost)\b/.test(t) || t === '0-1' || t === '0') return 'incorrect';
  if (/\b(correct|solved|success|win|won)\b/.test(t) || t === '1-0' || t === '1') return 'correct';
  if (/\bcompleted\b|\bfinished\b/.test(t)) return 'completed';
  return null;
}

/**
 * Time-used text → seconds. Accepts "13 s", "43s", "0:13", "1:02", "90".
 * Null when unrecognized. Plain numbers are seconds.
 */
export function parseTimeUsed(text: string): number | null {
  const t = text.trim().toLowerCase();
  if (t === '') return null;
  const clock = t.match(/^(?:(\d{1,2}):)?(\d{1,3}):(\d{2}(?:\.\d+)?)$/);
  if (clock) {
    const hours = clock[1] === undefined ? 0 : Number(clock[1]);
    const minutes = Number(clock[2]), seconds = Number(clock[3]);
    if (seconds >= 60 || (clock[1] !== undefined && minutes >= 60)) return null;
    const value = hours * 3600 + minutes * 60 + seconds;
    return value <= 86400 ? value : null;
  }
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?$/);
  if (!m) return null;
  const multiplier = m[2]?.startsWith('m') ? 60 : m[2]?.startsWith('h') ? 3600 : 1;
  const n = Number(m[1]) * multiplier;
  return Number.isFinite(n) && n >= 0 && n <= 86400 ? n : null;
}

/** Move count text → integer, else null. */
export function parseMoves(text: string): number | null {
  const m = text.replace(/,/g, '').match(/^(?:moves?:\s*)?(\d{1,4})\s*(?:moves?)?\s*(?:\(Perfect!\))?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n <= 10000 ? n : null;
}

/** Parse only an explicit visible step/move counter, such as "Step 2 of 5" or "2 / 5". */
export function parseStepCounter(text: string): { stepNumber: number; stepTotal: number | null } | null {
  const t = text.trim().toLowerCase();
  if (t.length === 0 || t.length > 64) return null;
  const match = t.match(/(?:step|move|ply)\s*(\d{1,3})(?:\s*(?:of|\/)\s*(\d{1,3}))?/)
    ?? t.match(/^(\d{1,3})\s*\/\s*(\d{1,3})$/);
  if (!match) return null;
  const stepNumber = Number(match[1]);
  const stepTotal = match[2] === undefined ? null : Number(match[2]);
  if (!Number.isInteger(stepNumber) || stepNumber < 1 || stepNumber > 1000) return null;
  if (stepTotal !== null && (!Number.isInteger(stepTotal) || stepTotal < stepNumber || stepTotal > 1000)) return null;
  return { stepNumber, stepTotal };
}
