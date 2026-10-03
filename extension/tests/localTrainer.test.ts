import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { beginLocalSession, closeLocalTrial, freezeTrainingPool, localChoice, makeLocalPlan, preparePosition, startLocalTrial, visibleTrial, type LocalSetup } from '../src/trainer/localTrainer.js';
import { firstMoveBenchmark } from '../src/trainer/benchmark.js';
import { emptyStore } from '../src/models/types.js';
import { validateStore } from '../src/validation/pilotValidator.js';
import { buildBackup, serializeBackup, parseBackup } from '../src/export/jsonBackup.js';
import { attemptsToCsv } from '../src/export/csv.js';
import { createStudyPlan } from '../src/research/studyPlan.js';
const raw=readFileSync('extension/assets/pilot-pool.json','utf8');
const T=Date.parse('2026-10-02T14:00:00Z');
const setup:LocalSetup={participant:'AI_TEST',protocol:'endgame-test-v1',seed:'test-local',min:1,max:1,ratingMin:400,ratingMax:2600,seconds:900,skill:1400,skillSource:'self-reported:lichess-puzzles'};
async function trial(){const pool=await freezeTrainingPool(raw),plan=await makeLocalPlan(pool,setup),store=emptyStore();const session=beginLocalSession(store,pool,setup,plan,T);const a=startLocalTrial(store,session.session_id,T);return {store,a,session,pool};}
describe('offline endgame research trainer',()=>{
 it('supports ten puzzles with a single 20-minute session limit and replayable difficulty draw',async()=>{
  const pool=await freezeTrainingPool(raw),config={...setup,min:10,max:10,seconds:1200},plan=await makeLocalPlan(pool,config),store=emptyStore();
  const session=beginLocalSession(store,pool,config,plan,T);
  expect(plan.ordered_puzzles).toHaveLength(10);
  expect(new Set(plan.ordered_puzzles.map(p=>p.id)).size).toBe(10);
  expect(plan.time_assignment).toBeUndefined();
  expect(await createStudyPlan(plan.pool!,plan.seed,10,10)).toEqual(plan);
  for(let i=0;i<10;i++) {
    const a=startLocalTrial(store,session.session_id,T+i*2000);
    expect(a.time_limit_seconds).toBe(1200);
    closeLocalTrial(store,a.attempt_id,T+i*2000+1000,true);
  }
  expect(session.status).toBe('completed');
  expect(validateStore(store).errors).toEqual([]);
 });

 it('detects an exposure assignment that contradicts saved exclusions',async()=>{
  const {store,a,session}=await trial();
  session.study!.excluded_position_keys=[a.local_trial!.presented_fen.split(' ').slice(0,4).join(' ')];
  expect(validateStore(store).errors.some(e=>e.code==='study-repeated-exposure')).toBe(true);
  session.study!.excluded_puzzle_ids=[a.local_trial!.puzzle_id];
  expect(validateStore(store).errors.some(e=>e.code==='study-excluded-pool')).toBe(true);
 });
 it('excludes previously presented IDs and freezes the eligible set and exclusion history',async()=>{
  const pool=await freezeTrainingPool(raw),excluded=pool.data.puzzles.slice(0,5).map(p=>p.PuzzleId!);
  const config={...setup,min:10,max:15,excludedPuzzleIds:excluded},plan=await makeLocalPlan(pool,config),store=emptyStore();
  expect(plan.pool!.some(p=>excluded.includes(p.id))).toBe(false);
  expect(await createStudyPlan(plan.pool!,plan.seed,plan.count_min,plan.count_max)).toEqual(plan);
  const session=beginLocalSession(store,pool,config,plan,T);
  expect(session.study!.excluded_puzzle_ids).toEqual([...excluded].sort());
  expect(parseBackup(serializeBackup(buildBackup(store))).sessions[session.session_id]!.study!.excluded_puzzle_ids).toEqual([...excluded].sort());
  await expect(makeLocalPlan(pool,{...setup,excludedPuzzleIds:pool.data.puzzles.map(p=>p.PuzzleId!)})).rejects.toThrow();
  const key=preparePosition(pool.data.puzzles[0]!).presentedFen.split(' ').slice(0,4).join(' ');
  expect((await makeLocalPlan(pool,{...setup,excludedPositionKeys:[key]})).pool!.some(p=>p.id===pool.data.puzzles[0]!.PuzzleId)).toBe(false);
 });
 it('validates all frozen FENs and full legal reference lines after the preceding opponent move',async()=>{
  const pool=await freezeTrainingPool(raw);expect(pool.data.puzzles).toHaveLength(24);
  for(const row of pool.data.puzzles){const p=preparePosition(row);const c=new Chess(p.presentedFen);expect(c.board().flat().filter(Boolean).length).toBeLessThanOrEqual(7);expect(p.solution[0]).toBe(row.Moves!.split(' ')[1]);}
 });
 it('replays seed, filtered difficulty, count, order and full raw source archive',async()=>{
  const {session,pool}=await trial();const plan=session.study!.plan!;
  expect(await createStudyPlan(plan.pool!,plan.seed,plan.count_min,plan.count_max)).toEqual(plan);
  expect(session.study!.local_pool_sha256).toBe(pool.sha256);
  expect((await makeLocalPlan(pool,{...setup,ratingMin:1000,ratingMax:1700})).ordered_puzzles.every(p=>p.rating>=1000&&p.rating<=1700)).toBe(true);
  await expect(makeLocalPlan(pool,{...setup,min:100,max:100})).rejects.toThrow();
 });
 it('runs one clock across participant turns, opponent replies and a complete solution',async()=>{
  const {store,a,session}=await trial();let at=T;
  while(!a.ended_at){const t=a.local_trial!,step=t.participant_step,move=t.solution_uci[t.solution_index]!;at+=1234;localChoice(store,a.attempt_id,move,'candidate','other',at);at+=567;localChoice(store,a.attempt_id,move,'decision','satisfied',at);if(!a.ended_at)expect(t.participant_step).toBe(step+1);}
  expect(a.local_trial!.outcome).toBe('solved');expect(a.elapsed_ms).toBe(at-T);expect(a.experimental_result).toBe('completed');expect(session.status).toBe('completed');
  expect(a.local_trial!.plies.filter(p=>p.actor==='participant').length).toBe(store.researchEvents![a.attempt_id]!.filter(e=>e.kind==='decision').length);
  expect(validateStore(store).errors).toEqual([]);
 });
 it('replays random time conditions independently of puzzle order and preserves them across recovery and exports',async()=>{
  const pool=await freezeTrainingPool(raw),config={...setup,min:12,max:24,timeOptions:[900,1800,2700,3600]};
  const {timeOptions, ...fixedConfig}=config;
  const plan=await makeLocalPlan(pool,config),fixed=await makeLocalPlan(pool,fixedConfig);
  expect({...plan,time_assignment:undefined}).toEqual({...fixed,time_assignment:undefined});
  expect(await createStudyPlan(plan.pool!,plan.seed,plan.count_min,plan.count_max,[3600,900,2700,1800,900])).toEqual(plan);
  expect(new Set(plan.ordered_puzzles.map(p=>p.id)).size).toBe(plan.ordered_puzzles.length);
  expect(new Set(plan.time_assignment!.ordered_seconds).size).toBeGreaterThan(1);
  expect(new Set(plan.ordered_puzzles.map(p=>p.rating)).size).toBeGreaterThan(1);
  let store=emptyStore();const session=beginLocalSession(store,pool,config,plan,T);
  for(const [i,seconds] of plan.time_assignment!.ordered_seconds.entries()){
   const at=T+i*4_000_000,a=startLocalTrial(store,session.session_id,at);
   expect(a.time_limit_seconds).toBe(seconds);
   store=parseBackup(serializeBackup(buildBackup(store,at+100)));
   expect(store.attempts[a.attempt_id]!.time_limit_seconds).toBe(seconds);
   expect(store.sessions[session.session_id]!.study!.plan).toEqual(plan);
   closeLocalTrial(store,a.attempt_id,at+seconds*1000+4567);
   const saved=store.attempts[a.attempt_id]!;
   expect(saved.elapsed_ms).toBe(seconds*1000);expect(saved.ended_at).toBe(new Date(at+seconds*1000).toISOString());
   expect(saved.local_trial!.outcome).toBe('timeout');
  }
  expect(validateStore(store).errors).toEqual([]);
  const rows=Object.values(store.attempts),csv=attemptsToCsv(new Map([[session.session_id,'AI_TEST']]),rows,store);
  expect(csv.split('\n').length).toBeGreaterThan(rows.length);
  store.attempts[rows[0]!.attempt_id]!.time_limit_seconds=123;
  expect(validateStore(store).errors.some(e=>e.code==='study-time-mismatch')).toBe(true);
 });
 it('rejects unsupported time assignments and refuses incomplete plans before starting a trial',async()=>{
  const pool=await freezeTrainingPool(raw);
  await expect(makeLocalPlan(pool,{...setup,timeOptions:[]})).rejects.toThrow();
  await expect(makeLocalPlan(pool,{...setup,timeOptions:[120]})).rejects.toThrow();
  await expect(makeLocalPlan(pool,{...setup,timeOptions:[Number.NaN]})).rejects.toThrow();
  const config={...setup,timeOptions:[900,1800]},plan=await makeLocalPlan(pool,config),store=emptyStore();
  const session=beginLocalSession(store,pool,config,plan,T);plan.time_assignment!.ordered_seconds=[];
  expect(()=>startLocalTrial(store,session.session_id,T)).toThrow('cover every');
  expect(Object.values(store.attempts)).toHaveLength(0);expect(store.activeAttemptId).toBeNull();
  expect(validateStore(store).errors.some(e=>e.code==='study-plan-times')).toBe(true);
 });
 it('records an incorrect legal move and stop reason, without fabricating centipawn regret',async()=>{
  const {store,a}=await trial(),t=a.local_trial!;
  const wrong=new Chess(t.current_fen).moves({verbose:true}).find(m=>m.from+m.to+(m.promotion??'')!==t.solution_uci[0]&&!m.san.endsWith('#'))!;
  localChoice(store,a.attempt_id,wrong.from+wrong.to+(wrong.promotion??''),'decision','time_pressure',T+4567);
  expect(t.outcome).toBe('incorrect');expect(a.elapsed_ms).toBe(4567);expect(t.selected_uci).toBe(wrong.from+wrong.to+(wrong.promotion??''));expect(t.plies[0]!.reference_match).toBe(false);
 });
 it('rejects illegal moves and per-step repeated decisions without changing the trial',async()=>{
  const {store,a}=await trial();expect(()=>localChoice(store,a.attempt_id,'a1a8','candidate','other',T+1000)).toThrow();expect(a.local_trial!.plies).toHaveLength(0);expect(a.ended_at).toBeNull();
 });
 it('times out exactly at the deadline even if a choice or callback arrives later',async()=>{
  const {store,a}=await trial();localChoice(store,a.attempt_id,a.local_trial!.solution_uci[0]!,'decision','satisfied',T+905000);
  expect(a.local_trial!.outcome).toBe('timeout');expect(a.experimental_result).toBe('timeout');expect(a.elapsed_ms).toBe(900000);expect(a.local_trial!.plies).toHaveLength(0);
  expect(validateStore(store).errors).toEqual([]);
 });
 it('keeps abort distinct from timeout and solving result',async()=>{const {store,a}=await trial();closeLocalTrial(store,a.attempt_id,T+2345,true);expect(a.local_trial!.outcome).toBe('aborted');expect(a.experimental_result).toBe('aborted');expect(a.elapsed_ms).toBe(2345);});
 it('does not reveal the reference sequence through the participant text hook before completion',async()=>{const {a}=await trial();expect(visibleTrial(a.local_trial!,false)).not.toHaveProperty('reference_move');expect(visibleTrial(a.local_trial!,true)).toHaveProperty('reference_move');});
 it('retains local ratings, source hash, raw positions, moves, and search steps through JSON and CSV',async()=>{
  const {store,a,session}=await trial();const move=a.local_trial!.solution_uci[0]!;localChoice(store,a.attempt_id,move,'candidate','other',T+101);localChoice(store,a.attempt_id,move,'decision','satisfied',T+202);
  if(!a.ended_at)closeLocalTrial(store,a.attempt_id,T+300,true);
  expect(parseBackup(serializeBackup(buildBackup(store,T+400)))).toEqual(store);
  const csv=attemptsToCsv(new Map([[session.session_id,'AI_TEST']]),[a],store);
  expect(csv).toContain('local_trial');expect(csv).toContain('lichess-puzzles');expect(csv).toContain('endgame-puzzle-sequence-v1');expect(csv).toContain('step_number');
 });
 it('accepts an alternate immediate checkmate instead of rejecting a valid mate',async()=>{
  const data=JSON.parse(raw);data.puzzles=[{PuzzleId:'synthetic-mate',FEN:'8/5K1k/6Q1/8/8/8/8/8 b - - 0 1',Moves:'h7h8 g6g7',Rating:'1000',RatingDeviation:'50',Themes:'endgame mateIn1'}];delete data.initial_tablebases;
  const pool=await freezeTrainingPool(JSON.stringify(data)),plan=await makeLocalPlan(pool,setup),store=emptyStore();const session=beginLocalSession(store,pool,setup,plan,T),a=startLocalTrial(store,session.session_id,T);
  localChoice(store,a.attempt_id,'g6h6','decision','satisfied',T+321);expect(a.local_trial!.outcome).toBe('solved');expect(a.local_trial!.reference_match).toBe(false);expect(a.local_trial!.alternative_checkmate).toBe(true);
 });
 it('plays promotion sequences and records the UCI promotion suffix',async()=>{
  const data=JSON.parse(raw);data.puzzles=[data.puzzles.find((p:{PuzzleId:string})=>p.PuzzleId==='00iQD')];
  const pool=await freezeTrainingPool(JSON.stringify(data)),plan=await makeLocalPlan(pool,setup),store=emptyStore();const session=beginLocalSession(store,pool,setup,plan,T),a=startLocalTrial(store,session.session_id,T);let at=T;
  while(!a.ended_at){at+=100;localChoice(store,a.attempt_id,a.local_trial!.solution_uci[a.local_trial!.solution_index]!,'decision','satisfied',at);}
  expect(a.local_trial!.outcome).toBe('solved');expect(a.local_trial!.plies.some(p=>p.uci==='h2h1q')).toBe(true);
 });
 it('keeps tablebase outcomes in solver perspective and does not invent centipawns',async()=>{
  const {store,a}=await trial(); const t=a.local_trial!;
  expect(firstMoveBenchmark(t).first_move_wdl_regret).toBeNull();
  localChoice(store,a.attempt_id,t.solution_uci[0]!,'decision','satisfied',T+100);
  const snapshot=t.initial_tablebase!;
  const original=snapshot.raw;
  snapshot.raw=JSON.stringify({moves:[{uci:'a1a2',category:'loss'},{uci:t.plies[0]!.uci,category:'draw'}]});
  expect(firstMoveBenchmark(t)).toEqual({first_move_solver_wdl:'draw',first_move_best_wdl:'win',first_move_wdl_regret:true});
  snapshot.raw=JSON.stringify({moves:[{uci:t.plies[0]!.uci,category:'cursed-win'}]});expect(firstMoveBenchmark(t).first_move_wdl_regret).toBeNull();snapshot.raw=original;
 });
 it('detects changed local ratings and move timing without repairing raw records',async()=>{const {store,a}=await trial();a.local_trial!.rating++;expect(validateStore(store).errors.some(e=>e.code==='local-source-mismatch')).toBe(true);});
 it('refuses corrupt and unlicensed pools instead of guessing a position',async()=>{await expect(freezeTrainingPool('{}')).rejects.toThrow();const bad=JSON.parse(raw);bad.puzzles[0].Moves='a1a8';await expect(freezeTrainingPool(JSON.stringify(bad))).rejects.toThrow();const altered=JSON.parse(raw);(Object.values(altered.initial_tablebases)[0] as {raw:string}).raw='{}';await expect(freezeTrainingPool(JSON.stringify(altered))).rejects.toThrow();bad.source.license='unknown';await expect(freezeTrainingPool(JSON.stringify(bad))).rejects.toThrow();});
});
