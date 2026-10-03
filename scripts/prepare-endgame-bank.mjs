// Usage: npm run bank:prepare -- INPUT.csv.zst [COUNT=5000]
// Stream a downloaded prefix; never query puzzle/tablebase servers during play.
import { spawn } from 'node:child_process';
import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { Chess } from 'chess.js';
import { sha256 } from './endgame-bank.mjs';
const input=process.argv[2], count=Number(process.argv[3]??5000);
if (!input || !Number.isInteger(count) || count<200 || count>20000) throw new Error('Usage: npm run bank:prepare -- INPUT.csv.zst [200–20000 puzzles]');
mkdirSync('data/endgame',{recursive:true});
const sourceHash=createHash('sha256');
for await (const chunk of createReadStream(input)) sourceHash.update(chunk);
const compressedHash=sourceHash.digest('hex');
// Source CSV rows can contain quoted commas. No field contains embedded newlines.
function csv(line) {
  const cells=[];let value='', quoted=false;
  for(let i=0;i<line.length;i++) {const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){cells.push(value);value='';}else value+=c;}
  if(quoted) return null;cells.push(value);return cells;
}
const processZstd=spawn('zstd',['-dc',input],{stdio:['ignore','pipe','pipe']});
let stderr='';processZstd.stderr.on('data',chunk=>stderr+=chunk);
const completion=new Promise((resolve,reject)=>{processZstd.on('error',reject);processZstd.on('close',code=>resolve(code));});
const lines=createInterface({input:processZstd.stdout,crlfDelay:Infinity});
let headers, scanned=0, eligible=0;
// Retain the lowest hash keys across all complete rows, avoiding a first-N sample.
const selected=[]; const seen=new Set(),seenPositions=new Set();let pendingLine;
// Discard the final line: a downloaded prefix can stop inside a CSV row.
for await (const currentLine of lines) {
  const line=pendingLine;pendingLine=currentLine;if(line===undefined)continue;
  const cells=csv(line);if(!cells)continue;
  if(!headers){headers=cells;continue;}
  if(cells.length!==headers.length)continue;
  scanned++;
  const row=Object.fromEntries(headers.map((h,i)=>[h,cells[i]]));
  if(!row.Themes?.split(' ').includes('endgame') || !/^\d+$/.test(row.Rating) || Number(row.Rating)<400 || Number(row.Rating)>2600 || Number(row.RatingDeviation)>100 || Number(row.NbPlays)<100 || Number(row.Popularity)<0 || seen.has(row.PuzzleId))continue;
  let position;
  try {
    const moves=row.Moves.trim().split(/\s+/);if(moves.length<2 || moves.length%2!==0)continue;
    const chess=new Chess(row.FEN);
    const play=uci=>chess.move({from:uci.slice(0,2),to:uci.slice(2,4),...(uci[4]?{promotion:uci[4]}:{})});
    play(moves[0]);
    if(chess.isGameOver()||chess.board().flat().filter(Boolean).length>7||chess.fen().split(' ')[2]!=='-')continue;
    position=chess.fen().split(' ').slice(0,4).join(' ');if(seenPositions.has(position))continue;
    for(const move of moves.slice(1))play(move);
  } catch {continue;}
  seen.add(row.PuzzleId);seenPositions.add(position);eligible++;
  const key=sha256(`${compressedHash}:${row.PuzzleId}`);
  // Keep a sorted bounded sample; this is preparation, never the trial path.
  if(selected.length===count && key>=selected[selected.length-1].key)continue;
  let lo=0,hi=selected.length;while(lo<hi){const mid=(lo+hi)>>>1;if(selected[mid].key<key)lo=mid+1;else hi=mid;}
  selected.splice(lo,0,{key,row});if(selected.length>count)selected.pop();
}
const code=await completion;
if(code!==0&&!/premature|unexpected end|incomplete/i.test(stderr))throw new Error(`zstd failed: ${stderr}`);
if(selected.length<count)throw new Error(`Only ${selected.length} valid puzzles; download a larger prefix or lower COUNT.`);
const bank={format:'puzzletrack-endgame-bank',version:1,source:{url:'https://database.lichess.org/lichess_db_puzzle.csv.zst',license:'CC0-1.0',retrieved_at:new Date().toISOString(),compressed_prefix_sha256:compressedHash,
  selection:`Lowest SHA-256(prefix hash, ID) ${count} of ${eligible} eligible distinct solver positions among ${scanned} complete CSV rows; first eligible row per position key (FEN first four fields). Downloaded prefix sample, not the full population. Endgame theme; source rating 400–2600; RD <=100; plays >=100; popularity >=0; <=7 pieces after opponent move; no castling; complete legal puzzle sequence. Initial tablebase benchmarks not fetched.`,
  source_complete:String(code===0)},puzzles:selected.map(p=>p.row)};
const text=JSON.stringify(bank)+'\n',hash=sha256(text);
// Preserve every previous snapshot before switching the current bank pointer.
writeFileSync(`data/endgame/bank-${hash}.json`,text);
writeFileSync('data/endgame/bank.json',text);
console.log(`Prepared ${count} puzzles from ${eligible} eligible / ${scanned} rows. SHA-256 ${hash}. Daily batches will retain original ratings and source rows.`);
