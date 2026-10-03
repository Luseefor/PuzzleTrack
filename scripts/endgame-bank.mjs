import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
export const sha256 = text => createHash('sha256').update(text).digest('hex');
export function positionKey(row) {
  const chess=new Chess(row.FEN),m=row.Moves.split(' ')[0];
  chess.move({from:m.slice(0,2),to:m.slice(2,4),...(m[4]?{promotion:m[4]}:{})});
  return chess.fen().split(' ').slice(0,4).join(' ');
}

/** Deterministic daily selection from unused IDs, independent of source row order. */
export function dailyPool(bank, date, previousPools = [], count = 200) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(count) || count < 1 || count > 2000) throw new Error('Invalid daily pool date/count.');
  const used = new Set(previousPools.flatMap(p => p.puzzles.map(row => row.PuzzleId)));
  const usedPositions = new Set(previousPools.flatMap(p => p.puzzles.map(positionKey)));
  const eligible = bank.puzzles.filter(row => !used.has(row.PuzzleId) && !usedPositions.has(positionKey(row)));
  const hash = sha256(JSON.stringify(bank));
  const ranked = eligible.map(row => ({row, key: sha256(`${hash}:${date}:${row.PuzzleId}`)}))
    .sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const puzzles=[],chosenPositions=new Set();
  for(const {row} of ranked){const key=positionKey(row);if(chosenPositions.has(key))continue;chosenPositions.add(key);puzzles.push(row);if(puzzles.length===count)break;}
  if(puzzles.length<count)throw new Error(`Bank has ${puzzles.length} unused distinct positions; ${count} needed. Prepare a larger bank; no repeat batch was issued.`);
  return {format:'puzzletrack-local-pool',version:1,source:{...bank.source,
    selection:bank.source.selection + `; daily batch ${date}: ${count} unused distinct positions ordered by SHA-256(bank hash, UTC date, puzzle ID). Previous issued daily IDs and position keys excluded.`,
    bank_sha256:hash, batch_date:date, batch_created_at:new Date().toISOString(),
    daily_algorithm:'sha256-unused-position-order-v2', excluded_ids_sha256:sha256(JSON.stringify([...used].sort())),excluded_positions_sha256:sha256(JSON.stringify([...usedPositions].sort()))}, puzzles};
}
