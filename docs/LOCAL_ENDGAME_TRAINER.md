> Current standalone default (v0.6.0): participant-specific professor pilot, 10 puzzles with exact 5-easy/5-hard quotas and 15 minutes each. Main-study windows are disabled until reviewed. See [daily schedule](DAILY_STUDY_SCHEDULE.md). Earlier calibration/default behavior below remains relevant to historical builds and extension workflows.

# Local chess decision study — v0.5.1

## Run it

From the repository:

```sh
npm install
npm run trainer
```

Open http://localhost:8769 . Keep the terminal/server running. No account, subscription or puzzle-service requests are needed during play. The server binds only to this computer. The installed extension also includes **Free local endgame puzzles**; rebuild and reload `extension/dist` to use it.

Standalone browser records are stored under this localhost origin, separately from Chrome extension storage. Keep the same host/port/browser profile and export JSON regularly. Clearing browser data removes local records. The extension uses its existing research storage. Use one trainer tab at a time: a Web Lock prevents another trainer tab from controlling the same session. The collector popup directs local sessions to the trainer rather than showing competing move/finish controls.

## What constitutes an attempt

A position is hidden until Show position and start timer. The source FEN precedes an opponent move; the trainer applies that move before displaying the participant's position. One continuous timer covers the whole reference puzzle. After each matching participant move, the opponent's next reference reply is played automatically. Matching the remaining solution, an alternative immediate checkmate, an incorrect reference move, the time limit or abort ends the attempt.

This is an endgame **puzzle-sequence** task, as requested. It is not a complete game to checkmate, and it does not implement ChessTempo's own endgame scoring or ratings. All starter positions have at most seven pieces after the preceding move. A different legal move is recorded as `incorrect` against the source sequence; the UI calls it a different reference move. This does not prove that the move throws away a win. Reference correctness and exact tablebase WDL regret are separate observations.

## Source, rating and randomization

### Daily puzzle bank

The local server uses `data/endgame/bank.json` when present. This workspace has a prepared **5,000-puzzle bank** selected from a 64 MiB compressed download prefix. This remains a prefix sample, not the full Lichess endgame population. Preparation checks complete legal sequences and <=7-piece starting positions; this bank does not include initial tablebase probes.

On the first request for each UTC date, the server issues and archives **200 previously unissued puzzle IDs** under `data/endgame/daily/YYYY-MM-DD.json`. The same day's batch stays frozen, including ratings and source metadata. Each participant session independently randomizes its eligible subset, count, order and time limits. Batches are generated on demand, not by an unattended scheduled job. Opening the app or choosing New session loads today's batch; an ongoing session keeps its original snapshot across midnight.

The default **Exclude positions previously shown** option also removes that participant's attempted local puzzle IDs from eligibility in this browser dataset. It includes aborted/timed-out attempts because the position was shown. Exclusion IDs and the remaining eligible reference pool are archived. It cannot detect exposures in another browser or on another chess site. If eligibility cannot support the maximum count, adjust the configured range/count or prepare more data; the collector does not silently repeat items.

A 5,000-item bank supports 25 issued daily batches. On exhaustion the server reports an error; it never falls back to repeated daily IDs. Refresh with a larger authorized source download, then prepare a new bank:

```sh
# Full source for a broader population; zstd must be installed.
curl --fail --location --output /tmp/lichess-puzzles.csv.zst https://database.lichess.org/lichess_db_puzzle.csv.zst
npm run bank:prepare -- /tmp/lichess-puzzles.csv.zst 20000
npm run trainer
```

Preparation streams CSV rows, validates moves and chooses IDs by deterministic SHA-256 ordering across all eligible scanned rows. It discards the final line to avoid a partial prefix record. Preserve the downloaded source if the source scan itself must be reproduced: its checksum is recorded, but the compressed archive is not embedded in exports. Selected original rows and exact daily pool JSON are embedded in session backups. Old bank snapshots and all issued daily batches stay on disk; refreshing does not revise old sessions or issue previously batched IDs again. Reusing the same source/bank cannot create new IDs. The command supports up to 20,000 bank items. Review a refreshed bank before participant use.

Both bank preparation and daily issuance deduplicate solver positions using the first four FEN fields (piece arrangement, side to move, castling and en passant), ignoring move counters. Different puzzle IDs cannot cause the same starting position to be reissued. Participant-history exclusion uses that key too, across uploaded pools. Already archived daily files remain unchanged; a 25-batch simulation of the final bank verified 5,000 distinct IDs and positions without replacement.

Bank/daily files are local and git-ignored; back up `data/endgame` as well as participant JSON. The Chrome extension still bundles the 24-item calibration pool. To use a daily batch there, upload the dated JSON from `data/endgame/daily`; automatic daily serving is the localhost route. Gameplay requires no external puzzle or tablebase API requests.

The bundled calibration pool has 24 CC0 Lichess endgame-themed puzzles. Each has original FEN/moves, source puzzle rating, rating deviation, popularity, play count, themes and original source row. The pool was selected from a downloaded compressed prefix, first filtered to endgame/rating 400–2600/RD ≤100/plays ≥100/popularity ≥0, then restricted to seven-piece playable positions with archived initial Syzygy win/draw coverage. This ordered-prefix sample is not a representative research population. Review/expand it with the mentor before recruitment.

Source: https://database.lichess.org/#puzzles . The dataset is CC0. Source documentation explicitly says the first move belongs to the opponent and the second begins the participant solution. Ratings belong to Lichess puzzles and are not ChessTempo endgame ratings. Participant skill is supplied separately with source/scale and timestamp; the trainer never fabricates a guest rating or a calibrated local Elo.

Current protocol (v0.5.3): each new local session has exactly 10 puzzles. Enter participant ID, protocol revision, source-rating range and one time condition for the whole session (15, 20, 30, 45 or 60 minutes). Choose another session limit on another day. A fresh seed is generated on load and for each new session; researchers can enter a fixed seed for replay. The UI uses fixed-time sessions; existing per-puzzle randomized-time plans remain readable/replayable. Time is configured before play and does not adapt to answers. The pool must contain at least 10 eligible unseen puzzles. Selection is reproducible and without replacement within the session. Difficulty is a uniform random mix of eligible puzzles; it is not stratified balancing. The same seed and filtered reference pool recreate count/order. `plan.time_assignment` stores the time algorithm, canonical `options_seconds` and per-puzzle `ordered_seconds`. Replay the complete plan with `createStudyPlan(plan.pool, plan.seed, plan.count_min, plan.count_max, plan.time_assignment?.options_seconds)`. Legacy plans without time assignments retain their fixed session limit. Each attempt and CSV row store its actual `time_limit_seconds`; the session-level value is only a fallback for fixed/legacy sessions. A full JSON backup stores the exact pool JSON text and SHA-256 once under `localPools`, with sessions referencing its hash. The study plan also stores its eligible reference pool and draw algorithm. Rating values remain frozen for that session.

For another reviewed pool, upload the same `puzzletrack-local-pool` JSON format. FENs and the entire continuation are validated using pinned chess.js 1.4.0, as are archived tablebase checksums. Import fails on invalid/duplicate IDs, missing ratings/FEN, illegal moves or positions over seven pieces. The `source.license` declaration is not proof of permission: use authorized original data. Source positions and solutions remain in the local research archive; researchers should supervise trials because client-side files are inspectable.

## Participant presentation

The participant flow is titled **Chess decision study**. It shows one numbered position at a time and its running countdown, without revealing total question count, upcoming difficulties or time assignments. Completion uses neutral **Response recorded** messages; it shows no correctness feedback, reference moves, source ratings, tablebase evaluations or solved-score summary. Timeout remains explicit. Research export/validation controls and storage details appear during setup and after the session, not between positions or during decisions. Correctness, sources and ratings remain in the research archive. This is still a disclosed research study, not a concealed training exercise.

## Search records and exact data

Reference-based branching remains observable: matching a move can lead to another decision while a mismatch ends the position. Removing scores/feedback does not eliminate learning or blind correctness completely. Keep that limitation in the study protocol.

At each participant turn, record plausible candidates as they occur, then choose a stop reason and Play chosen move. No reason is selected by default. A candidate report validates legality but does not move the board. Each search event has a step number, UCI move, UTC reporting timestamp and elapsed milliseconds from the attempt start. Each played ply has actor, UCI/SAN, before/after FEN and elapsed time; participant plies also have time since the preceding participant-turn transition. Opponent replies share the parent decision timestamp as generated actions; they are not separate human response times.

The timer starts at the Show position button timestamp, before storage/DOM rendering. Each turn's two-frame presentation callback is recorded separately under `turn_presentations`; the initial callback is also `presented_at`. Use those to inspect presentation delay. These are browser timestamps, not hardware-calibrated pixel onset. The clock does not pause for reporting, focus changes or automatic replies. Reloading preserves the start/deadline and marks the active attempt possibly interrupted. Timeouts save the exact configured deadline even if processing is late. Focus/visibility events use the existing append-only integrity log. Wall-clock changes, browser crashes and rendering delays remain instrument limits.

The CSV summary's first candidate and final-choice columns describe the first participant search decision for local puzzles. `candidate_count` totals recorded candidates; it does not count unreported thoughts. `research_events` contains all steps. `local_trial` includes the entire move/presentation log and raw initial tablebase snapshot. `task_outcome` is separate from `experimental_result`: a different reference move can complete the experimental attempt but has task outcome `incorrect`.

The first-move tablebase columns compare exact solver-perspective **win/draw/loss**, when an archived initial probe covers the chosen move. The API's child-position category is inverted back to the participant perspective. Ambiguous/cursed/blessed categories remain unavailable. `first_move_wdl_regret` indicates a worsened WDL class, not a centipawn or DTZ score and not automatically satisfaction of search. Raw DTZ/mate values remain in the archived response. Later positions are not automatically probed during offline play. Use the existing post-trial manual engine benchmark form, with a documented engine configuration and position, for finer evaluation. No engine score or reference solution is shown during search.

The manual engine benchmark form is in the extension's Dataset page, not the standalone trainer. For standalone records, export the JSON backup and restore it into an isolated extension profile before adding a benchmark; restoring replaces that profile's collector store. Keep the original archive. The current manual benchmark summary covers the first search decision, so finer per-step engine analysis needs a separate documented analysis file keyed by attempt ID and step number.

API documentation for the archived initial probes: https://github.com/lichess-org/lila-tablebase#http-api . Tablebase lookup occurred during pool preparation, once per second; gameplay never calls that service.

## Export and review

Export selected participant CSV for analysis (84 columns), and Export research backup for the complete schema-3 JSON archive. The latter contains every participant/session, frozen pool, raw source text, move/search/integrity log and benchmark revisions. Keep it private as a full research archive. Validate dataset checks missing measures, timing, repeated decisions within a step, source/assignment consistency and broken move-log continuity. Zero errors does not validate the study design or establish a cognitive mechanism.

Archive protocol, source revision/build mode, pool files and hashes, engine output and validation report alongside the JSON. Freeze protocol and collector version after piloting. Decide difficulty strata, skill measure, time-condition randomization, timeout/missingness handling, counterbalancing and satisfaction-of-search operational criteria before participant collection.

## Starter pool preparation

`scripts/freeze-pilot-pool.py` reads a local zstd prefix into reviewed source rows. `scripts/freeze-endgame-pool.mjs` restricts those rows and archives initial tablebase responses. The bundled pool is already frozen; rerunning preparation queries current external data and creates a new snapshot. Preserve the old files and source hash when doing so. Neither script obtains puzzles from ChessTempo or bypasses its quotas.

A random difficulty draw does not guarantee five easy/five hard. The researcher can change the source-rating range by day, including a hard-only range, but easy/hard thresholds must be defined by the protocol; they are not inferred from participant skill. Changing both time and difficulty together makes a simple day-to-day comparison ambiguous. To study time separately, repeat/overlap difficulty ranges across time conditions using different unseen positions. The saved plan retains exact source ratings and actual sequence; session/attempt timestamps and time limits identify the observed day and conditions.
