import {describe,it,expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {emptyStore} from '../src/models/types.js';
import {freezeTrainingPool,preparePosition,beginLocalSession,startLocalTrial,localChoice,closeLocalTrial,makeLocalPlan,type LocalSetup} from '../src/trainer/localTrainer.js';
import {analyzeTablebase,type TablebaseSidecar} from '../src/research/tablebaseAnalysis.js';
const raw=readFileSync('extension/assets/pilot-pool.json','utf8'),T=Date.parse('2026-10-02T12:00:00Z');
async function fixture(){
 const pool=await freezeTrainingPool(raw);
 const config:LocalSetup={participant:'ANALYSIS_TEST',protocol:'test',seed:'analysis',min:1,max:1,ratingMin:400,ratingMax:2600,seconds:900,skill:null,skillSource:''};
 const plan=await makeLocalPlan(pool,config),store=emptyStore(),session=beginLocalSession(store,pool,config,plan,T),a=startLocalTrial(store,session.session_id,T);
 const sidecar:TablebaseSidecar={format:'puzzletrack-tablebase-benchmarks',version:1,method:'initial-position-wdl-v1',pool_sha256:pool.sha256,positions:pool.data.initial_tablebases!,failures:[],prepared_at:new Date(T).toISOString()};
 return {store,a,sidecar,pool};
}
describe('read-only WDL benchmark analysis',()=>{
 it('binds exact source and reported move and leaves absent choices unknown without modifying records',async()=>{
  const {store,a,sidecar}=await fixture();closeLocalTrial(store,a.attempt_id,T+500,true);
  const before=JSON.stringify(store),report=await analyzeTablebase(store,sidecar);
  expect(JSON.stringify(store)).toBe(before);expect(report.rows).toHaveLength(1);
  expect(report.rows[0]!.satisfied_stopping_wdl_proxy).toBeNull();
  expect(report.coverage.proxy_available).toBe(0);
  await expect(analyzeTablebase(store,{...sidecar,pool_sha256:'0'.repeat(64)})).rejects.toThrow('matching backup');
 });
 it('reports false only with complete evidence, and keeps absent benchmarks distinct',async()=>{
  const {store,a,sidecar}=await fixture(),move=a.local_trial!.solution_uci[0]!;
  localChoice(store,a.attempt_id,move,'candidate','other',T+100);localChoice(store,a.attempt_id,move,'decision','satisfied',T+200);
  if(!a.ended_at)closeLocalTrial(store,a.attempt_id,T+500,true);
  const report=await analyzeTablebase(store,sidecar);
  expect(report.rows[0]!.decision_matches_actual_move).toBe(true);
  expect(report.rows[0]!.wdl_regret).toBe(false);expect(report.rows[0]!.satisfied_stopping_wdl_proxy).toBe(false);
  const missing=await analyzeTablebase(store,{...sidecar,positions:{}});
  expect(missing.rows[0]!.satisfied_stopping_wdl_proxy).toBeNull();expect(missing.rows[0]!.unavailable_reason).toBe('missing benchmark');
  const d=store.researchEvents![a.attempt_id]!.find(e=>e.kind==='decision')!;d.move='a1a2';
  expect((await analyzeTablebase(store,sidecar)).rows[0]!.satisfied_stopping_wdl_proxy).toBeNull();
 });
 it('rejects altered responses and source data even when parsed JSON is otherwise valid',async()=>{
  const {store,sidecar,pool}=await fixture();
  const corrupt=structuredClone(sidecar),fen=Object.keys(corrupt.positions)[0]!;corrupt.positions[fen]!.raw+=' ';
  await expect(analyzeTablebase(store,corrupt)).rejects.toThrow('checksum');
  pool.data.puzzles[0]!.Rating='1234';
  await expect(analyzeTablebase(store,sidecar)).rejects.toThrow('checksum/data');
 });
});
