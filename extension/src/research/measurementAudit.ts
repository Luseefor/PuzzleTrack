import { COLLECTOR_VERSION, type PuzzleTrackStore } from '../models/types.js';
import { firstMoveBenchmark } from '../trainer/benchmark.js';
import { validateStore } from '../validation/pilotValidator.js';
import { summarizeSearch } from './searchCapture.js';

/** Read-only availability audit, not a scientific readiness score. */
export function buildMeasurementAudit(store: PuzzleTrackStore) {
  const validation = validateStore(store);
  const records = Object.values(store.attempts).filter(a => a.ended_at !== null).map(a => {
    const session = store.sessions[a.session_id];
    const events = store.researchEvents?.[a.attempt_id] ?? [];
    // The primary endpoint concerns the initial position; later candidates cannot fill its missingness.
    const initial = events.filter(e => e.kind === 'benchmark' || (e.step_number ?? 1) === 1);
    const search = summarizeSearch(initial);
    const wdl = firstMoveBenchmark(a.local_trial);
    const candidate = initial.find(e => e.kind === 'candidate');
    const decision = initial.find(e => e.kind === 'decision');
    const paired = candidate?.kind === 'candidate' && decision?.kind === 'decision' && candidate.elapsed_ms <= decision.elapsed_ms;
    const stoppedOnFirst = paired ? search.first_candidate === search.final_choice && search.stop_reason === 'satisfied' : null;
    const cpProxy = stoppedOnFirst === null || search.missed_better_option === null ? null : stoppedOnFirst && search.missed_better_option;
    const wdlProxy = stoppedOnFirst === null || wdl.first_move_wdl_regret === null ? null : stoppedOnFirst && wdl.first_move_wdl_regret;
    return {
      attempt_id: a.attempt_id, session_id: a.session_id, participant_id: session?.participant_id ?? null,
      experimental_result: a.experimental_result, local_outcome: a.local_trial?.outcome ?? null,
      elapsed_ms: a.elapsed_ms, assigned_limit_seconds: a.time_limit_seconds,
      timing_note: a.timed_out ? 'Deadline-censored: elapsed is the configured deadline, not observed thinking completion.' : 'Browser wall-clock interval; response timestamp, not thought onset.',
      source_rating: a.local_trial?.rating ?? a.problem_rating,
      source_rating_scale: a.local_trial?.rating_source ?? (a.problem_rating === null ? null : 'chesstempo'),
      assignment_source: store.localPools?.[session?.study?.local_pool_sha256??'']?.data.source ?? null,
      prior_chess_practice: session?.study?.practice_report ?? null,
      reported_skill_rating: session?.study?.skill_rating ?? null,
      reported_skill_source: session?.study?.skill_rating_source ?? null,
      calibrated_local_relative_difficulty: null,
      first_step_search: search, first_candidate_before_decision: paired,
      first_candidate_to_decision_ms: paired && candidate?.kind === 'candidate' && decision?.kind === 'decision' ? decision.elapsed_ms - candidate.elapsed_ms : null,
      recorded_candidate_count_all_steps: events.filter(e => e.kind === 'candidate').length,
      research_event_ids: events.map(e => e.event_id),
      participant_steps: a.local_trial?.plies.filter(p => p.actor === 'participant').map(p => ({ step_number: p.step_number, uci: p.uci, fen_before: p.fen_before, recorded_at: p.recorded_at, elapsed_ms: p.elapsed_ms, step_elapsed_ms: p.step_elapsed_ms, reference_match: p.reference_match })) ?? null,
      focus_loss_count: a.focus_loss_count, time_away_ms: a.total_time_away_ms,
      away_fraction: a.elapsed_ms > 0 ? a.total_time_away_ms / a.elapsed_ms : null,
      stopped_satisfied_on_first_candidate: stoppedOnFirst,
      first_step_cp_proxy: cpProxy, first_step_wdl_proxy: wdlProxy,
      ...wdl,
      benchmark_note: 'CP is researcher supplied and unverified; WDL only identifies a worse outcome class. Neither proves cognitive bias.',
      plan_seed: session?.study?.plan?.seed ?? null,
      pool_sha256: a.local_trial?.pool_sha256 ?? session?.study?.plan?.pool_sha256 ?? null,
      possibly_interrupted: a.possibly_interrupted, integrity_flag: a.integrity_flag,
    };
  });
  const measures = [
    { id: 'duration', label: 'Attempt duration / assigned time', kind: 'recorded', available: records.filter(r => Number.isFinite(r.elapsed_ms) && Number.isFinite(r.assigned_limit_seconds)).length, rule: 'attempt.elapsed_ms; time_limit_seconds. Timeouts are deadline-censored; millisecond storage is not calibrated measurement accuracy.' },
    { id: 'step_time', label: 'Local participant move intervals', kind: 'derived', available: records.filter(r => r.participant_steps?.some(p => p.step_elapsed_ms !== null)).length, rule: 'local_trial.plies (participant only): step_elapsed_ms = move action timestamp - turn_started_at. Includes rendering/reporting/move-entry time; presentation callbacks are separately archived and are not calibrated visual onset.' },
    { id: 'candidate_interval', label: 'Initial candidate-to-decision interval', kind: 'derived', available: records.filter(r => r.first_candidate_to_decision_ms !== null).length, rule: 'Initial decision.elapsed_ms - first candidate.elapsed_ms, requiring candidate <= decision. Reporting interval, not complete search duration.' },
    { id: 'outcome', label: 'Recorded termination / local reference outcome', kind: 'recorded', available: records.filter(r => r.experimental_result !== null).length, rule: 'experimental_result distinguishes completed/timeout/aborted; local_trial.outcome distinguishes solved/incorrect/timeout/aborted. Incorrect means legal reference mismatch, not proof of a worse move; alternative immediate checkmate is accepted.' },
    { id: 'focus', label: 'Recorded focus / interruption indicators', kind: 'recorded', available: records.filter(r => r.away_fraction !== null).length, rule: 'focus_loss_count; total_time_away_ms / elapsed_ms if elapsed > 0. Integrity and recovery flags stay separate. Unobserved crashes or closed-page events cannot be reconstructed; zero does not establish uninterrupted cognition.' },
    { id: 'difficulty', label: 'Source puzzle rating', kind: 'source metadata', available: records.filter(r => r.source_rating !== null).length, rule: 'local_trial.rating or problem_rating, with scale and frozen source. Rating is not an individual difficulty estimate.' },
    { id: 'reported_skill', label: 'Reported participant rating', kind: 'reported', available: records.filter(r => r.reported_skill_rating !== null).length, rule: 'session.study.skill_rating and source; repeated across attempts, not independent skill observations or an AI assessment.' },
    { id: 'first_candidate', label: 'Initial-position candidate report', kind: 'reported', available: records.filter(r => r.first_step_search.first_candidate !== null).length, rule: 'First candidate where step_number is 1 or absent; button elapsed_ms, not thought onset.' },
    { id: 'decision', label: 'Initial-position decision / stop reason', kind: 'reported', available: records.filter(r => r.first_step_search.final_choice !== null).length, rule: 'First decision where step_number is 1 or absent. Reason is participant report.' },
    { id: 'cp_benchmark', label: 'Initial-position centipawn gap', kind: 'provisional derived', available: records.filter(r => r.first_step_search.evaluation_gap_cp !== null).length, rule: 'Last researcher-supplied benchmark: best_cp - chosen_cp, solver perspective. Preserve engine/configuration/position/output; the collector does not verify engine output or position binding.' },
    { id: 'wdl_benchmark', label: 'Initial-position WDL regret', kind: 'derived', available: records.filter(r => r.first_move_wdl_regret !== null).length, rule: 'Archived initial tablebase: invert child perspective; loss=0, draw=1, win=2; chosen rank < best rank, using archived moves[0] as the API-ranked best move. Cursed/blessed or absent moves yield null. No within-class improvement measure.' },
    { id: 'cp_proxy', label: 'Satisfied stopping + missed option (CP proxy)', kind: 'provisional derived', available: records.filter(r => r.first_step_cp_proxy !== null).length, rule: 'Requires first candidate recorded before decision and CP benchmark. candidate == final choice AND reason == satisfied AND best_cp - chosen_cp > threshold_cp. Missing prerequisite => null, not false. This operational proxy is not a validated diagnosis.' },
    { id: 'wdl_proxy', label: 'Satisfied stopping + worse outcome (WDL proxy)', kind: 'provisional derived', available: records.filter(r => r.first_step_wdl_proxy !== null).length, rule: 'Requires first candidate recorded before decision and WDL benchmark. candidate == final choice AND reason == satisfied AND WDL regret. Separate endpoint from CP proxy.' },
    { id: 'replay', label: 'Saved seed / pool reference', kind: 'provenance', available: records.filter(r => r.plan_seed !== null && r.pool_sha256 !== null).length, rule: 'Saved study.plan.seed and pool SHA-256; full JSON includes pool and algorithm. Presence alone does not verify hash or replay.' },
    { id: 'relative_skill', label: 'Calibrated local difficulty relative to skill', kind: 'not implemented', available: 0, rule: 'No calibrated player model or AI skill assessment. Cross-scale subtraction is unsupported. Legacy ChessTempo relative_difficulty is separate.' },
    { id: 'cognition', label: 'Direct cognition / unreported search', kind: 'not measured', available: 0, rule: 'No direct cognition scale, mental search trace, or total considered-move count. Time and manual reports are behavioral observations. Causal effects require a prespecified analysis/design.' },
  ].map(m => ({ ...m, denominator: records.length, unavailable: records.length - m.available }));
  const warningGroups = [...new Set(validation.warnings.map(w => w.code))].map(code => {
    const findings = validation.warnings.filter(w => w.code === code);
    return { code, findings: findings.length, attempt_ids: [...new Set(findings.flatMap(w => w.attemptId ? [w.attemptId] : []))], session_ids: [...new Set(findings.flatMap(w => w.sessionId ? [w.sessionId] : []))] };
  });
  return { format: 'puzzletrack-measurement-audit-v1', generated_by_collector_version: COLLECTOR_VERSION, scope: 'Entire stored dataset; coverage denominator is finished attempts, including aborts and timeouts. No automatic exclusions.',
    collector_versions: [...new Set(Object.values(store.sessions).map(s => s.collector_version ?? null))],
    finished_attempts: records.length, in_progress_attempts: Object.values(store.attempts).length - records.length,
    validation, warning_groups: warningGroups, measures, records,
    interpretation: 'Structural validity does not establish measurement completeness or scientific validity. Null means unavailable. False requires all proxy prerequisites. Availability includes provisional values; review errors, missingness, interruptions and benchmark provenance before analysis.' };
}
