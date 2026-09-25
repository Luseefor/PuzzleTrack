# PuzzleTrack v0.2

Local-first Chrome extension (Manifest V3, strict TypeScript) for a university research project studying
chess endgame problem solving alongside ChessTempo.

PuzzleTrack is a **research data collector**: experimental timing, session tracking, focus/interruption events,
manual ChessTempo history import with deterministic matching, and structured CSV/JSON export.
Everything stays local. No cloud, no accounts, no analytics. No scraping — ever.

## What it does

- Session setup: Participant ID (e.g. `P01`), number of puzzles (default 10), time limit per puzzle
  (15 / 30 / 45 / 60 minutes).
- Side panel (preferred) + popup + tab: the same bundle and domain logic everywhere; closing any
  UI never stops the timer.
- Study-tab designation: optionally mark the current browser tab as the Study Tab (numeric tab id
  only — never URL/title/contents). Leaving it records `study_tab_inactive` / `study_tab_active`.
- Optional Problem ID annotation during or right after an attempt — heavily preferred by matching.
- Per-puzzle attempt timer: `Start Attempt` begins a timestamp-based countdown + elapsed clock.
  `Complete Attempt` saves exact elapsed time; reaching zero auto-records a **timeout** (locked);
  `Abort` (with confirmation) saves elapsed as aborted.
- Integrity/interruption monitoring: while an attempt is active, records only the *fact* of focus
  change (`tab_hidden`, `tab_visible`, `window_blur`, `window_focus`, `study_tab_inactive`,
  `study_tab_active`) plus timestamps. Derives `focus_loss_count`, `total_time_away_ms`,
  `integrity_flag` ("≥1 interruption", never "cheating"). Overlapping signals collapse into a
  single away-window — never double-counted.
- ChessTempo history import: select a **user-downloaded** history CSV → preview (valid/partial/
  invalid, recognized/missing/unknown columns, duplicate report) → Continue to Matching.
  Exact/high-confidence single-candidate matches auto-apply; ambiguous and conflicting cases
  require manual resolution. See `docs/CHESSTEMPO_IMPORT.md`.
- Dataset view: Experiment / Chess / Derived column groups; filters for participant, session,
  result, matched/unmatched, integrity flag; import provenance table; JSON backup export/restore.
- CSV export: one row per attempt with RAW + PROVENANCE + DERIVED (computed at export) columns.
- Crash recovery + schema migration: v0.1 data migrates safely to v2 on load; active
  session/attempt persist; browser restart sets `possibly_interrupted` — results are never
  fabricated and data is never deleted.

## What it does NOT do (boundaries)

- No ChessTempo scraping, DOM reading, private/undocumented APIs, puzzle downloading, or automated requests.
- No URLs, page titles, page contents, keystrokes, screenshots, clipboard, mouse tracking, or history collection.
- No network requests, analytics, telemetry, or third-party code.
- No sleep/caffeine tracking, no ML/statistics, no backend, no login.
- Focus loss is recorded as an *interruption event*, never as "cheating".

## Installation (unpacked, Chrome)

1. `npm install`
2. `npm run build` → output in `extension/dist/`
3. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**,
   select the `extension/dist` folder.
4. Open PuzzleTrack via the toolbar (popup) or the **Side Panel** button (preferred:
   stays visible beside ChessTempo during the study).

## Running a session (see `docs/EXPERIMENT_PROTOCOL.md`)

1. Open ChessTempo endgame training in a tab.
2. Open the PuzzleTrack side panel; designate the ChessTempo tab as Study Tab.
3. Enter Participant ID, puzzle count, time limit → **Start Session**.
4. Immediately before each chess problem, click **Start Attempt** (optionally note the Problem ID).
5. Solve; click **Complete Attempt** (or let it time out / abort if needed).
6. Click **Next Puzzle** and repeat. After the final puzzle: review **SESSION COMPLETE**.
7. Download your ChessTempo history CSV, import it via the Dataset page, review matching.
8. **Export Session CSV** / **Export Full Dataset CSV** / **Export JSON Backup**.

## Timer behavior

`remaining = deadline − Date.now()` with `deadline = started_at + limit`. Display ticks every
250 ms, but completion/timeout is decided by timestamps, so throttled timers cannot drift.
A `chrome.alarms` backup fires the timeout even if every UI surface is closed.

## Integrity-event behavior

- Sources: `document.visibilitychange`, `window blur/focus` (UI), `chrome.windows.onFocusChanged`
  and `chrome.tabs.onActivated/onRemoved` (background; numeric ids only).
- Each event stores `event_id`, `attempt_id`, ISO `timestamp`, `event_type`
  (`attempt_started`, `tab_hidden`, `tab_visible`, `window_blur`, `window_focus`,
  `study_tab_inactive`, `study_tab_active`, `problem_id_set`, `attempt_completed`,
  `timeout`, `abort`) and optional metadata (e.g. `source`).
- Away time = union of away-windows, not the sum of raw events. Reproducible from the raw log.

## CSV export

Header (31 columns) — RAW experiment, RAW chess (manual import, exact), PROVENANCE, DERIVED:

```text
participant_id,session_id,attempt_id,attempt_number,started_at,ended_at,elapsed_ms,elapsed_seconds,time_limit_seconds,timed_out,experimental_result,focus_loss_count,total_time_away_ms,integrity_flag,problem_id,problem_rating,player_rating_before,player_rating_after,chesstempo_result,moves_used,average_moves,rating_change,difficulty_label,chesstempo_attempted_at,chesstempo_time_used_seconds,match_confidence,chesstempo_import_id,chesstempo_source_row,relative_difficulty,timer_difference_seconds,away_time_percentage
```

Booleans are `TRUE`/`FALSE`; nulls are empty cells; values with commas/quotes/newlines are
RFC-4180 quoted. Derived columns are computed at export from raw values (see
`docs/DATA_SCHEMA.md` for the RAW vs DERIVED split).

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run (timer/session/integrity/storage/csv/importer/matcher/derived/duplicates/migration/export)
npm run build       # esbuild -> extension/dist
```

Architecture: `extension/src/models` (types), `utils` (ids/time/validation), `timer`
(timestamp math), `integrity` (focus state machine), `storage` (adapter + repository +
migration), `session` (orchestration), `importer` (CSV parse + ChessTempo normalize),
`matching` (deterministic scorer + applier), `analysis` (pure derived variables),
`export` (CSV + JSON backup), `background` (alarms/heartbeat/focus bridge),
`ui` (popup/side-panel bundle + dataset workstation, vanilla HTML/CSS/TS). Domain logic
never imports `chrome.*` except via the storage adapter and background bridge, so it can
later be reused in a dashboard, backend, or Python analysis pipeline.

## Limitations (v0.2)

- Popup/tab-document focus signals only exist while a UI surface is open; when all are
  closed, only window-level + study-tab transitions from the background are recorded.
  Use the **side panel** for the most complete signal.
- Study-tab tracking follows numeric tab ids; if Chrome reuses ids after a restart,
  re-designate the study tab.
- Single-machine local storage (`chrome.storage.local`); no sync, no multi-researcher merge.
- Concurrent UI + background writes are last-write-wins (fine at this event rate).
- Correctness summaries use a conservative, documented result-string heuristic — verify
  against your ChessTempo vocabulary before publishing.
- No edit of completed experimental records (by design); chess-field corrections go
  through unmatch/re-match, which is provenance-tracked.

## Repository layout

```text
puzzletrack/
├── extension/
│   ├── manifest.json
│   ├── src/{background,ui,timer,integrity,storage,export,models,utils,importer,matching,analysis}/
│   ├── tests/
│   └── dist/            # build output (load unpacked)
├── docs/{DATA_SCHEMA.md,EXPERIMENT_PROTOCOL.md,CHESSTEMPO_IMPORT.md}
├── scripts/build.mjs
└── package.json
```
