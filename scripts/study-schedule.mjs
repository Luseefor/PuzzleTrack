import { sha256, positionKey } from './endgame-bank.mjs';
const LIMITS=[900,1200,1800,2700,3600];
const dateOk=s=>typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s;
const minute=s=>/^([01]\d|2[0-3]):[0-5]\d$/.test(s??'') ? Number(s.slice(0,2))*60+Number(s.slice(3)) : null;
export function validateSchedule(config) {
  if(!config || config.format!=='puzzletrack-study-schedule' || config.version!==1 || typeof config.enabled!=='boolean' || !config.revision?.trim() || !config.difficulty_note?.trim())throw new Error('Invalid study schedule identity/revision.');
  if(typeof config.timezone!=='string'||!config.timezone)throw new Error('Schedule requires an explicit IANA timezone.');
  new Intl.DateTimeFormat('en-US',{timeZone:config.timezone}).format();
  if(!Array.isArray(config.bands)||!config.bands.length||!Array.isArray(config.days)||!config.days.length||config.days.length>366)throw new Error('Schedule requires bands and 1–366 explicit days.');
  const ids=new Set();
  for(const b of config.bands){
    if(!/^[a-z][a-z0-9_-]{0,31}$/.test(b.id)||ids.has(b.id)||!Number.isInteger(b.min)||!Number.isInteger(b.max)||b.min<0||b.max>4000||b.min>b.max)throw new Error('Invalid or duplicate difficulty band.');ids.add(b.id);
  }
  for(let i=0;i<config.bands.length;i++)for(const b of config.bands.slice(i+1)){const a=config.bands[i];if(a.min<=b.max&&b.min<=a.max)throw new Error('Difficulty bands overlap.');}
  for(const d of config.days){
    if(!LIMITS.includes(d.seconds)||!d.quotas||Object.keys(d.quotas).some(id=>!ids.has(id))||config.bands.some(b=>!Number.isInteger(d.quotas[b.id])||d.quotas[b.id]<0)||Object.values(d.quotas).reduce((a,b)=>a+b,0)!==10)throw new Error('Every scheduled day requires a supported time limit and quotas totalling exactly 10.');
  }
  if(config.enabled){
    const opens=minute(config.opens),closes=minute(config.closes);
    if(!dateOk(config.start_date)||opens===null||closes===null||closes<=opens)throw new Error('Enabled schedule needs a real start date and same-day opening/closing times.');
    if(config.days.some(d=>(closes-opens)*60<10*d.seconds))throw new Error('Daily window is too short for ten complete maximum-duration puzzles. Allow additional time for breaks.');
  }
  return config;
}
function localParts(now,timezone){
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
}
function localDate(now,timezone){const p=localParts(now,timezone);return `${p.year}-${p.month}-${p.day}`;}
function windowInstant(date,time,timezone){
  const target=Date.parse(`${date}T${time}:00Z`);let result=target;
  for(let i=0;i<4;i++){const p=localParts(result,timezone),wall=Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);result+=target-wall;}
  const match=ms=>{const p=localParts(ms,timezone);return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`===`${date}T${time}`;};
  if(!match(result)||[-120,-90,-60,-30,30,60,90,120].some(m=>match(result+m*60000)))throw new Error('Study window falls at a nonexistent or ambiguous daylight-saving time; choose another hour.');
  return new Date(result).toISOString();
}
export function scheduleStatus(config, nowMs=Date.now()) {
  validateSchedule(config);
  const hash=sha256(JSON.stringify(config)),date=localDate(nowMs,config.timezone);
  const base={enabled:config.enabled,config,sha256:hash,server_now:new Date(nowMs).toISOString(),study_date:date,day_index:null,assignment:null,opens_at:null,closes_at:null,state:'draft'};
  if(!config.enabled)return base;
  const index=Math.round((Date.parse(date)-Date.parse(config.start_date))/86400000);
  if(index<0)return {...base,state:'before-study'};
  if(index>=config.days.length)return {...base,state:'after-study'};
  const opens=windowInstant(date,config.opens,config.timezone),closes=windowInstant(date,config.closes,config.timezone);
  if(Date.parse(closes)-Date.parse(opens)<config.days[index].seconds*10000)throw new Error('Actual window is too short after the daylight-saving transition.');
  return {...base,day_index:index+1,assignment:config.days[index],opens_at:opens,closes_at:closes,state:nowMs>=Date.parse(opens)&&nowMs<Date.parse(closes)?'open':'closed'};
}
/** Frozen ten-position cohort batch. Seeded selection within explicit source-rating bands. */
export function scheduledPool(bank,status,previousPools=[],participantId) {
  if(!/^[A-Za-z0-9_-]{1,32}$/.test(participantId??''))throw new Error('Use a pseudonymous participant ID (1–32 letters/numbers/dash/underscore).');
  const pilot=!status.enabled && status.state==='pilot-review';
  if(!pilot && (!status.enabled||status.state!=='open'))throw new Error('Study access is outside the scheduled window.');
  const config=status.config, used=new Set(previousPools.flatMap(p=>p.puzzles.map(r=>r.PuzzleId))),positions=new Set(previousPools.flatMap(p=>p.puzzles.map(positionKey)));
  const bankHash=sha256(JSON.stringify(bank)),puzzles=[];
  for(const band of config.bands){
    const count=status.assignment.quotas[band.id];if(!count)continue;
    const eligible=bank.puzzles.filter(r=>Number(r.Rating)>=band.min&&Number(r.Rating)<=band.max&&!used.has(r.PuzzleId)&&!positions.has(positionKey(r)))
      .map(row=>({row,key:sha256(`${bankHash}:${status.sha256}:${status.study_date}:${participantId}:${band.id}:${row.PuzzleId}`)})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
    const selected=[];for(const {row} of eligible){const key=positionKey(row);if(positions.has(key))continue;selected.push(row);positions.add(key);used.add(row.PuzzleId);if(selected.length===count)break;}
    if(selected.length!==count)throw new Error(`Band ${band.id} needs ${count} unused positions; only ${selected.length} available. No quota relaxed and no repeats issued.`);
    puzzles.push(...selected);
  }
  return {format:'puzzletrack-local-pool',version:1,source:{...bank.source,selection:bank.source.selection+'; scheduled study: exact difficulty quotas, ten positions; archived prior IDs/FEN keys excluded.',bank_sha256:bankHash,batch_date:status.study_date,batch_created_at:status.server_now,daily_algorithm:'sha256-scheduled-band-quota-v1',schedule_sha256:status.sha256,schedule_json:JSON.stringify(config),schedule_day:String(status.day_index),schedule_seconds:String(status.assignment.seconds),schedule_opens_at:status.opens_at??'',schedule_closes_at:status.closes_at??'',participant_id:participantId,study_phase:pilot?'pilot_review':'main_study',participant_seed:sha256(`${status.sha256}:${pilot?'pilot':status.study_date}:${participantId}:order`),batch_code:sha256(`${status.sha256}:${pilot?'pilot':status.study_date}:${participantId}`).slice(0,12),excluded_ids_sha256:sha256(JSON.stringify([...new Set(previousPools.flatMap(p=>p.puzzles.map(r=>r.PuzzleId)))].sort()))},puzzles};
}
