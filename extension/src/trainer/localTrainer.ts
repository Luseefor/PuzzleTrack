import { validateScheduledAssignment } from './scheduledAssignment.js';
import { Chess } from 'chess.js';
import type { PuzzleTrackStore, Session } from '../models/types.js';
import { createSession, startAttempt, completeAttempt, timeoutAttempt, abortAttempt } from '../session/sessionManager.js';
import { recordSearchChoice } from '../research/searchCapture.js';
import { createStudyPlan } from '../research/studyPlan.js';
import type { FrozenTrainingPool, TrainingPool, LocalTrial } from './types.js';

export function playUci(chess: Chess, uci: string) {
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) throw new Error('Enter a legal UCI move, such as e2e4.');
  return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), ...(uci[4] ? { promotion: uci[4] } : {}) });
}
export function preparePosition(row: Record<string, string>): { presentedFen: string; solution: string[] } {
  if (typeof row.FEN !== 'string' || !row.FEN.trim() || row.FEN.trim().split(/\s+/).length !== 6) throw new Error('Puzzle requires an explicit complete FEN.');
  const moves = row.Moves?.trim().split(/\s+/) ?? [];
  if (moves.length < 2) throw new Error('Puzzle needs a preceding opponent move and a solution.');
  const chess = new Chess(row.FEN);
  playUci(chess, moves[0]!);
  const presentedFen = chess.fen();
  if (chess.isGameOver()) throw new Error('Puzzle has no playable solver position.');
  for (const move of moves.slice(1)) playUci(chess, move);
  return { presentedFen, solution: moves.slice(1) };
}
export async function freezeTrainingPool(text: string): Promise<FrozenTrainingPool> {
  if (text.length > 8_000_000) throw new Error('Use a reviewed pool under 8 MB.');
  const data = JSON.parse(text) as TrainingPool;
  if (!data || data.format !== 'puzzletrack-local-pool' || data.version !== 1 || !data.source || data.source.license !== 'CC0-1.0' || !data.source.url || !Number.isFinite(Date.parse(data.source.retrieved_at)) || !data.source.selection || !Array.isArray(data.puzzles) || data.puzzles.length < 1 || data.puzzles.length > 2000) throw new Error('Invalid or unsupported frozen CC0 pool.');
  const ids = new Set<string>();
  for (const row of data.puzzles) {
    if (!row || typeof row !== 'object' || Object.values(row).some(v => typeof v !== 'string') || !/^[A-Za-z0-9_-]{1,64}$/.test(row.PuzzleId ?? '') || ids.has(row.PuzzleId!)) throw new Error('Invalid or duplicate puzzle ID.');
    ids.add(row.PuzzleId!);
    if (!(row.Themes ?? '').split(/\s+/).includes('endgame') || !/^\d+$/.test(row.Rating ?? '') || !/^\d+$/.test(row.RatingDeviation ?? '') || Number(row.Rating) > 4000) throw new Error('Use rated endgame-themed puzzles with rating uncertainty.');
    const prepared = preparePosition(row);
    if (new Chess(prepared.presentedFen).board().flat().filter(Boolean).length > 7) throw new Error('Use endgame positions with at most seven pieces.');
    // Validate FEN and the entire supplied legal continuation.
  }
  if (data.initial_tablebases) {
    for (const [fen, probe] of Object.entries(data.initial_tablebases)) {
      if (!probe || probe.fen !== fen || typeof probe.raw !== 'string' || !/^https:\/\/tablebase\.lichess\.ovh\/standard\?fen=/.test(probe.url) || !Number.isFinite(Date.parse(probe.retrieved_at))) throw new Error('Invalid archived tablebase provenance.');
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(probe.raw));
      const sha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
      if (sha !== probe.sha256) throw new Error('Archived tablebase checksum does not match its raw response.');
      JSON.parse(probe.raw);
    }
  }
  await validateScheduledAssignment(data);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return { sha256: [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join(''), data, raw_json: text };
}
export interface LocalSetup { participant: string; protocol: string; seed: string; min: number; max: number; ratingMin: number; ratingMax: number; seconds: number; timeOptions?: readonly number[]; excludedPuzzleIds?: string[]; excludedPositionKeys?: string[]; skill: number | null; skillSource: string; practiceMinutes?: number | null; practiceNotes?: string }
export async function makeLocalPlan(pool: FrozenTrainingPool, setup: LocalSetup) {
  if (!setup.protocol.trim() || !Number.isFinite(setup.ratingMin) || !Number.isFinite(setup.ratingMax) || setup.ratingMin > setup.ratingMax) throw new Error('Enter a protocol revision and valid difficulty range.');
  if (setup.skill !== null && (!Number.isFinite(setup.skill) || setup.skill < 0 || !setup.skillSource.trim())) throw new Error('Skill rating needs a valid value and source/scale.');
  if(setup.practiceMinutes!==undefined && setup.practiceMinutes!==null && (!Number.isInteger(setup.practiceMinutes)||setup.practiceMinutes<0||setup.practiceMinutes>1000000))throw new Error('Practice minutes must be a nonnegative whole number, or blank.');
  if((setup.practiceNotes??'').length>1000)throw new Error('Practice notes must be 1000 characters or fewer.');
  const excluded = new Set(setup.excludedPuzzleIds ?? []);
  const excludedPositions = new Set(setup.excludedPositionKeys ?? []);
  const refs = pool.data.puzzles.filter(row => !excluded.has(row.PuzzleId!) && Number(row.Rating) >= setup.ratingMin && Number(row.Rating) <= setup.ratingMax && (!excludedPositions.size || !excludedPositions.has(preparePosition(row).presentedFen.split(' ').slice(0,4).join(' ')))).map(row => ({ id: row.PuzzleId!, rating: Number(row.Rating), rating_source: 'lichess-puzzles', task_type: 'endgame-puzzle-sequence-v1' }));
  return createStudyPlan(refs, setup.seed, setup.min, setup.max, setup.timeOptions);
}
export function beginLocalSession(store: PuzzleTrackStore, pool: FrozenTrainingPool, setup: LocalSetup, plan: Awaited<ReturnType<typeof makeLocalPlan>>, atMs: number): Session {
  if(pool.data.source.schedule_sha256 && (pool.data.source.participant_id!==setup.participant.trim() || Number(pool.data.source.schedule_seconds)!==setup.seconds || plan.ordered_puzzles.length!==10 || plan.time_assignment || plan.ordered_puzzles.some(p=>!pool.data.puzzles.some(row=>row.PuzzleId===p.id))))throw new Error('Scheduled participant, fixed time or ten-puzzle assignment mismatch.');
  store.localPools ??= {};
  store.localPools[pool.sha256] ??= pool;
  const session = createSession(store, setup.participant, plan.ordered_puzzles.length, setup.seconds, atMs);
  session.protocol_id = setup.protocol.trim();
  session.study = { protocol_id: session.protocol_id, task_source: 'lichess-puzzles:local:endgame-puzzle-sequence-v1', skill_rating: setup.skill, skill_rating_source: setup.skill === null ? null : setup.skillSource.trim(), skill_recorded_at: setup.skill === null ? null : new Date(atMs).toISOString(), search_capture_enabled: true, plan, local_pool_sha256: pool.sha256 };
  if(setup.practiceMinutes!==undefined || setup.practiceNotes!==undefined)session.study.practice_report={minutes:setup.practiceMinutes??null,notes:setup.practiceNotes?.trim()??'',recorded_at:new Date(atMs).toISOString(),method:'self-report-since-previous-session-or-24h-first'};
  if (setup.excludedPuzzleIds) session.study.excluded_puzzle_ids = [...new Set(setup.excludedPuzzleIds)].sort();
  if (setup.excludedPositionKeys) session.study.excluded_position_keys = [...new Set(setup.excludedPositionKeys)].sort();
  return session;
}
export function startLocalTrial(store: PuzzleTrackStore, sessionId: string, atMs: number) {
  const session = store.sessions[sessionId], pool = store.localPools?.[session?.study?.local_pool_sha256 ?? ''];
  if (!session || !pool || !session.study?.plan) throw new Error('Session has no frozen local puzzle pool.');
  const attempt = startAttempt(store, sessionId, atMs);
  const ref = session.study.plan.ordered_puzzles[attempt.attempt_number - 1]!;
  const row = pool.data.puzzles.find(p => p.PuzzleId === ref.id)!;
  if (!row) throw new Error('Assigned puzzle is missing from frozen data.');
  const position = preparePosition(row);
  attempt.manual_problem_id = ref.id;
  attempt.local_trial = { task_type: 'endgame-puzzle-sequence-v1', puzzle_id: ref.id, rating: Number(row.Rating), rating_deviation: Number(row.RatingDeviation), rating_source: 'lichess-puzzles', pool_sha256: pool.sha256, source_retrieved_at: pool.data.source.retrieved_at, themes: row.Themes!.split(/\s+/), initial_fen: row.FEN!, presented_fen: position.presentedFen, current_fen: position.presentedFen, solution_index: 0, participant_step: 1, turn_started_at: new Date(atMs).toISOString(), outcome: null, turn_presentations: [], plies: [], ...(pool.data.initial_tablebases?.[position.presentedFen] ? { initial_tablebase: pool.data.initial_tablebases[position.presentedFen] } : {}), solution_uci: position.solution, presented_at: null, selected_uci: null, reference_match: null, alternative_checkmate: null };
  return attempt;
}
export function localChoice(store: PuzzleTrackStore, id: string, move: string, kind: 'candidate' | 'decision', reason: 'satisfied' | 'time_pressure' | 'exhausted_options' | 'other', atMs: number): void {
  const a = store.attempts[id];
  if (!a?.local_trial || a.ended_at) throw new Error('No active local trial.');
  if (atMs >= Date.parse(a.started_at) + a.time_limit_seconds * 1000) { closeLocalTrial(store, id, atMs); return; }
  const trial = a.local_trial, chess = new Chess(trial.current_fen);
  const chosen = playUci(chess, move.trim().toLowerCase());
  const uci = chosen.from + chosen.to + (chosen.promotion ?? '');
  recordSearchChoice(store, id, kind, uci, reason, atMs, trial.participant_step);
  if (kind !== 'decision') return;
  const match = uci === trial.solution_uci[trial.solution_index];
  const alternativeMate = !match && chess.isCheckmate();
  trial.plies.push({ ply: trial.plies.length + 1, actor: 'participant', uci, san: chosen.san, recorded_at: new Date(atMs).toISOString(), elapsed_ms: atMs - Date.parse(a.started_at), step_elapsed_ms: atMs - Date.parse(trial.turn_started_at), step_number: trial.participant_step, reference_match: match, fen_before: trial.current_fen, fen_after: chess.fen() });
  trial.selected_uci = uci; trial.reference_match = match; trial.alternative_checkmate = alternativeMate;
  trial.current_fen = chess.fen();
  if (!match && !alternativeMate) { trial.outcome = 'incorrect'; completeAttempt(store, id, atMs); return; }
  trial.solution_index++;
  if (chess.isCheckmate() || alternativeMate || trial.solution_index >= trial.solution_uci.length) { trial.outcome = 'solved'; completeAttempt(store, id, atMs); return; }
  const reply = trial.solution_uci[trial.solution_index]!;
  const before = chess.fen(), opponent = playUci(chess, reply);
  trial.plies.push({ ply: trial.plies.length + 1, actor: 'opponent', uci: reply, san: opponent.san, recorded_at: new Date(atMs).toISOString(), elapsed_ms: atMs - Date.parse(a.started_at), step_elapsed_ms: null, step_number: trial.participant_step, reference_match: null, fen_before: before, fen_after: chess.fen() });
  trial.solution_index++; trial.current_fen = chess.fen();
  if (trial.solution_index >= trial.solution_uci.length || chess.isGameOver()) { trial.outcome = 'solved'; completeAttempt(store, id, atMs); return; }
  trial.participant_step++; trial.turn_started_at = new Date(atMs).toISOString();
}
export function closeLocalTrial(store: PuzzleTrackStore, id: string, atMs: number, abort = false): void {
  const trial = store.attempts[id]?.local_trial;
  if (!trial) throw new Error('Not a local trial.');
  if (abort && atMs < Date.parse(store.attempts[id]!.started_at) + store.attempts[id]!.time_limit_seconds * 1000) { abortAttempt(store, id, atMs); trial.outcome = 'aborted'; }
  else { timeoutAttempt(store, id, atMs); trial.outcome = 'timeout'; }
}
export function visibleTrial(trial: LocalTrial, finished: boolean) {
  return { puzzle_id: trial.puzzle_id, fen: trial.current_fen, participant_step: trial.participant_step, selected_uci: trial.selected_uci, ...(finished ? { reference_move: trial.solution_uci[trial.solution_index], outcome: trial.outcome, reference_match: trial.reference_match, alternative_checkmate: trial.alternative_checkmate } : {}) };
}
