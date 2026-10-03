import { describe, expect, it, vi } from 'vitest';
import { emptyStore } from '../src/models/types.js';
import { createSession, startAttempt, completeAttempt, timeoutAttempt, recordFocusSignal } from '../src/session/sessionManager.js';
import { Repository, mergeStores } from '../src/storage/repository.js';
import { MemoryStorageAdapter } from '../src/storage/storageAdapter.js';
import { parseChessTempoCsv } from '../src/importer/chesstempoImporter.js';
import { parseRating, parseResult, parseTimeUsed } from '../src/integrations/chessTempo/chessTempoParser.js';
import { handleSiteEvent } from '../src/integrations/autoController.js';
import { validateStore } from '../src/validation/pilotValidator.js';
import { ChessTempoAdapter } from '../src/integrations/chessTempo/chessTempoAdapter.js';
import type { PageReading, SiteEvent } from '../src/integrations/chessTempo/chessTempoTypes.js';
import { createStudyPlan, parseStudyPool } from '../src/research/studyPlan.js';
import { recordSearchChoice, recordBenchmark, summarizeSearch } from '../src/research/searchCapture.js';
import { buildBackup, parseBackup, serializeBackup } from '../src/export/jsonBackup.js';
import { attemptsToCsv } from '../src/export/csv.js';
import { isCorrectChessTempoResult } from '../src/analysis/derived.js';

const T = Date.parse('2026-10-02T12:00:00Z');
function trial() {
  const store = emptyStore(), session = createSession(store, 'TEST', 1, 900, T);
  const attempt = startAttempt(store, session.session_id, T);
  return { store, session, attempt };
}

describe('research timing and persistence regressions', () => {
  it('uses the deadline for a delayed timeout and ignores later focus time', () => {
    const {store,attempt} = trial();
    recordFocusSignal(store,attempt.attempt_id,'window_blur',T+899000);
    recordFocusSignal(store,attempt.attempt_id,'window_focus',T+905000);
    timeoutAttempt(store,attempt.attempt_id,T+905000);
    expect(Date.parse(attempt.ended_at!)-T).toBe(900000);
    expect(attempt.elapsed_ms).toBe(900000);
    expect(attempt.total_time_away_ms).toBe(1000);
    // The post-deadline raw event remains available and must be reviewed.
    expect(validateStore(store).errors.some(e=>e.code==='events-after-end')).toBe(true);
  });
  it('cannot complete beyond the deadline or timeout early', () => {
    const {store,attempt} = trial();
    expect(()=>timeoutAttempt(store,attempt.attempt_id,T+1000)).toThrow();
    completeAttempt(store,attempt.attempt_id,T+905000);
    expect(attempt.experimental_result).toBe('timeout');
    expect(validateStore(store).errors).toEqual([]);
  });
  it('serializes concurrent independent repository handles without dropping focus events', async () => {
    const {store,attempt} = trial(); const mem = new MemoryStorageAdapter();
    const r1 = new Repository(mem), r2 = new Repository(mem); await r1.saveStore(store);
    const a = structuredClone(store), b = structuredClone(store);
    recordFocusSignal(a,attempt.attempt_id,'window_blur',T+1000);
    recordFocusSignal(b,attempt.attempt_id,'tab_hidden',T+2000);
    await Promise.all([r1.saveMerged(a,T+3000),r2.saveMerged(b,T+3000)]);
    const saved=await r1.loadStore(); expect(saved.events[attempt.attempt_id]).toHaveLength(3);
    expect(saved.attempts[attempt.attempt_id]?.focus_loss_count).toBe(1);
  });
  it('recomputes finished integrity from a concurrent late-arriving pre-end event', () => {
    const {store,attempt} = trial(); const finishing=structuredClone(store);
    completeAttempt(finishing,attempt.attempt_id,T+10000);
    recordFocusSignal(store,attempt.attempt_id,'window_blur',T+5000);
    const merged=mergeStores(finishing,store,T+10000);
    expect(merged.attempts[attempt.attempt_id]?.total_time_away_ms).toBe(5000);
    expect(validateStore(merged).errors).toEqual([]);
  });
  it('validator rejects timestamp and raw-log mismatches', () => {
    const {store,attempt}=trial(); recordFocusSignal(store,attempt.attempt_id,'window_blur',T+5000);
    completeAttempt(store,attempt.attempt_id,T+10000);
    attempt.total_time_away_ms=0; attempt.elapsed_ms=9000; attempt.elapsed_seconds=9;
    const codes=validateStore(store).errors.map(e=>e.code);
    expect(codes).toContain('integrity-log-mismatch'); expect(codes).toContain('attempt-timestamp-duration');
  });
  it('does not erase a newer live observation or clear a worker-created active pointer', () => {
    const store=emptyStore(), stale=structuredClone(store); const session=createSession(store,'TEST',1,900,T,true);
    handleSiteEvent(store,{kind:'problem_loaded',atMs:T,problem:{problemId:'81496',problemRating:700,difficultyLabel:null,mode:'endgame'}},T);
    const id=store.activeAttemptId!; const old=structuredClone(store);
    store.liveObservations[id]!.siteResult='correct'; store.liveObservations[id]!.observedAt=new Date(T+1000).toISOString();
    expect(mergeStores(old,store,T+1000).liveObservations[id]?.siteResult).toBe('correct');
    expect(mergeStores(stale,store,T+1000).activeSessionId).toBe(session.session_id);
    expect(mergeStores(stale,store,T+1000).activeAttemptId).toBe(id);
  });
  it('retains late metadata after the final auto trial times out', () => {
    const store=emptyStore();createSession(store,'TEST',1,900,T,true);
    handleSiteEvent(store,{kind:'problem_loaded',atMs:T,problem:{problemId:'81496',problemRating:700,difficultyLabel:null,mode:'endgame'}},T);
    const id=store.activeAttemptId!;timeoutAttempt(store,id,T+900000);
    const out=handleSiteEvent(store,{kind:'problem_completed',atMs:T+905000,result:{problemId:'81496',result:'correct',timeUsedSeconds:905,movesUsed:1,averageMoves:null,playerRatingAfter:null,ratingChange:null}},T+905000);
    expect(out.handled).toBe(true);expect(store.attempts[id]?.chesstempo_result).toBe('correct');
    expect(store.attempts[id]?.experimental_result).toBe('timeout');
  });
});

describe('numeric input remains interpretable', () => {
  it('preserves negative decimal changes and exact raw cells', () => {
    const row=parseChessTempoCsv('Problem ID,Date,Rating Change\n81496,2026-10-02T12:00:00Z,-6.9','test.csv').rows[0]!;
    expect(row.ratingChange).toBe(-6.9);expect(row.raw['Rating Change']).toBe('-6.9');
  });
  it('flags historical decimal sign corruption without changing the original row', () => {
    const parsed = parseChessTempoCsv('Problem ID,Date,Rating Change\n81496,2026-10-02T12:00:00Z,-6.9', 'legacy.csv');
    const store = emptyStore(); const row = parsed.rows[0]!; row.ratingChange = 6.9;
    store.importRows[parsed.import.importId] = parsed.rows;
    expect(validateStore(store).errors.some(e => e.code === 'import-signed-change-mismatch')).toBe(true);
    expect(row.ratingChange).toBe(6.9); expect(row.raw['Rating Change']).toBe('-6.9');
  });
  it('refuses a timezone-free import unless its UTC offset is explicit', () => {
    const csv='Problem ID,Date,Time Used\n81496,2026-10-02 12:00:00,2 minutes';
    expect(parseChessTempoCsv(csv,'test.csv').rows[0]?.attemptedAt).toBeNull();
    const row=parseChessTempoCsv(csv,'test.csv',T,{timezoneOffsetMinutes:-300}).rows[0]!;
    expect(row.attemptedAt).toBe('2026-10-02T17:00:00.000Z');expect(row.timeUsedSeconds).toBe(120);
  });
  it('handles units/hour clocks and rejects invalid or negated values', () => {
    expect(parseTimeUsed('2 minutes')).toBe(120);expect(parseTimeUsed('1:02:03')).toBe(3723);
    expect(parseTimeUsed('1:99')).toBeNull();expect(parseRating('15000')).toBeNull();
    expect(parseResult('not correct')).toBeNull();expect(isCorrectChessTempoResult('unknown')).toBeNull();
  });
});

describe('live adapter initialization and enrichment', () => {
  function page(): PageReading { return {trainingPage:true,problemId:'81496',problemRating:700,difficultyLabel:null,mode:'endgame',displayedRating:null,result:null,timeUsedSeconds:null,movesUsed:null,stepNumber:null,stepTotal:null,playerRatingAfter:null,ratingChange:null,foundFields:[],missingFields:[]}; }
  it('confirms an unchanged page at the dwell boundary and can replay for a new session', () => {
    vi.useFakeTimers();vi.setSystemTime(T);const events:SiteEvent[]=[];
    const adapter=new ChessTempoAdapter({readPage:page,observe:()=>()=>{}});
    adapter.subscribe(e=>events.push(e));adapter.start();vi.advanceTimersByTime(1500);
    expect(events.filter(e=>e.kind==='problem_loaded')).toHaveLength(1);
    expect(adapter.replayReadyProblem()).toBe(true);
    expect(events.filter(e=>e.kind==='problem_loaded')).toHaveLength(2);
    adapter.dispose();vi.useRealTimers();
  });
  it('emits later result fields without duplicating completion', () => {
    const r=page(), events:SiteEvent[]=[];
    const adapter=new ChessTempoAdapter({readPage:()=>r,observe:()=>()=>{},now:()=>T});
    adapter.subscribe(e=>events.push(e));adapter.start();adapter.tick();adapter.tick();adapter.notifyAttemptStarted('81496');
    r.result='correct';adapter.tick();adapter.notifyAttemptEnded('81496');
    r.timeUsedSeconds=13;adapter.tick();adapter.tick();
    expect(events.filter(e=>e.kind==='problem_completed')).toHaveLength(1);
    expect(events.filter(e=>e.kind==='result_updated')).toHaveLength(1);
    expect(events.find(e=>e.kind==='result_updated')?.result?.timeUsedSeconds).toBe(13);adapter.dispose();
  });
});

describe('provisional search data and reproducibility', () => {
  it('replays a seed and canonical pool independent of input row order', async () => {
    const pool=parseStudyPool(JSON.stringify(Array.from({length:20},(_,i)=>({id:String(i),rating:500+i*100,rating_source:'test',task_type:'endgame'}))));
    const a=await createStudyPlan(pool,'study-P01',5,10), b=await createStudyPlan([...pool].reverse(),'study-P01',5,10);
    expect(a).toEqual(b);
    expect(await createStudyPlan(a.pool!, a.seed, a.count_min, a.count_max)).toEqual(a);expect(a.ordered_puzzles.length).toBeGreaterThanOrEqual(5);expect(a.ordered_puzzles.length).toBeLessThanOrEqual(10);
    expect(new Set(a.ordered_puzzles.map(p=>p.id)).size).toBe(a.ordered_puzzles.length);
    const changed=[...pool];changed[0]={...changed[0]!,rating:999};
    expect((await createStudyPlan(changed,'study-P01',5,10)).pool_sha256).not.toBe(a.pool_sha256);
  });
  it('retains timed choices, benchmark provenance and audit logs through backup and CSV', () => {
    const {store,session,attempt}=trial();session.study={protocol_id:'test-v1',task_source:'authored',skill_rating:1200,skill_rating_source:'self_reported:test',skill_recorded_at:new Date(T).toISOString(),search_capture_enabled:true,plan:null};
    recordSearchChoice(store,attempt.attempt_id,'candidate','Kf3','other',T+1234);
    recordSearchChoice(store,attempt.attempt_id,'decision','Kf3','satisfied',T+4321);completeAttempt(store,attempt.attempt_id,T+4321);
    recordBenchmark(store,attempt.attempt_id,{best_move:'Kg3',engine_name:'test-engine',engine_version:'test-v1',configuration:'test depth 20',position_reference:'authored-position-1',chosen_cp:10,best_cp:110,threshold_cp:50},T+5000);
    const summary=summarizeSearch(store.researchEvents![attempt.attempt_id]!);
    expect(summary.first_candidate_elapsed_ms).toBe(1234);expect(summary.final_choice_elapsed_ms).toBe(4321);
    expect(summary.evaluation_gap_cp).toBe(100);expect(summary.missed_better_option).toBe(true);
    expect(parseBackup(serializeBackup(buildBackup(store,T+6000)))).toEqual(store);
    session.protocol_id = session.study.protocol_id;
    expect(validateStore(store).errors).toEqual([]);
    store.researchEvents![attempt.attempt_id]![0]!.recorded_at = new Date(T - 1).toISOString();
    expect(validateStore(store).errors.some(e => e.code === 'research-choice-timing')).toBe(true);
    store.researchEvents![attempt.attempt_id]![0]!.recorded_at = new Date(T + 1234).toISOString();
    const csv=attemptsToCsv(new Map([[session.session_id,'TEST']]),[attempt],store);
    expect(csv).toContain('research_events');expect(csv).toContain('test-engine');expect(csv).toContain('self_reported:test');
    expect(()=>recordSearchChoice(store,attempt.attempt_id,'candidate','Kg3','other',T+5000)).toThrow();
  });
  it('does not fabricate search or engine measures when they were not collected', () => {
    expect(summarizeSearch([]).first_candidate).toBeNull();expect(summarizeSearch([]).missed_better_option).toBeNull();
    const {store,attempt}=trial();expect(()=>recordSearchChoice(store,attempt.attempt_id,'candidate','Kf3','other',T+1000)).toThrow();
  });
});
