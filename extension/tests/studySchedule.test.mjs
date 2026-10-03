import { describe,it,expect } from 'vitest';
import {readFileSync} from 'node:fs';
import { scheduleStatus,scheduledPool,validateSchedule } from '../../scripts/study-schedule.mjs';
import { freezeTrainingPool,makeLocalPlan,beginLocalSession,startLocalTrial,closeLocalTrial } from '../src/trainer/localTrainer.ts';
import { emptyStore } from '../src/models/types.ts';
import { attemptsToCsv } from '../src/export/csv.ts';
import { positionKey } from '../../scripts/endgame-bank.mjs';
const draft=JSON.parse(readFileSync('config/study-schedule.json'));
const starter=JSON.parse(readFileSync('extension/assets/pilot-pool.json'));
// Synthetic rating bands over distinct legal fixture positions, never research data.
const bank={...starter,puzzles:starter.puzzles.map((r,i)=>({...r,Rating:String(i<12?500+i:2000+i)}))};
const open={...draft,enabled:true,start_date:'2026-10-02',opens:'12:00',closes:'18:00'};
const now=Date.parse('2026-10-02T18:00:00Z');
function pilot(){return {...scheduleStatus(draft,now),state:'pilot-review',day_index:1,assignment:draft.days[0]};}
describe('scheduled study/pilot issuance',()=>{
 it('keeps pilot hours inactive until actual study times are supplied',()=>{
  expect(scheduleStatus(draft,now).state).toBe('draft');
  expect(()=>validateSchedule({...draft,enabled:true})).toThrow('start date');
  expect(()=>scheduledPool(bank,scheduleStatus(draft,now),[],'P01')).toThrow('outside');
 });
 it('enforces timezone, dates, half-open access windows and sufficient duration',()=>{
  expect(scheduleStatus(open,now).state).toBe('open');
  expect(scheduleStatus(open,Date.parse('2026-10-02T16:59:59Z')).state).toBe('closed');
  expect(scheduleStatus(open,Date.parse('2026-10-02T23:00:00Z')).state).toBe('closed');
  expect(scheduleStatus(open,Date.parse('2026-10-01T18:00:00Z')).state).toBe('before-study');
  expect(scheduleStatus(open,Date.parse('2026-10-14T18:00:00Z')).state).toBe('after-study');
  expect(()=>validateSchedule({...open,closes:'14:00'})).toThrow('too short');
  expect(()=>validateSchedule({...open,start_date:'2026-02-30'})).toThrow('start date');
  expect(()=>scheduledPool(bank,scheduleStatus(open,Date.parse('2026-10-02T23:00:00Z')),[],'P01')).toThrow('outside');
 });
 it('allocates exactly 5 easy/5 hard; different participants get no shared positions; replay is identical',()=>{
  const status=pilot(),a=scheduledPool(bank,status,[],'P01');
  expect(a.puzzles).toHaveLength(10);
  expect(a.puzzles.filter(r=>Number(r.Rating)<=1399)).toHaveLength(5);
  expect(a.puzzles.filter(r=>Number(r.Rating)>=1800)).toHaveLength(5);
  expect(scheduledPool(bank,status,[],'P01').puzzles).toEqual(a.puzzles);
  const b=scheduledPool(bank,status,[a],'P02');
  const keys=new Set(a.puzzles.map(positionKey));expect(b.puzzles.some(r=>keys.has(positionKey(r)))).toBe(false);
  expect(b.source.participant_seed).not.toBe(a.source.participant_seed);
  expect(b.source.batch_code).not.toBe(a.source.batch_code);
  expect(a.source.study_phase).toBe('pilot_review');
 });
 it('rejects exhausted quotas instead of substituting easier or repeated puzzles',()=>{
  expect(()=>scheduledPool({...bank,puzzles:bank.puzzles.filter(r=>Number(r.Rating)<1800)},pilot(),[],'P01')).toThrow('Band hard');
  expect(()=>scheduledPool(bank,pilot(),[],'../escape')).toThrow('participant ID');
  expect(()=>validateSchedule({...draft,days:[{seconds:900,quotas:{easy:5,hard:4}}]})).toThrow('exactly 10');
  expect(()=>validateSchedule({...draft,bands:[draft.bands[0],{id:'hard',min:1399,max:2600}]})).toThrow('overlap');
 });
 it('validates frozen quotas/hash and participant/time binding, and exports practice provenance',async()=>{
  const issued=scheduledPool(bank,pilot(),[],'P01'),pool=await freezeTrainingPool(JSON.stringify(issued));
  const setup={participant:'P01',protocol:'pilot',seed:issued.source.participant_seed,min:10,max:10,ratingMin:400,ratingMax:2600,seconds:900,skill:null,skillSource:'',practiceMinutes:0,practiceNotes:'none reported'};
  const plan=await makeLocalPlan(pool,setup),store=emptyStore();
  expect(()=>beginLocalSession(store,pool,{...setup,participant:'P02'},plan,now)).toThrow('mismatch');
  expect(()=>beginLocalSession(store,pool,{...setup,seconds:1200},plan,now)).toThrow('mismatch');
  const session=beginLocalSession(store,pool,setup,plan,now),a=startLocalTrial(store,session.session_id,now);
  closeLocalTrial(store,a.attempt_id,now+500,true);
  expect(session.study.practice_report.minutes).toBe(0);
  expect(session.study.practice_report.method).toContain('self-report');
  const csv=attemptsToCsv(new Map([[session.session_id,'P01']]),[a],store);
  expect(csv).toContain('schedule_sha256');expect(csv).toContain('pilot_review');expect(csv).toContain('none reported');
  const broken=structuredClone(issued);broken.source.schedule_json+=' ';
  await expect(freezeTrainingPool(JSON.stringify(broken))).rejects.toThrow('checksum');
  const quota=structuredClone(issued);quota.puzzles[0].Rating='1700';
  await expect(freezeTrainingPool(JSON.stringify(quota))).rejects.toThrow('quota');
 });
 it('uses explicit day conditions and rejects nonexistent daylight-saving window hours',()=>{
  const next=scheduleStatus(open,Date.parse('2026-10-03T18:00:00Z'));
  expect(next.assignment).toEqual({seconds:1200,quotas:{easy:0,hard:10}});
  expect(next.day_index).toBe(2);
  expect(()=>scheduleStatus({...open,start_date:'2026-03-08',opens:'02:30',closes:'12:00'},Date.parse('2026-03-08T18:00:00Z'))).toThrow('daylight-saving');
 });
});
