# PuzzleTrack v0.2 — Data Schema

All timestamps: ISO-8601 UTC strings (`new Date().toISOString()`).
All IDs: UUID v4 strings. Storage: single JSON blob `puzzletrack.v1` in `chrome.storage.local`
(key unchanged so v0.1 data is found; contents carry `schemaVersion: 2` and migrate on load).
Completed experimental records are append-only / immutable via the normal UI, except the
optional `manual_problem_id` annotation (audited via `problem_id_set` event) and
researcher-driven ChessTempo match application / unmatch (provenance-tracked).

Field provenance: **RAW** = measured or imported exactly, stored. **PROVENANCE** = stored
audit metadata. **DERIVED** = computed on demand at view/export time, never stored as raw.

## participants

| field | type | provenance | notes |
|---|---|---|---|
| `participant_id` | string (1–32, `[A-Za-z0-9_-]`) | RAW | e.g. `P01`; trimmed; cannot be empty |
| `created_at` | ISO timestamp | RAW | first session creation time |

## sessions

| field | type | provenance | notes |
|---|---|---|---|
| `session_id` | UUID | RAW | generated at Start Session |
| `participant_id` | string | RAW | FK → participants |
| `target_attempts` | integer 1–100 | RAW | number of puzzles |
| `time_limit_seconds` | integer | RAW | one of `900, 1800, 2700, 3600` |
| `started_at` | ISO timestamp | RAW | session creation time |
| `completed_at` | ISO timestamp \| null | RAW | set when final attempt finishes (or abandoned) |
| `status` | `"active" \| "completed" \| "abandoned"` | RAW | only one `active` session at a time |
| `study_tab_id` | number \| null | RAW | designated study tab id (numeric only — never URL/title/contents); null = not designated |

## attempts

| field | type | provenance | notes |
|---|---|---|---|
| `attempt_id` | UUID | RAW | one per Start Attempt |
| `session_id` | UUID | RAW | FK → sessions |
| `attempt_number` | integer ≥ 1 | RAW | 1-based, sequential, unique within session |
| `started_at` | ISO timestamp | RAW | exact Start Attempt time; timer source of truth |
| `ended_at` | ISO timestamp \| null | RAW | null while in progress |
| `elapsed_ms` | integer | RAW | exact wall-clock ms; never rounded; timeout ⇒ `time_limit_seconds * 1000` |
| `elapsed_seconds` | number | RAW | `elapsed_ms / 1000`, full precision |
| `time_limit_seconds` | integer | RAW | copied from session |
| `timed_out` | boolean | RAW | true only for timeouts |
| `experimental_result` | `"completed" \| "timeout" \| "aborted" \| null` | RAW | null while in progress; set once, locked |
| `focus_loss_count` | integer | RAW | present→away transitions (deduplicated; study-tab aware when designated) |
| `total_time_away_ms` | integer | RAW | union of away-windows, ms |
| `integrity_flag` | boolean | RAW | `focus_loss_count > 0`; means "interrupted", NOT "cheated" |
| `possibly_interrupted` | boolean | RAW | true if a browser-restart gap was detected mid-attempt |
| `problem_id` | string \| null | RAW (import) | from matched ChessTempo row, exact |
| `problem_rating` | number \| null | RAW (import) | from matched row, exact |
| `player_rating_before` | number \| null | RAW (import) | from matched row, exact |
| `player_rating_after` | number \| null | RAW (import) | from matched row, exact |
| `chesstempo_result` | string \| null | RAW (import) | raw result string, exact (correctness is a heuristic at analysis time) |
| `moves_used` | number \| null | RAW (import) | from matched row, exact |
| `average_moves` | number \| null | RAW (import) | from matched row, exact |
| `rating_change` | number \| null | RAW (import) | from matched row, exact |
| `difficulty_label` | string \| null | RAW (import) | from matched row, exact |
| `manual_problem_id` | string \| null | RAW | optional researcher annotation; aids matching; audited via event |
| `chesstempo_attempted_at` | ISO timestamp \| null | RAW (import) | raw ChessTempo attempt time, exact |
| `chesstempo_time_used_seconds` | number \| null | RAW (import) | raw ChessTempo time-used, exact |
| `chesstempo_import_id` | UUID \| null | PROVENANCE | which import supplied the chess data |
| `chesstempo_source_row` | integer \| null | PROVENANCE | 1-based data-row number in the imported file |
| `match_confidence` | `"exact" \| "high" \| "medium" \| "low" \| "unmatched" \| null` | PROVENANCE | null = unmatched |

## events (integrity / lifecycle)

One row per signal. Raw log is kept; derived fields are reproducible via `deriveIntegrity()`.

| field | type | notes |
|---|---|---|
| `event_id` | UUID | |
| `attempt_id` | UUID | FK → attempts |
| `timestamp` | ISO timestamp | |
| `event_type` | `"attempt_started" \| "tab_hidden" \| "tab_visible" \| "window_blur" \| "window_focus" \| "study_tab_inactive" \| "study_tab_active" \| "problem_id_set" \| "attempt_completed" \| "timeout" \| "abort"` | |
| `metadata` | object (optional) | e.g. `{ source: "background-windows-api" }`, `{ problem_id }`. Never URLs/titles/keys/contents |

### Derived-field rule (v0.2 interruption model)

Away = **study tab is not active OR browser window is not focused**
(document visibility folded into the same union). The first loss-signal opens one
away-window (`lossCount + 1`); further loss-signals while away are ignored; the window closes
only when every tracked axis is present again. When no study tab is designated, that axis is
ignored and derivations reproduce v0.1 exactly. Spec example (inactive+blur at 12:01,
focus at 12:01:20, active at 12:01:25) yields 25 s, not 45 s.

## imports (`ChessTempoImport`)

| field | type | notes |
|---|---|---|
| `importId` | UUID | |
| `importedAt` | ISO timestamp | |
| `originalFilename` | string | e.g. `history.csv` (name only; file contents never stored) |
| `fileFingerprint` | string (FNV-1a hex) | duplicate-import detection |
| `totalRows / validRows / partialRows / invalidRows` | integers | classification counts |
| `matchedRows / unmatchedRows` | integers | refreshed on every match change |
| `recognizedFields / missingFields` | string[] | header-mapping report |
| `unknownHeaders` | string[] | ignored columns (raw cells still kept per row) |

Normalized rows (`importRows[importId]`) keep every parsed value plus `validity`,
`validityNotes`, and the exact `raw` header→cell map for debugging.

## matches (`AttemptMatch`, keyed by attempt_id — 1:1 enforced)

| field | type | notes |
|---|---|---|
| `matchId` | UUID | |
| `attemptId` | string | FK → attempts |
| `chessTempoRowId` | string | `${importId}:row:${sourceRow}` |
| `importId` | UUID | FK → imports |
| `confidence` | `"exact" \| "high" \| "medium" \| "low"` | auto-applied only for `exact`, or `high` with a single candidate |
| `reasons` | string[] | human-readable scoring rationale |
| `timeDeltaMs` | number \| null | CT attemptedAt − PT ended_at |
| `matchedAt` | ISO timestamp | |
| `matchedBy` | `"auto" \| "manual"` | |
| `conflictResolved` | boolean | true when applied despite differing values via explicit researcher choice |

## pilotReview (pilot ground-truth metadata, keyed by attempt_id)

Stored SEPARATELY from raw observations. Changing review status never modifies
attempts, events, or chess fields. Excluded from CSV export (it is review
metadata, not raw data); included in JSON backup.

| field | type | notes |
|---|---|---|
| `attempt_id` | string | FK → attempts |
| `status` | `"unreviewed" \| "verified" \| "needs_review"` | researcher ground-truth mark |
| `note` | string (≤500 chars) | free-text note, local only |
| `updated_at` | ISO timestamp | |

## store envelope (`PuzzleTrackStore`)

```text
schemaVersion: 2
participants: Record<participant_id, Participant>
sessions:     Record<session_id, Session>
attempts:     Record<attempt_id, Attempt>
events:       Record<attempt_id, IntegrityEvent[]>
activeSessionId: string | null
activeAttemptId: string | null
lastHeartbeatMs: number | null   # background heartbeat; restart-gap detection
imports:      Record<importId, ChessTempoImport>
importRows:   Record<importId, ChessTempoAttempt[]>
matches:      Record<attemptId, AttemptMatch>
pilotReview:  Record<attemptId, PilotReview>   # review metadata only, never raw
```

v1 blobs (no `schemaVersion`) migrate on load: sessions gain `study_tab_id: null`,
attempts gain null/empty v0.2 fields, and empty `imports`/`importRows`/`matches`/
`pilotReview` are added. Every v1 record is preserved; migration is pure and unit-tested.

## concurrent-write safety (merge-save)

The popup/side-panel tick loop saves every 250 ms while the background worker
concurrently appends focus events. Plain last-write-wins drops events, so all
concurrent mutation paths use `Repository.saveMerged`: events union by `event_id`
(lossless), finished attempt records win over in-progress ones (never resurrected),
stale nulls never erase freshly matched chess fields, the
`possibly_interrupted` latch is OR-merged, heartbeats take the max, derived
integrity fields are recomputed from the merged log, and dangling active
pointers are cleared. Pure and unit-tested (`mergeStores`). Intentional
replace/remove operations (session delete, backup restore, unmatch) keep plain
`saveStore` semantics.

## CSV mapping

One row per attempt, header (31 cols):

```text
participant_id,session_id,attempt_id,attempt_number,started_at,ended_at,elapsed_ms,elapsed_seconds,time_limit_seconds,timed_out,experimental_result,focus_loss_count,total_time_away_ms,integrity_flag,problem_id,problem_rating,player_rating_before,player_rating_after,chesstempo_result,moves_used,average_moves,rating_change,difficulty_label,chesstempo_attempted_at,chesstempo_time_used_seconds,match_confidence,chesstempo_import_id,chesstempo_source_row,relative_difficulty,timer_difference_seconds,away_time_percentage
```

- `participant_id` joined from the parent session.
- Booleans → `TRUE`/`FALSE`; null → empty cell; RFC-4180 quoting for `, " \n \r`.
- `elapsed_ms` exact; `elapsed_seconds` full precision (`elapsed_ms / 1000`).
- RAW vs DERIVED: the last three columns (`relative_difficulty`,
  `timer_difference_seconds`, `away_time_percentage`) are **DERIVED** — computed at
  export from raw values (`problem_rating − player_rating_before`;
  `elapsed_seconds − chesstempo_time_used_seconds`; `total_time_away_ms / elapsed_ms`),
  null when inputs are missing (zero elapsed → null, never Infinity). Everything
  before them is **RAW** or **PROVENANCE**.

## JSON backup

`puzzletrack-backup-<iso>.json`: `{ format, formatVersion, schemaVersion,
exportedAt, store }` with the full store (participants, sessions, attempts, events,
imports, import rows, matches, pilotReview). Restoring validates the envelope and migrates older
schemas; restore replaces current data only after double confirmation.

## pilot validation (`src/validation/pilotValidator.ts`, read-only)

`validateStore` returns `{ valid, errors[], warnings[], summary }` without
modifying anything. Error classes: session integrity (participant, timestamps,
target/limit, completed_at, sequential numbers, counts, summary reconciliation),
attempt timing coherence (UUID, end ≥ start, elapsed ≥ 0, seconds↔ms agreement,
timeout/result/limit consistency), event-log integrity (start + terminal events,
no pre-start events, post-end events only within a 2 s merge-straggler tolerance,
unique ids, away ≤ elapsed, flag↔loss agreement), match/provenance integrity
(1:1 both directions, provenance present, reasons on exact/high, no chess
values without a match link), derived recomputation (finite, away % in [0,1]),
duplicate ids. Warnings (pilot QA, not failures): unmatched attempts, timer
agreement REVIEW (>2–5 s) / WARNING (>5 s), orphan review entries.
