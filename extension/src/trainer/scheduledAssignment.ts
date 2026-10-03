import type { TrainingPool, StudyScheduleConfig } from './types.js';
/** Validate the complete frozen scheduled batch; do not silently relax a quota. */
export async function validateScheduledAssignment(pool: TrainingPool): Promise<void> {
  const s=pool.source;if(!s.schedule_sha256)return;
  if(!s.schedule_json || !/^[A-Za-z0-9_-]{1,32}$/.test(s.participant_id??'') || !['pilot_review','main_study'].includes(s.study_phase??'') || !/^[a-f0-9]{64}$/.test(s.participant_seed??''))throw new Error('Scheduled assignment provenance is incomplete.');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s.schedule_json));
  const hash=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==s.schedule_sha256)throw new Error('Schedule checksum does not match its archived configuration.');
  const config=JSON.parse(s.schedule_json) as StudyScheduleConfig;
  const index=Number(s.schedule_day)-1,day=config.days?.[index];
  if(config.format!=='puzzletrack-study-schedule'||config.version!==1||!Array.isArray(config.bands)||!Number.isInteger(index)||index<0||!day||day.seconds!==Number(s.schedule_seconds)||pool.puzzles.length!==10)throw new Error('Scheduled day or fixed time/count is inconsistent.');
  for(const band of config.bands){
    const count=pool.puzzles.filter(row=>Number(row.Rating)>=band.min&&Number(row.Rating)<=band.max).length;
    if(count!==day.quotas[band.id])throw new Error(`Scheduled difficulty quota for ${band.id} is inconsistent.`);
  }
  if(pool.puzzles.some(row=>config.bands.filter(b=>Number(row.Rating)>=b.min&&Number(row.Rating)<=b.max).length!==1))throw new Error('Scheduled puzzle lies outside one unambiguous difficulty band.');
  if(s.study_phase==='main_study' && (!config.enabled||!Number.isFinite(Date.parse(s.schedule_opens_at??''))||!Number.isFinite(Date.parse(s.schedule_closes_at??''))||Date.parse(s.schedule_closes_at!)<=Date.parse(s.schedule_opens_at!)))throw new Error('Main study assignment needs an enabled archived window.');
}
