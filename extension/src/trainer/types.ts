export interface TablebaseSnapshot { fen: string; url: string; retrieved_at: string; raw: string; sha256: string }
export interface TrainingPool {
  format: 'puzzletrack-local-pool';
  version: 1;
  source: { url: string; license: 'CC0-1.0'; retrieved_at: string; selection: string; [key: string]: string };
  puzzles: Record<string, string>[];
  initial_tablebases?: Record<string, TablebaseSnapshot>;
}
export interface FrozenTrainingPool { sha256: string; data: TrainingPool; raw_json: string }
export interface LocalPly {
  ply: number; actor: 'participant' | 'opponent'; uci: string; san: string;
  recorded_at: string; elapsed_ms: number; fen_before: string; fen_after: string;
  step_number: number; step_elapsed_ms: number | null;
  reference_match: boolean | null;
}
export interface LocalTrial {
  task_type: 'endgame-puzzle-sequence-v1';
  puzzle_id: string; rating: number; rating_deviation: number;
  rating_source: 'lichess-puzzles'; pool_sha256: string; source_retrieved_at: string;
  themes: string[]; initial_fen: string; presented_fen: string; current_fen: string;
  solution_uci: string[]; solution_index: number; participant_step: number;
  turn_started_at: string;
  turn_presentations: { step_number: number; presented_at: string }[]; presented_at: string | null;
  selected_uci: string | null; reference_match: boolean | null; alternative_checkmate: boolean | null;
  outcome: 'solved' | 'incorrect' | 'timeout' | 'aborted' | null;
  plies: LocalPly[];
  initial_tablebase?: TablebaseSnapshot;
}

export interface StudyScheduleConfig {
  format: 'puzzletrack-study-schedule'; version: 1; revision: string; enabled: boolean;
  timezone: string; start_date: string | null; opens: string | null; closes: string | null;
  difficulty_note: string; bands: {id: string; min: number; max: number}[];
  days: {seconds: number; quotas: Record<string, number>}[];
}
export interface StudyScheduleStatus {
  enabled: boolean; config: StudyScheduleConfig; sha256: string; server_now: string;
  study_date: string; day_index: number | null; assignment: StudyScheduleConfig['days'][number] | null;
  opens_at: string | null; closes_at: string | null;
  state: 'draft' | 'before-study' | 'after-study' | 'closed' | 'open';
}
