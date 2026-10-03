import { Chess } from 'chess.js';
import type { PuzzleTrackStore } from '../models/types.js';
import type { TablebaseSnapshot } from '../trainer/types.js';
import { firstMoveBenchmark } from '../trainer/benchmark.js';
import { summarizeSearch } from './searchCapture.js';
export interface TablebaseSidecar {
  format: 'puzzletrack-tablebase-benchmarks'; version: 1; method: 'initial-position-wdl-v1';
  pool_sha256: string; positions: Record<string,TablebaseSnapshot>; failures: unknown[]; prepared_at: string;
}
export async function analyzeTablebase(store:PuzzleTrackStore,sidecar:TablebaseSidecar) {
  if(sidecar.format!=='puzzletrack-tablebase-benchmarks'||sidecar.version!==1||sidecar.method!=='initial-position-wdl-v1'||!/^[a-f0-9]{64}$/.test(sidecar.pool_sha256)||!sidecar.positions)throw new Error('Unsupported benchmark sidecar.');
  const pool=store.localPools?.[sidecar.pool_sha256];
  if(!pool)throw new Error('Backup does not contain the sidecar frozen pool; use the matching backup.');
  const hash=async(raw:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(await hash(pool.raw_json)!==sidecar.pool_sha256 || JSON.stringify(JSON.parse(pool.raw_json))!==JSON.stringify(pool.data))throw new Error('Frozen pool checksum/data is inconsistent.');
  for(const [fen,snapshot] of Object.entries(sidecar.positions)){
    if(snapshot.fen!==fen||snapshot.url!=='https://tablebase.lichess.ovh/standard?fen='+encodeURIComponent(fen)||!Number.isFinite(Date.parse(snapshot.retrieved_at))||await hash(snapshot.raw)!==snapshot.sha256)throw new Error('Tablebase snapshot identity/checksum is inconsistent.');
    const data=JSON.parse(snapshot.raw) as {moves?:{uci:string;category:string}[]};if(!data.moves?.length)throw new Error('Tablebase snapshot has no move list.');
    for(const m of data.moves){const chess=new Chess(fen);chess.move({from:m.uci.slice(0,2),to:m.uci.slice(2,4),...(m.uci[4]?{promotion:m.uci[4]}:{})});}
  }
  const rows=Object.values(store.attempts).filter(a=>a.ended_at!==null&&a.local_trial?.pool_sha256===sidecar.pool_sha256).map(a=>{
    const t=a.local_trial!,snapshot=sidecar.positions[t.presented_fen],events=(store.researchEvents?.[a.attempt_id]??[]).filter(e=>e.kind!=='benchmark'&&(e.step_number??1)===1),search=summarizeSearch(events);
    const decision=events.find(e=>e.kind==='decision'),candidate=events.find(e=>e.kind==='candidate');
    const actual=t.plies.find(p=>p.actor==='participant')?.uci??null;
    const binding=decision?.kind==='decision' && actual!==null && decision.move===actual;
    const wdl=firstMoveBenchmark({...t,...(snapshot?{initial_tablebase:snapshot}:{})});
    // Do not fall back to trial snapshots from a different provenance when a sidecar entry is absent.
    const regret=snapshot && binding?wdl.first_move_wdl_regret:null;
    const paired=candidate?.kind==='candidate' && decision?.kind==='decision' && candidate.elapsed_ms<=decision.elapsed_ms;
    const proxy=paired && regret!==null?search.first_candidate===search.final_choice&&search.stop_reason==='satisfied'&&regret:null;
    return {attempt_id:a.attempt_id,session_id:a.session_id,participant_id:store.sessions[a.session_id]?.participant_id??null,puzzle_id:t.puzzle_id,source_rating:t.rating,elapsed_ms:a.elapsed_ms,time_limit_seconds:a.time_limit_seconds,outcome:t.outcome,...search,decision_matches_actual_move:binding,
      solver_wdl:snapshot&&binding?wdl.first_move_solver_wdl:null,best_wdl:snapshot?wdl.first_move_best_wdl:null,wdl_regret:regret,satisfied_stopping_wdl_proxy:proxy,
      unavailable_reason:!snapshot?'missing benchmark':!binding?'missing or inconsistent decision/move':regret===null?'ambiguous or unrecognized tablebase category':!paired?'missing or late candidate':null,benchmark_sha256:snapshot?.sha256??null};
  });
  return {format:'puzzletrack-tablebase-analysis-v1',scope:'Finished attempts using the exact sidecar pool; aborts/timeouts retained, no missing values imputed.',pool_sha256:sidecar.pool_sha256,rows,coverage:{attempts:rows.length,wdl_regret_available:rows.filter(r=>r.wdl_regret!==null).length,proxy_available:rows.filter(r=>r.satisfied_stopping_wdl_proxy!==null).length},failures:sidecar.failures,
    formula:'First candidate must precede/equal initial decision. Proxy = candidate == actual/final choice AND stop_reason == satisfied AND chosen solver WDL rank < best rank. loss=0,draw=1,win=2; invert child perspective; other categories => null. All required inputs must exist.',
    limitations:'Outcome-class proxy only; no within-class better-move measure or validated cognitive diagnosis. Not a calibrated skill score. Review raw tablebase output, source binding and protocol.'};
}
