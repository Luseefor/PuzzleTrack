// Reuse a locally frozen CC0 reference pool. Keep only <=7-piece solver positions.
// Preflight exact win/draw tablebase coverage, one request per second, before bundling.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
const pool = JSON.parse(readFileSync('extension/assets/pilot-pool.json', 'utf8'));
const selected = [], snapshots = {};
for (const row of pool.puzzles) {
  const chess = new Chess(row.FEN), move = row.Moves.split(' ')[0];
  chess.move({from:move.slice(0,2),to:move.slice(2,4),...(move[4]?{promotion:move[4]}:{})});
  if (chess.board().flat().filter(Boolean).length > 7 || chess.fen().split(' ')[2] !== '-' || chess.isGameOver()) continue;
  const fen = chess.fen();
  await new Promise(resolve => setTimeout(resolve, 1000));
  try {
    const url = 'https://tablebase.lichess.ovh/standard?fen=' + encodeURIComponent(fen);
    const response = await fetch(url, {signal:AbortSignal.timeout(15000)});
    if (!response.ok) throw new Error('HTTP '+response.status);
    const raw = await response.text(), data = JSON.parse(raw);
    if (!['win','draw'].includes(data.category) || !data.moves?.length) continue;
    snapshots[fen] = {fen, url, retrieved_at:new Date().toISOString(), raw, sha256:createHash('sha256').update(raw).digest('hex')};
    selected.push(row); console.log('Covered', selected.length, row.PuzzleId, row.Rating, data.category);
    if (selected.length >= 24) break;
  } catch (error) { console.log('Skipped', row.PuzzleId, error.message); }
}
if (selected.length < 10) throw new Error('Not enough verified positions for the starter pool.');
const headers = Object.keys(selected[0]);
const quote = text => /[",\n\r]/.test(text) ? '"'+text.replaceAll('"','""')+'"' : text;
const csv = headers.join(',')+'\r\n'+selected.map(row=>headers.map(h=>quote(row[h])).join(',')).join('\r\n')+'\r\n';
writeFileSync('extension/assets/pilot-source-rows.csv',csv);
pool.puzzles = selected; pool.initial_tablebases=snapshots;
pool.source.selection += '; then first 24 positions with <=7 pieces after opponent move, no castling rights, playable and verified Syzygy category win/draw. Local endgame puzzle difficulty not calibrated.';
pool.source.raw_rows_sha256 = createHash('sha256').update(csv).digest('hex');
pool.source.tablebase_url = 'https://tablebase.lichess.ovh/standard';
writeFileSync('extension/assets/pilot-pool.json',JSON.stringify(pool,null,2)+'\n');
console.log('Frozen',selected.length,'endgame puzzle pilot positions.');
