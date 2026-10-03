import { Chess, type Square } from 'chess.js';
import { Repository } from '../storage/repository.js';
import { ChromeStorageAdapter } from '../storage/chromeAdapter.js';
import { BrowserStorageAdapter } from './browserStorage.js';
import { beginLocalSession, closeLocalTrial, freezeTrainingPool, localChoice, makeLocalPlan, startLocalTrial, visibleTrial, type LocalSetup } from './localTrainer.js';
import type { FrozenTrainingPool, StudyScheduleStatus } from './types.js';
import type { Attempt, PuzzleTrackStore, Session } from '../models/types.js';
import { buildBackup, serializeBackup } from '../export/jsonBackup.js';
import { attemptsToCsv } from '../export/csv.js';
import { recordFocusSignal } from '../session/sessionManager.js';
import { buildMeasurementAudit } from '../research/measurementAudit.js';

const extensionMode = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
const repo = new Repository(extensionMode ? new ChromeStorageAdapter() : new BrowserStorageAdapter());
const $ = (id: string): HTMLElement => { const el = document.getElementById(id); if (!el) throw new Error('Missing trainer control: ' + id); return el; };
const input = (id: string): string => ($(id) as HTMLInputElement).value.trim();
let pool: FrozenTrainingPool | null = null;
let uploadedPool = false;
let schedule: StudyScheduleStatus | null = null;
let scheduleFetchedAt=0, serverOffsetMs=0;
let snapshot: PuzzleTrackStore | null = null;
let sessionId: string | null = null;
let latestId: string | null = null;
let boardKey = '', selectedSquare: Square | null = null;
let busy = false, refreshing = false, owner = false;
const format = (ms: number): string => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60).toString().padStart(2,'0')}:${(s % 60).toString().padStart(2,'0')}`; };
function error(message = ''): void { $('error').textContent = message; $('error').hidden = !message; }
function view(id: string): void {
  for (const key of ['setup','ready','play','result','finished']) $(key).hidden = key !== id;
  for (const el of document.querySelectorAll<HTMLElement>('.researcher-controls')) el.hidden = !['setup','finished'].includes(id);
  $('storage-note').hidden = !['setup','finished'].includes(id);
  $('schedule-status').hidden = !['setup','finished'].includes(id);
  $('archive-session').hidden = !['setup','ready','result'].includes(id);
  ($('archive-session') as HTMLButtonElement).disabled=!snapshot?.activeSessionId;
  $('view-label').textContent = id === 'setup' ? 'Research setup' : id === 'finished' ? 'Session complete' : 'Decision session';
}
function poolSummary(label: string, details: string): void {
  $('pool-count').textContent = pool ? String(pool.data.puzzles.length) : '—';
  $('pool-label').textContent = label;
  $('pool-status').textContent = details;
}
function freshSeed(): void { ($('seed') as HTMLInputElement).value = crypto.randomUUID(); }
freshSeed();
function activeAttempt(store: PuzzleTrackStore): Attempt | null { return store.activeAttemptId ? store.attempts[store.activeAttemptId] ?? null : null; }
function currentSession(store: PuzzleTrackStore): Session | null {
  return sessionId ? store.sessions[sessionId] ?? null : null;
}
function pieces() { return { w: {k:'♔',q:'♕',r:'♖',b:'♗',n:'♘',p:'♙'}, b: {k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'} }; }
function drawBoard(a: Attempt): void {
  const trial = a.local_trial!;
  const key = a.attempt_id + ':' + trial.current_fen + ':' + (a.ended_at ?? 'active');
  if (boardKey === key) return;
  boardKey = key; selectedSquare = null;
  const chess = new Chess(trial.current_fen), white = new Chess(trial.presented_fen).turn() === 'w';
  const files = white ? 'abcdefgh' : 'hgfedcba', ranks = white ? '87654321' : '12345678';
  $('board').replaceChildren();
  for (const rank of ranks) for (const file of files) {
    const square = (file + rank) as Square, piece = chess.get(square);
    const button = document.createElement('button');
    button.type = 'button'; button.dataset.square = square;
    button.className = `square ${(file.charCodeAt(0) + Number(rank)) % 2 === 0 ? 'dark' : 'light'}${piece?.color === 'w' ? ' white-piece' : ''}`;
    const names = {k:'king',q:'queen',r:'rook',b:'bishop',n:'knight',p:'pawn'};
    button.setAttribute('aria-label', `${square} ${piece ? (piece.color === 'w' ? 'White ' : 'Black ') + names[piece.type] : 'empty'}`);
    const glyph = document.createElement('span'); glyph.textContent = piece ? pieces()[piece.color][piece.type] : ''; glyph.setAttribute('aria-hidden','true');
    const coordinate = document.createElement('span'); coordinate.className='coordinate'; coordinate.textContent=square;
    button.append(glyph, coordinate); button.disabled = a.ended_at !== null;
    button.addEventListener('click', () => {
      if (busy || !owner || !snapshot?.activeAttemptId) return;
      const position = new Chess(snapshot.attempts[snapshot.activeAttemptId]!.local_trial!.current_fen);
      const current = position.get(square);
      if (current?.color === position.turn()) {
        selectedSquare = square;
        for (const el of $('board').querySelectorAll('.square')) el.classList.toggle('selected', (el as HTMLElement).dataset.square === square);
      } else if (selectedSquare) {
        const from = position.get(selectedSquare);
        const promotion = from?.type === 'p' && (rank === '1' || rank === '8') ? input('promotion') : '';
        ($('move') as HTMLInputElement).value = selectedSquare + square + promotion;
      }
    });
    $('board').append(button);
  }
  ($('move') as HTMLInputElement).value = '';
  ($('reason') as HTMLSelectElement).value = '';
  // Store presentation after two frame boundaries. It is an observed callback,
  // not a hardware-calibrated pixel onset; timestamps remain inspectable.
  if (a.ended_at === null && !trial.turn_presentations.some(p => p.step_number === trial.participant_step)) {
    const step = trial.participant_step;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const at = new Date().toISOString();
      void repo.transact(store => {
        const current = store.attempts[a.attempt_id];
        if (!current?.local_trial || current.ended_at || current.local_trial.participant_step !== step) return;
        const t = current.local_trial;
        if (!t.turn_presentations.some(p => p.step_number === step)) t.turn_presentations.push({step_number:step,presented_at:at});
        if (t.presented_at === null) t.presented_at = at;
      }).catch(e => error(String(e)));
    }));
  }
}
async function refresh(): Promise<void> {
  if (refreshing || !owner) return;
  refreshing = true;
  try {
    let store = await repo.loadStore();
    let a = activeAttempt(store);
    if (a?.local_trial && Date.now() >= Date.parse(a.started_at) + a.time_limit_seconds * 1000) {
      const id=a.attempt_id;
      await repo.transact(current => { const live=current.attempts[id]; if (live && live.ended_at === null) closeLocalTrial(current,id,Date.now()); });
      latestId=id; store=await repo.loadStore(); a=activeAttempt(store);
    }
    snapshot=store;
    if(schedule && Date.now()-scheduleFetchedAt>30000)await loadSchedule();
    if(schedule?.enabled && !studyWindowOpen()) {
      view('setup'); $('board').replaceChildren();
      ($('start-session') as HTMLButtonElement).disabled=true;
      return;
    }
    const pending=store.activeSessionId?store.sessions[store.activeSessionId]:null;
    const pendingSource=store.localPools?.[pending?.study?.local_pool_sha256??'']?.data.source;
    if(schedule && pending?.study?.local_pool_sha256 && pendingSource && (pendingSource.study_phase!==(schedule.enabled?'main_study':'pilot_review') || pendingSource.schedule_sha256!==schedule.sha256 || (schedule.enabled && pendingSource.batch_date!==schedule.study_date))) {
      view('setup');$('board').replaceChildren();error('The active session belongs to an earlier assignment or study phase. Export its records and archive the unfinished session before starting another.');return;
    }
    const activeSession = store.activeSessionId ? store.sessions[store.activeSessionId] : null;
    if (activeSession && !activeSession.study?.local_pool_sha256) { view('setup'); error('Finish the active collector session before starting the local trainer.'); ($('start-session') as HTMLButtonElement).disabled=true; return; }
    if (activeSession?.study?.local_pool_sha256) sessionId=activeSession.session_id;
    const session=currentSession(store);
    if (a?.local_trial && session?.session_id === a.session_id) {
      latestId=a.attempt_id; view('play'); drawBoard(a);
      $('trial-heading').textContent=`Position ${a.attempt_number}`;
      const side = new Chess(a.local_trial.current_fen).turn() === 'w' ? 'White' : 'Black';
      $('turn-label').textContent=`${side} to move · decision ${a.local_trial.participant_step}`;
      $('remaining').textContent=format(Date.parse(a.started_at)+a.time_limit_seconds*1000-Date.now());
      const candidates=(store.researchEvents?.[a.attempt_id]??[]).filter(e=>e.kind==='candidate' && (e.step_number??1)===a!.local_trial!.participant_step);
      $('candidate-status').textContent=`${candidates.length} candidate report(s) this turn`;
      return;
    }
    if (latestId && store.attempts[latestId]?.ended_at) {
      const last=store.attempts[latestId]!; view('result');
      const outcome=last.local_trial?.outcome ?? last.experimental_result;
      $('result-heading').textContent=outcome==='timeout' ? 'Time limit reached' : 'Response recorded';
      $('result-text').textContent='This position has ended. Continue when you are ready.';
      $('next').textContent='Continue';
      return;
    }
    if (session?.status==='completed') {
      view('finished');
      const rows=Repository.attemptsForSession(store,session.session_id);
      $('finished-text').textContent=`${session.participant_id}: ${rows.length} responses recorded. Export the JSON backup and individual CSV before closing.`;
      return;
    }
    if (session?.status==='active') {
      view('ready'); const number=Repository.attemptsForSession(store,session.session_id).length+1;
      $('ready-heading').textContent=`Position ${number}`;
      return;
    }
    view('setup');
  } catch(e) { error(e instanceof Error ? e.message : String(e)); }
  finally { refreshing=false; }
}
async function action(fn: () => Promise<void>): Promise<void> {
  if (busy || !owner) return;
  busy=true; error();
  for (const id of ['start-session','start-trial','candidate','submit-move','abort']) ($ (id) as HTMLButtonElement).disabled=true;
  try { await fn(); } catch(e) { error(e instanceof Error ? e.message : String(e)); }
  finally { busy=false; for (const id of ['start-trial','candidate','submit-move','abort']) ($(id) as HTMLButtonElement).disabled=false; ($('start-session') as HTMLButtonElement).disabled=!pool && !schedule; await refresh(); }
}
function download(name: string, body: string, type: string): void {
  const url=URL.createObjectURL(new Blob([body],{type})), link=document.createElement('a');
  link.href=url; link.download=name; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('setup-form').addEventListener('submit', event => {
  event.preventDefault(); void action(async () => {
    if(schedule) {
      await loadSchedule();
      if(schedule.enabled && !studyWindowOpen())throw new Error('Study access is outside the scheduled window.');
      await loadParticipantPool(input('participant'));
    }
    if (!pool) throw new Error('Load a frozen source pool first.');
    const skill=input('skill');
    const setup: LocalSetup={participant:input('participant'),protocol:input('protocol'),seed:input('seed'),min:10,max:10,ratingMin:Number(input('rating-min')),ratingMax:Number(input('rating-max')),seconds:Number(input('limit')),skill:skill===''?null:Number(skill),skillSource:input('skill-source'),practiceMinutes:input('practice-minutes')===''?null:Number(input('practice-minutes')),practiceNotes:input('practice-notes')};
    if (($('exclude-seen') as HTMLInputElement).checked) {
      const store = await repo.loadStore();
      const sessionIds = new Set(Object.values(store.sessions).filter(s => s.participant_id === setup.participant.trim()).map(s => s.session_id));
      setup.excludedPuzzleIds = Object.values(store.attempts).filter(a => sessionIds.has(a.session_id) && a.local_trial).map(a => a.local_trial!.puzzle_id);
      setup.excludedPositionKeys = Object.values(store.attempts).filter(a => sessionIds.has(a.session_id) && a.local_trial).map(a => a.local_trial!.presented_fen.split(' ').slice(0,4).join(' '));
    }
    if(schedule) {
      const source=pool.data.source;
      if(source.participant_id!==setup.participant || source.schedule_sha256!==schedule.sha256)throw new Error('Participant or schedule does not match the frozen assignment.');
      const store=await repo.loadStore();
      if(Object.values(store.sessions).some(s=>{const previous=store.localPools?.[s.study?.local_pool_sha256??'']?.data.source;return s.participant_id===setup.participant && previous?.study_phase===source.study_phase && (source.study_phase==='pilot_review' || previous?.batch_date===source.batch_date);}))throw new Error('This participant already started this batch. Resume its active session; completed pilot batches cannot be replayed.');
      if(schedule.enabled && Date.now()+serverOffsetMs+setup.seconds*10000>Date.parse(source.schedule_closes_at!))throw new Error('Not enough study-window time remains for all 10 maximum-duration puzzles. Start earlier.');
    }
    const plan=await makeLocalPlan(pool,setup), frozen=pool;
    sessionId=await repo.transact(store=>beginLocalSession(store,frozen,setup,plan,Date.now()).session_id);
    latestId=null; boardKey='';
  });
});
$('pool-file').addEventListener('change', () => { void action(async()=> {
  if(schedule)throw new Error('Participant-specific study assignments cannot be replaced by an uploaded pool.');
  const file=($('pool-file') as HTMLInputElement).files?.[0]; if(!file)return;
  if(file.size>8_000_000)throw new Error('Use a pool under 8 MB.');
  pool=await freezeTrainingPool(await file.text()); poolSummary('Uploaded source pool',`Reviewed pool: ${pool.data.puzzles.length} endgames · SHA-256 ${pool.sha256}`);
  uploadedPool=true;
}); });
$('start-trial').addEventListener('click',()=>{ const at=Date.now(); void action(async()=> {
  if(!sessionId)throw new Error('No active local session.');
  if(schedule) {
    await loadSchedule();
    if(schedule.enabled && !studyWindowOpen())throw new Error('Study access is outside the scheduled window.');
    const store=await repo.loadStore(),session=store.sessions[sessionId],source=store.localPools?.[session?.study?.local_pool_sha256??'']?.data.source;
    if(!source || source.study_phase!==(schedule.enabled?'main_study':'pilot_review') || source.schedule_sha256!==schedule.sha256)throw new Error('This session belongs to a different study phase/revision. Archive it; do not continue into the new phase.');
    if(schedule.enabled && (source.batch_date!==schedule.study_date || Date.now()+serverOffsetMs+session!.time_limit_seconds*1000>Date.parse(source.schedule_closes_at!)))throw new Error('This assignment has expired or too little window time remains for a complete puzzle.');
  }
  const sid=sessionId;
  const a=await repo.transact(store=>startLocalTrial(store,sid,at)); latestId=a.attempt_id;
  if(extensionMode)await chrome.runtime.sendMessage({kind:'schedule-timeout',attemptId:a.attempt_id,deadlineMs:at+a.time_limit_seconds*1000});
}); });
for(const [id,kind] of [['candidate','candidate'],['submit-move','decision']] as const) $(id).addEventListener('click',()=>{
  const at=Date.now(), move=input('move'), reason=input('reason');
  void action(async()=> {
    if(schedule?.enabled && !studyWindowOpen())throw new Error('Study access is outside the scheduled window.');
    if(kind==='decision' && !['satisfied','time_pressure','exhausted_options','other'].includes(reason))throw new Error('Select why you are stopping this search.');
    const ended=await repo.transact(store=> {
      const a=activeAttempt(store); if(!a?.local_trial)throw new Error('No active endgame.');
      localChoice(store,a.attempt_id,move,kind,(reason||'other') as 'satisfied'|'time_pressure'|'exhausted_options'|'other',at);
      latestId=a.attempt_id; return a.ended_at !== null;
    });
    if(ended && extensionMode)await chrome.runtime.sendMessage({kind:'clear-timeout',attemptId:latestId});
  });
});
$('abort').addEventListener('click',()=>{const at=Date.now(); void action(async()=> {
  await repo.transact(store=>{const a=activeAttempt(store);if(a?.local_trial){closeLocalTrial(store,a.attempt_id,at,true);latestId=a.attempt_id;}});
});});
$('next').addEventListener('click',()=>{latestId=null;void refresh();});
$('new-session').addEventListener('click',()=>{void action(async()=>{if(!uploadedPool && !schedule)await loadDefaultPool();sessionId=null;latestId=null;if(!schedule)freshSeed();});});
$('export-json').addEventListener('click',()=>{void action(async()=>{const store=await repo.loadStore();download(`puzzletrack-endgame-backup-${Date.now()}.json`,serializeBackup(buildBackup(store)),'application/json');});});
$('export-csv').addEventListener('click',()=>{void action(async()=> {
  const store=await repo.loadStore(), pid=currentSession(store)?.participant_id??input('participant');
  if(!pid)throw new Error('Choose a session or enter the participant ID to export.');
  const map=new Map(Object.values(store.sessions).map(s=>[s.session_id,s.participant_id]));
  download(`puzzletrack-${pid}-${Date.now()}.csv`,attemptsToCsv(map,Object.values(store.attempts).filter(a=>map.get(a.session_id)===pid),store),'text/csv');
});});
$('validate').addEventListener('click',()=>{void action(async()=> {
  const audit=buildMeasurementAudit(await repo.loadStore()), report=audit.validation;
  $('measurement-scope').textContent=audit.scope;
  $('measurement-coverage').replaceChildren();
  for (const measure of audit.measures) {
    const li=document.createElement('li');
    li.textContent=`${measure.label}: ${measure.available}/${measure.denominator} available · ${measure.kind}. ${measure.rule}`;
    $('measurement-coverage').append(li);
  }
  $('warning-groups').textContent=audit.warning_groups.map(g=>`${g.code}: ${g.findings} findings across ${g.attempt_ids.length} attempts`).join(' · ') || 'No warnings.';
  $('measurement-audit').hidden=false;
  $('validation').textContent=`Entire dataset: ${report.errors.length} errors, ${report.warnings.length} warnings.${report.errors.length || report.warnings.length ? ' Review findings before analysis.' : ' No structural issues found. Review the study protocol separately.'}`;
  $('validation-findings').replaceChildren();
  for (const [severity, issues] of [['Error',report.errors],['Warning',report.warnings]] as const) for (const issue of issues) {
    const li=document.createElement('li');
    li.textContent=`${severity} · ${issue.code}: ${issue.message}${issue.attemptId ? ` Attempt ${issue.attemptId}.` : issue.sessionId ? ` Session ${issue.sessionId}.` : ''}`;
    $('validation-findings').append(li);
  }
  $('validation-details').hidden=report.errors.length+report.warnings.length===0;
});});
$('archive-session').addEventListener('click',()=>{void action(async()=>{
  const at=Date.now();
  await repo.transact(store=>{
    const sid=store.activeSessionId,session=sid?store.sessions[sid]:null;
    if(!session)return;
    if(!session.study?.local_pool_sha256)throw new Error('Archive collector sessions through the collector interface.');
    const a=activeAttempt(store);if(a?.local_trial)closeLocalTrial(store,a.attempt_id,at,true);
    session.status='abandoned';session.completed_at=new Date(at).toISOString();store.activeSessionId=null;
  });
  sessionId=null;latestId=null;error('Unfinished session archived. Recorded attempts are preserved; unanswered assignments were not fabricated.');
});});
$('export-audit').addEventListener('click',()=>{void action(async()=>{
  const audit=buildMeasurementAudit(await repo.loadStore());
  download(`puzzletrack-measurement-audit-${Date.now()}.json`,JSON.stringify(audit,null,2),'application/json');
});});
for(const [target,kind,event] of [[window,'window_blur','blur'],[window,'window_focus','focus'],[document,'tab_hidden','visibilitychange']] as const) target.addEventListener(event,()=> {
  const at=Date.now(), signal=event==='visibilitychange' ? document.hidden?'tab_hidden':'tab_visible' : kind;
  if(!owner)return;
  void repo.transact(store=>{const a=activeAttempt(store);if(a?.local_trial)recordFocusSignal(store,a.attempt_id,signal,at);}).catch(e=>error(String(e)));
});
(globalThis as typeof globalThis & {render_game_to_text?:()=>string}).render_game_to_text=()=> {
  const a=snapshot?activeAttempt(snapshot):null;
  return JSON.stringify({mode:!owner?'inactive':a?'solving':latestId?'result':sessionId?'ready':'setup',board_coordinates:'algebraic; solver side at bottom', ...(a?.local_trial?visibleTrial(a.local_trial,false):{}),draft_move:input('move'),time_limit_seconds:a?.time_limit_seconds??null});
};
function studyWindowOpen():boolean {
  const now=Date.now()+serverOffsetMs;
  return !!schedule?.enabled && schedule.state==='open' && !!schedule.opens_at && !!schedule.closes_at && now>=Date.parse(schedule.opens_at) && now<Date.parse(schedule.closes_at);
}
async function loadSchedule():Promise<void>{
  if(extensionMode)return;
  const response=await fetch('study-schedule.json');
  if(!response.ok)throw new Error(await response.text());
  schedule=await response.json() as StudyScheduleStatus;
  scheduleFetchedAt=Date.now();serverOffsetMs=Date.parse(schedule.server_now)-scheduleFetchedAt;
  const assignment=schedule.assignment??schedule.config.days[0]!;
  const quotas=Object.entries(assignment.quotas).filter(([,n])=>n>0).map(([id,n])=>`${n} ${id}`).join(' + ');
  $('question-description').textContent=`Exactly 10 puzzles: ${quotas}, randomly selected within the approved provisional source-rating bands. Order is reproducible for each participant ID.`;
  $('seed').closest('label')!.querySelector('.hint')!.textContent='Assigned from participant ID and frozen schedule; saved for exact replay.';
  $('schedule-status').textContent=schedule.enabled ? `Main study · day ${schedule.day_index??'—'} · ${schedule.state} · ${schedule.config.timezone} ${schedule.config.opens}–${schedule.config.closes}.` : `Professor-review pilot · ${assignment.seconds/60} minutes per puzzle · ${quotas}. Study hours are not active. One frozen batch per participant ID.`;
  ($('limit') as HTMLSelectElement).value=String(assignment.seconds); ($('limit') as HTMLSelectElement).disabled=true;
  ($('rating-min') as HTMLInputElement).value=String(Math.min(...schedule.config.bands.map(b=>b.min)));($('rating-max') as HTMLInputElement).value=String(Math.max(...schedule.config.bands.map(b=>b.max)));
  for(const id of ['rating-min','rating-max','pool-file'])($(id) as HTMLInputElement).disabled=true;
  ($('protocol') as HTMLInputElement).value=schedule.config.revision+(schedule.enabled?':main':':pilot-review');($('protocol') as HTMLInputElement).readOnly=true;
  ($('seed') as HTMLInputElement).readOnly=true;
  if(!pool){$('pool-count').textContent='10';$('pool-label').textContent='Participant-specific assignment';$('pool-status').textContent=`${quotas}. ${schedule.config.difficulty_note} Enter an ID and start to load its archived assignment.`;}
}
async function loadParticipantPool(participant:string):Promise<void>{
  const response=await fetch(`study-pool.json?participant=${encodeURIComponent(participant)}`);
  if(!response.ok)throw new Error(await response.text());
  pool=await freezeTrainingPool(await response.text());
  ($('seed') as HTMLInputElement).value=pool.data.source.participant_seed!;
  poolSummary(`${pool.data.source.study_phase==='pilot_review'?'Pilot review':'Study day '+pool.data.source.schedule_day} · batch ${pool.data.source.batch_code}`,`${pool.data.source.selection} Bands: ${JSON.stringify(schedule?.config.bands)}. SHA-256 ${pool.sha256}. Benchmarks unavailable; source reference solutions are not proof of optimality.`);
}
async function loadDefaultPool():Promise<void>{
  let response = !extensionMode ? await fetch('daily-pool.json') : null;
  if (response && response.status !== 404 && !response.ok) throw new Error(await response.text());
  if (!response?.ok) response=await fetch('pilot-pool.json');
  if(!response.ok)throw new Error('Bundled starter pool is unavailable.');
  pool=await freezeTrainingPool(await response.text());
  const daily = !!pool.data.source.batch_date;
  poolSummary(daily ? `Daily batch · ${pool.data.source.batch_date}` : 'Starter calibration pool',`${daily ? `Daily batch ${pool.data.source.batch_date}` : 'Starter pool'}: ${pool.data.puzzles.length} legal ≤7-piece endgame puzzles · SHA-256 ${pool.sha256}. Source difficulty is the Lichess puzzle rating, not ChessTempo rating.${daily ? ' Initial tablebase benchmarks are unavailable in this bank.' : ' Prepare a local bank for daily batches.'}`);
}
async function initialize():Promise<void>{
  if(!navigator.locks)throw new Error('Open through localhost or the Chrome extension; Web Locks are required.');
  await new Promise<void>((resolve,reject)=> {
    void navigator.locks.request('puzzletrack-local-trainer-owner',{ifAvailable:true},async lock=> {
      if(!lock){reject(new Error('Another endgame trainer tab is open. Close that tab before using this one.'));return;}
      owner=true;resolve();await new Promise<void>(release=>window.addEventListener('pagehide',()=>release(),{once:true}));
    });
  });
  $('storage-note').textContent=extensionMode?'Storage: extension research dataset. No puzzle-server requests during play.':'Storage: this browser on localhost, separate from extension data. Export JSON to archive or transfer. No puzzle-server requests during play.';
  if(!extensionMode)await loadSchedule();
  if(!schedule)await loadDefaultPool();
  const requested=new URL(location.href).searchParams.get('participant');
  if(requested && /^[A-Za-z0-9_-]{1,32}$/.test(requested))($('participant') as HTMLInputElement).value=requested;
  const store=await repo.loadStore();
  if(store.activeSessionId && store.sessions[store.activeSessionId]?.study?.local_pool_sha256) {
    sessionId=store.activeSessionId;
    if(store.activeAttemptId)await repo.transact(current=>{const a=activeAttempt(current);if(a?.local_trial)a.possibly_interrupted=true;});
  }
  ($('start-session') as HTMLButtonElement).disabled=false;
  await refresh();setInterval(()=>void refresh(),250);
}
void initialize().catch(e=>error(e instanceof Error?e.message:String(e)));
