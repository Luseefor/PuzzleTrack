import { newUuid } from '../utils/ids.js';
import type { PuzzleTrackStore, ResearchEvent } from '../models/types.js';

function moveInput(move: string): string {
  const value = move.trim();
  if (!value || value.length > 32 || /[\r\n]/.test(value)) throw new Error('Enter a move or candidate label (1–32 characters).');
  return value;
}

function append(store: PuzzleTrackStore, event: ResearchEvent): void {
  store.researchEvents ??= {};
  (store.researchEvents[event.attempt_id] ??= []).push(event);
}

export function recordSearchChoice(store: PuzzleTrackStore, attemptId: string, kind: 'candidate' | 'decision', move: string,
  stopReason: Extract<ResearchEvent, {kind:'decision'}>['stop_reason'] = 'other', nowMs = Date.now(), stepNumber?: number): ResearchEvent {
  const a = store.attempts[attemptId];
  if (!a || a.ended_at !== null) throw new Error('Search choices must be recorded during an active attempt; retrospective times are not invented.');
  if (!store.sessions[a.session_id]?.study?.search_capture_enabled) throw new Error('Enable provisional search capture in session setup first.');
  const elapsed = nowMs - Date.parse(a.started_at);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= a.time_limit_seconds * 1000) throw new Error('Choice is outside the attempt time window.');
  if ((store.researchEvents?.[attemptId] ?? []).some(e => e.kind === 'decision' && (e.step_number ?? 1) === (stepNumber ?? 1))) throw new Error('The final decision has already been recorded.');
  if (!['satisfied', 'time_pressure', 'exhausted_options', 'other'].includes(stopReason)) throw new Error('Invalid stop reason.');
  if (stepNumber !== undefined && (!Number.isInteger(stepNumber) || stepNumber < 1)) throw new Error('Invalid research step number.');
  const common = { ...(stepNumber === undefined ? {} : { step_number: stepNumber }), event_id: newUuid(), attempt_id: attemptId, recorded_at: new Date(nowMs).toISOString(), method: stepNumber === undefined ? 'manual-search-v1-provisional' as const : 'endgame-search-v1-provisional' as const, move: moveInput(move), elapsed_ms: elapsed };
  const event: ResearchEvent = kind === 'candidate' ? { ...common, kind } : { ...common, kind, stop_reason: stopReason };
  append(store, event); return event;
}

export type BenchmarkInput = Omit<Extract<ResearchEvent, {kind:'benchmark'}>, 'event_id' | 'attempt_id' | 'recorded_at' | 'method' | 'kind' | 'source' | 'perspective'>;
export function recordBenchmark(store: PuzzleTrackStore, attemptId: string, input: BenchmarkInput, nowMs = Date.now()): void {
  const a = store.attempts[attemptId];
  if (!a || a.ended_at === null) throw new Error('Benchmarks can be entered only after the trial ends.');
  if (!(store.researchEvents?.[attemptId] ?? []).some(e => e.kind === 'decision')) throw new Error('Record a final choice before attaching its benchmark.');
  moveInput(input.best_move);
  for (const text of [input.engine_name, input.engine_version, input.configuration, input.position_reference]) {
    if (!text.trim() || text.length > 1000) throw new Error('Benchmark needs engine name/version, configuration and an authorized position reference.');
  }
  if (![input.chosen_cp, input.best_cp, input.threshold_cp].every(Number.isFinite) || input.threshold_cp < 0 || input.best_cp < input.chosen_cp) throw new Error('Use finite solver-perspective centipawns; best must be at least chosen and threshold nonnegative.');
  append(store, { ...input, event_id: newUuid(), attempt_id: attemptId, recorded_at: new Date(nowMs).toISOString(), method: 'manual-search-v1-provisional', kind: 'benchmark', source: 'researcher_supplied', perspective: 'solver' });
}

export function summarizeSearch(events: ResearchEvent[]) {
  const first = events.find(e => e.kind === 'candidate' && (e.step_number ?? 1) === 1);
  const decision = events.find(e => e.kind === 'decision' && (e.step_number ?? 1) === 1);
  const benchmark = [...events].reverse().find(e => e.kind === 'benchmark');
  const gap = benchmark?.kind === 'benchmark' ? benchmark.best_cp - benchmark.chosen_cp : null;
  return {
    first_candidate: first?.kind === 'candidate' ? first.move : null,
    first_candidate_elapsed_ms: first?.kind === 'candidate' ? first.elapsed_ms : null,
    final_choice: decision?.kind === 'decision' ? decision.move : null,
    final_choice_elapsed_ms: decision?.kind === 'decision' ? decision.elapsed_ms : null,
    stop_reason: decision?.kind === 'decision' ? decision.stop_reason : null,
    candidate_count: events.filter(e => e.kind === 'candidate').length,
    evaluation_gap_cp: gap,
    missed_better_option: gap !== null && benchmark?.kind === 'benchmark' ? gap > benchmark.threshold_cp : null,
  };
}
