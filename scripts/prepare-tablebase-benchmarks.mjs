// Preparation only: public positions are sent to the tablebase API, never participant IDs or responses.
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Chess} from 'chess.js';
const [input,output]=process.argv.slice(2);
if(!input||!output)throw new Error('Usage: npm run benchmarks:prepare -- FROZEN-POOL.json NEW-SIDECAR.json');
const text=readFileSync(input,'utf8'),pool=JSON.parse(text),sha=s=>createHash('sha256').update(s).digest('hex');
if(pool.format!=='puzzletrack-local-pool'||!Array.isArray(pool.puzzles)||pool.puzzles.length>2000)throw new Error('Use a frozen local pool containing at most 2000 puzzles.');
const positions={},failures=[];
for(const row of pool.puzzles){
 const chess=new Chess(row.FEN),move=row.Moves.split(' ')[0];
 chess.move({from:move.slice(0,2),to:move.slice(2,4),...(move[4]?{promotion:move[4]}:{})});
 const fen=chess.fen();if(positions[fen])continue;
 if(chess.board().flat().filter(Boolean).length>7||fen.split(' ')[2]!=='-'){failures.push({fen,puzzle_id:row.PuzzleId,reason:'unsupported piece count/castling'});continue;}
 const url='https://tablebase.lichess.ovh/standard?fen='+encodeURIComponent(fen);
 await new Promise(resolve=>setTimeout(resolve,1000));
 try{
  const response=await fetch(url,{signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error('HTTP '+response.status);
  const raw=await response.text(),data=JSON.parse(raw);if(!Array.isArray(data.moves)||!data.moves.length)throw new Error('No legal-move tablebase response.');
  positions[fen]={fen,url,retrieved_at:new Date().toISOString(),raw,sha256:sha(raw)};
 }catch(error){failures.push({fen,puzzle_id:row.PuzzleId,reason:String(error.message)});}
}
const sidecar={format:'puzzletrack-tablebase-benchmarks',version:1,method:'initial-position-wdl-v1',pool_sha256:sha(text),positions,failures,prepared_at:new Date().toISOString(),interpretation:'Initial-position WDL only; child categories have opposite side-to-move perspective. No invented CP or within-class quality estimate.'};
writeFileSync(output,JSON.stringify(sidecar,null,2)+'\n',{flag:'wx'});
console.log(`Archived ${Object.keys(positions).length}/${pool.puzzles.length} positions; ${failures.length} failures preserved. Original pool unchanged. ${output}`);
