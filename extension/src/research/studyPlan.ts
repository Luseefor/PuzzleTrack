import type { StudyPlan, StudyPuzzle } from '../models/types.js';
import { SUPPORTED_TIME_LIMITS } from '../models/types.js';

export function parseStudyPool(text: string): StudyPuzzle[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 10000) throw new Error('Pool must contain 1–10,000 puzzle references.');
  const ids = new Set<string>();
  return parsed.map(p => {
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !p.id.trim() || p.id.length > 64 || !Number.isFinite(p.rating) || p.rating < 0 ||
      typeof p.rating_source !== 'string' || !p.rating_source.trim() || p.rating_source.length > 100 || typeof p.task_type !== 'string' || !p.task_type.trim() || p.task_type.length > 64) throw new Error('Each puzzle needs id, numeric rating, rating_source and task_type.');
    if (ids.has(p.id.trim())) throw new Error('Puzzle IDs must be unique within the pool.');
    ids.add(p.id.trim());
    return { id: p.id.trim(), rating: p.rating, rating_source: p.rating_source.trim(), task_type: p.task_type.trim() };
  });
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Randomizes order (and hence difficulty mix) and total count; exact replay from pool + seed. */
export async function createStudyPlan(pool: StudyPuzzle[], seed: string, min: number, max: number, timeOptions?: readonly number[]): Promise<StudyPlan> {
  if (!seed.trim() || seed.length > 128) throw new Error('Enter a non-empty seed of at most 128 characters.');
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > Math.min(100, pool.length)) throw new Error('Count range must fit the pool and be between 1 and 100.');
  const canonical = [...parseStudyPool(JSON.stringify(pool))].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const frozenPool = canonical.map(p => ({ ...p }));
  const poolHash = await sha256(JSON.stringify(canonical));
  const seedHash = await sha256(seed);
  let state = Number.parseInt(seedHash.slice(0, 8), 16) || 0x9e3779b9;
  const uint = (): number => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const pick = (range: number): number => {
    // Reject the short tail so modulo does not bias the draw.
    const ceiling = Math.floor(0x100000000 / range) * range;
    let n: number; do { n = uint(); } while (n >= ceiling);
    return n % range;
  };
  const count = min + pick(max - min + 1);
  for (let i = canonical.length - 1; i > 0; i--) {
    const j = pick(i + 1); [canonical[i], canonical[j]] = [canonical[j]!, canonical[i]!];
  }
  const plan: StudyPlan = { algorithm: 'sha256-xorshift32-fisher-yates-v1', seed, pool_sha256: poolHash, pool: frozenPool, count_min: min, count_max: max, ordered_puzzles: canonical.slice(0, count) };
  if (timeOptions !== undefined) {
    if (!timeOptions.length || timeOptions.some(seconds => !(SUPPORTED_TIME_LIMITS as readonly number[]).includes(seconds))) throw new Error('Choose time conditions from 15, 20, 30, 45 or 60 minutes.');
    const options = [...new Set(timeOptions)].sort((a, b) => a - b);
    // A separate stream keeps time independent of rating, count and shuffle draws.
    state = Number.parseInt((await sha256('puzzletrack:time-conditions-v1:' + seed)).slice(0, 8), 16) || 0x9e3779b9;
    plan.time_assignment = { algorithm: 'sha256-xorshift32-time-conditions-v1', options_seconds: options, ordered_seconds: Array.from({ length: count }, () => options[pick(options.length)]!) };
  }
  return plan;
}
