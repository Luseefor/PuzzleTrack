import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { emptyStore } from '../src/models/types.js';
import { beginLocalSession, closeLocalTrial, freezeTrainingPool, makeLocalPlan, startLocalTrial, localChoice, type LocalSetup } from '../src/trainer/localTrainer.js';
import { buildMeasurementAudit } from '../src/research/measurementAudit.js';
import { recordBenchmark, summarizeSearch } from '../src/research/searchCapture.js';
const T=Date.parse('2026-10-02T14:00:00Z');
async function trial() {
  const pool=await freezeTrainingPool(readFileSync('extension/assets/pilot-pool.json','utf8'));
  const setup:LocalSetup={participant:'AUDIT_TEST',protocol:'test',seed:'audit',min:1,max:1,ratingMin:400,ratingMax:2600,seconds:900,skill:null,skillSource:''};
  const store=emptyStore(), session=beginLocalSession(store,pool,setup,await makeLocalPlan(pool,setup),T);
  const a=startLocalTrial(store,session.session_id,T);
  return {store,a};
}
describe('transparent measurement audit',()=>{
  it('preserves data, counts aborted missing records, and does not turn unknowns into false',async()=>{
    const {store,a}=await trial();closeLocalTrial(store,a.attempt_id,T+500,true);
    const before=JSON.stringify(store),audit=buildMeasurementAudit(store);
    expect(JSON.stringify(store)).toBe(before);
    expect(audit.finished_attempts).toBe(1);
    expect(audit.records[0]!.first_step_cp_proxy).toBeNull();
    expect(audit.records[0]!.first_step_wdl_proxy).toBeNull();
    expect(audit.measures.find(m=>m.id==='reported_skill')?.available).toBe(0);
    expect(audit.warning_groups.map(g=>g.code)).toContain('search-measures-missing');
    expect(audit.measures.find(m=>m.id==='cognition')?.available).toBe(0);
  });
  it('does not let a later candidate fill initial-position missingness in CSV or validation',async()=>{
    const {store,a}=await trial();const move=a.local_trial!.solution_uci[0]!;
    localChoice(store,a.attempt_id,move,'candidate','other',T+100);
    localChoice(store,a.attempt_id,move,'decision','satisfied',T+200);
    if(!a.ended_at)closeLocalTrial(store,a.attempt_id,T+500,true);
    const candidate=store.researchEvents![a.attempt_id]!.find(e=>e.kind==='candidate')!;candidate.step_number=2;
    expect(summarizeSearch(store.researchEvents![a.attempt_id]!).first_candidate).toBeNull();
    const audit=buildMeasurementAudit(store);
    expect(audit.records[0]!.stopped_satisfied_on_first_candidate).toBeNull();
    expect(audit.validation.warnings.some(w=>w.code==='search-measures-missing')).toBe(true);
  });
  it('requires a benchmark and exposes the strict CP threshold and proxy independently',async()=>{
    const {store,a}=await trial();const move=a.local_trial!.solution_uci[0]!;
    localChoice(store,a.attempt_id,move,'candidate','other',T+100);
    localChoice(store,a.attempt_id,move,'decision','satisfied',T+200);
    if(!a.ended_at)closeLocalTrial(store,a.attempt_id,T+500,true);
    delete a.local_trial!.initial_tablebase;
    expect(buildMeasurementAudit(store).records[0]!.first_step_cp_proxy).toBeNull();
    const input={best_move:move,engine_name:'synthetic',engine_version:'test',configuration:'test only',position_reference:a.local_trial!.presented_fen,chosen_cp:0,best_cp:100,threshold_cp:100};
    recordBenchmark(store,a.attempt_id,input,T+600);
    expect(buildMeasurementAudit(store).records[0]!.first_step_cp_proxy).toBe(false);
    recordBenchmark(store,a.attempt_id,{...input,best_cp:101},T+700);
    const record=buildMeasurementAudit(store).records[0]!;
    expect(record.first_step_cp_proxy).toBe(true);
    expect(record.first_step_search.evaluation_gap_cp).toBe(101);
    expect(record.first_step_wdl_proxy).toBeNull();
    expect(record.calibrated_local_relative_difficulty).toBeNull();
  });
  it('excludes unfinished attempts from coverage denominators without deleting them',async()=>{
    const {store}=await trial(),audit=buildMeasurementAudit(store);
    expect(audit.finished_attempts).toBe(0);expect(audit.in_progress_attempts).toBe(1);
    expect(audit.measures.every(m=>m.denominator===0)).toBe(true);
    expect(Object.keys(store.attempts)).toHaveLength(1);
  });
});
