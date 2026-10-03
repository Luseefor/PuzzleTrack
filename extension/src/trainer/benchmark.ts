import type { LocalTrial } from './types.js';
/** Initial-position Syzygy outcome only. Never convert DTZ or mate into centipawns. */
export function firstMoveBenchmark(trial?: LocalTrial) {
  const missing = { first_move_solver_wdl: null as string | null, first_move_best_wdl: null as string | null, first_move_wdl_regret: null as boolean | null };
  if (!trial?.initial_tablebase || !trial.plies.some(p => p.actor === 'participant')) return missing;
  try {
    const data = JSON.parse(trial.initial_tablebase.raw) as { moves?: { uci: string; category: string }[] };
    if (!Array.isArray(data.moves) || data.moves.length === 0) return missing;
    const chosen = trial.plies.find(p => p.actor === 'participant')!.uci;
    const invert = (category?: string): string | null => category === 'loss' ? 'win' : category === 'win' ? 'loss' : category === 'draw' ? 'draw' : null;
    // Each move category is from the next side-to-move's perspective.
    const bestWdl = invert(data.moves[0]?.category), chosenWdl = invert(data.moves.find(m => m.uci === chosen)?.category);
    const ranks: Record<string, number> = { loss: 0, draw: 1, win: 2 };
    return { first_move_solver_wdl: chosenWdl, first_move_best_wdl: bestWdl, first_move_wdl_regret: chosenWdl !== null && bestWdl !== null ? ranks[chosenWdl]! < ranks[bestWdl]! : null };
  } catch { return missing; }
}
