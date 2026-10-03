# Research collection and replay — provisional v0.3.1

The collector records observations, not cognition itself. The mentor contract does not specify a validated cognition scale, a stopping criterion, difficulty strata, a time-condition assignment or an engine gap threshold. Set these in a dated protocol before collecting participants. The manual form is explicitly provisional.

## Ratings

`problem_rating` and `player_rating_before/after` come from visible ChessTempo metadata or matched original history rows. CSV now identifies their source. Session setup also records a separate participant skill rating, its source/scale and capture timestamp. A self-reported Lichess/FIDE rating is not a ChessTempo rating: do not subtract it from a ChessTempo puzzle rating. Guest player ratings remain null. Ratings change over time: archive the supplied pool and original history files, not just puzzle URLs.

The guest tactics check on 2026-10-02 recovered puzzle 78324, displayed rating 1425.5 and an incorrect result. After selector correction, the page timer was captured as 468 seconds. This was an AI calibration attempt, not participant data. Puzzle ID was unavailable before the result, player rating and step counter were unavailable. Logged-in endgames and a real installed-extension flow still need calibration. No readiness claim follows from the guest check.

## Reproducible random count and puzzle order

In Session setup → Research protocol and reproducibility, enter protocol revision, source, optional skill baseline, seed, count bounds, and a reviewed JSON reference pool:

```json
[
  {"id":"authored-001","rating":1000,"rating_source":"pilot-v1","task_type":"endgame"},
  {"id":"authored-002","rating":1400,"rating_source":"pilot-v1","task_type":"endgame"}
]
```

Each ID must be unique. Bounds are 1–100 and must fit the pool. `rating` must be finite and nonnegative. Do not invent ratings: use an identified source or a documented pilot scale. The tool samples count inclusively and puzzles without replacement; uniform sampling gives a random difficulty mix, not balanced difficulty strata. It records the frozen canonical pool, SHA-256, seed, algorithm revision, ordered selection, count bounds, target count and collector version in the full JSON backup. Replay with `createStudyPlan(plan.pool, plan.seed, plan.count_min, plan.count_max, plan.time_assignment?.options_seconds)` and compare the plan exactly (covered by a regression test). The hash is a consistency check, not a source authenticity guarantee.

A plan does not choose ChessTempo puzzles. Auto mode rejects a reference pool. In manual mode, display each assigned puzzle using an authorized source, annotate its actual ID, and start only when visible. Validation warns when assignment is unconfirmed. The original position/solution dataset must be archived separately with license and source revision; the reference pool does not contain board positions. The local endgame puzzle-sequence study now defaults to independent per-puzzle random time conditions (15/30/45/60 minutes), fresh session seeds and neutral participant feedback; see [Local trainer](LOCAL_ENDGAME_TRAINER.md).

## Search behavior

Enable explicit candidate/stop capture in setup. During the attempt, record each considered candidate; the first recorded candidate and its button timestamp are retained. Record final choice and stop reason (`satisfied`, `time_pressure`, `exhausted_options`, `other`); that action also ends the trial. These timestamps measure reporting actions, not the unobservable moment a thought occurred. Requiring reports may affect thinking: use the same instructions across conditions and document this intervention. Missing records stay missing. Recorded candidate count is not total thoughts or total searched moves.

After the trial, Data & exports → Search records allows a researcher-supplied benchmark: best move, chosen and best centipawn scores from the same position, solver perspective, engine/version/configuration, authorized position reference and prespecified gap threshold. Enter depth/nodes, MultiPV, threads/hash, engine binary/network identity as applicable in configuration. Keep original engine output separately. Mate scores and exact endgame WDL/DTZ are not supported by this cp form; do not convert them into invented centipawns. Benchmarks are appended as revisions, never silently overwritten. No engine assistance or board/move extraction is added to the ChessTempo bridge.

`evaluation_gap_cp = best_cp - chosen_cp`; `missed_better_option = gap > threshold`. This indicates benchmark regret, not automatically satisfaction of search. A provisional operational rule would additionally require an initial plausible candidate, that same final choice and reported stop reason `satisfied`. Define plausibility, meaningful improvement, other explanations and exclusions before analysis. A loss alone does not establish this bias.

## Timing, provenance and exports

Clock intervals use UTC wall-clock timestamps with millisecond storage; the display updates every 250 ms. Storage precision is not a claim of millisecond stimulus or response accuracy. Manual start includes researcher timing; automatic start uses visible stable detection. Browser scheduling, DOM publication, network delay and wall-clock changes remain measurement limits. Delayed timeout processing now saves the configured deadline; an overdue completion becomes a timeout. Site event source and processing timestamps are retained in lifecycle metadata where available. Focus interruptions are recorded separately; elapsed time is not silently adjusted by subtracting away time.

Chrome contexts use a shared Web Lock for writes. Worker and main trial actions mutate current state in transactions; merge saves union append-only events and recompute integrity. Content events use a persistent acknowledged outbox and deduplication receipts. This protects ordinary concurrent/retry writes, not disk failure or storage clearing. Export regularly. Schema 1/2 data migrate to 3 without inventing absent version, search or rating provenance. Existing erroneous imported values are not retroactively repaired: validation flags normalized changes that disagree with an original negative raw cell. Compare original files and re-review legacy records.

CSV has 84 columns, including protocol/version, source-specific ratings, seed/pool hash, assigned puzzle, timed choices, benchmark gap and JSON audit fields. Use the participant filter and Export Selected Participant CSV for individual datasets. Export Full JSON as the primary complete backup: it contains study plans, all benchmark revisions, raw imports, matching provenance and integrity/research events; CSV is an analysis view. Archive the original downloaded history CSV, source pool/positions, protocol, collector source revision/build mode, engine outputs and validation report with it.

## Study design decisions still needed

Random question counts can change fatigue and censor participants differently; include trial order and realized count in analysis. Uniform random puzzles can confound time with difficulty and skill. Record and balance/randomize time conditions and difficulty strata according to a prespecified protocol if studying causal effects; recorded durations alone support associations. Specify sample size, participant inclusion/skill measure, counterbalancing, consent/pseudonymous IDs, timeout handling, missingness, interruptions, repeated measures and exclusions. Pilot the instrument before treating any dataset as study-ready.

## No-funding source

A legitimate next build is a local trainer over the CC0 Lichess puzzle dataset: https://database.lichess.org/#puzzles . Freeze a dataset snapshot and build a vetted pool. Endgame-themed tactical puzzles differ from ChessTempo's endgame tasks; pilot and document that construct change. Lichess FEN precedes the opponent's first listed move: apply that move before presenting the solver position. A local trainer avoids reliance on a paid service quota; the local puzzle-sequence trainer is included in v0.4.0.

Measurement definitions, warning interpretation and remaining gaps: [Measurement audit](MEASUREMENT_AUDIT.md). Validation now includes coverage/formulas and a downloadable per-attempt audit JSON.

Current standalone pilot uses exact source-band quotas, participant-specific frozen ten-puzzle batches and one fixed session limit. Main-study dates/hours are not enabled. CSV now has 84 columns including scheduled assignment and practice-report provenance; historical 73-column exports remain valid artifacts. See [Daily schedule](DAILY_STUDY_SCHEDULE.md).
