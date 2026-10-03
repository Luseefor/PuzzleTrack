# PuzzleTrack v0.6.0

PuzzleTrack is a local research app for chess endgame decision making, search stopping and time conditions. It includes a standalone decision study and a Chrome extension collector for the separate ChessTempo workflow.

**Start here:** [What we have built](docs/PROJECT_OVERVIEW.md) describes implemented features, recorded measures and remaining research gaps. The proposed AI skill assessment and calibrated relative-difficulty model are not implemented.

## Run the local decision study

```sh
npm ci
npm run bank:example
npm run trainer
```

Open http://localhost:8769 and keep the server running. The server binds only to this computer. No account or paid puzzle-service quota is needed.

The current standalone mode is a professor-review pilot: enter a pseudonymous participant ID to receive a frozen ten-puzzle batch, exactly five easy (source rating 400–1399) and five hard (1800–2600), with fifteen minutes per puzzle. Different IDs receive different positions on this server; the same ID reloads its original assignment. Main-study dates/hours are disabled until reviewed. Participants record plausible candidates, their final move and why they stopped searching. Automatic opponent replies follow the source solution; one continuous timer covers each puzzle sequence.

For your professor, send the generated [portable review package instructions](docs/PROFESSOR_REVIEW.md) with [review instructions](docs/PROFESSOR_REVIEW.md). It requires Node.js 20+ but no npm install. Create it again with `npm run build`, start the local server, then `npm run review:package`. The generated ZIP stays local for you to email; it contains the public source bank and PROF_REVIEW assignment, not browser participant responses. No GitHub Release is published.

The participant interface shows no puzzle ratings, reference answers, solved score or total question count. Completion feedback is neutral. Reference branching remains observable, so this does not eliminate learning completely.

## Puzzle sources and randomization

- Exactly 10 questions per local session; seeded random puzzle selection and order without replacement.
- Exact source-rating band quotas, with deterministic selection and per-participant presentation order.
- One fixed time limit per scheduled session. The professor pilot uses 15 minutes; the unactivated daily draft crosses 15/20 minutes with mixed/hard-only quotas.
- A prepared local bank supplies archived participant-specific ten-position assignments. Legacy 200-position UTC daily batches remain a separate calibration endpoint, blocked in main-study mode.
- A frozen 5,000-position CC0 example bank is included under `examples`, with local working copies under git-ignored `data/endgame`, sufficient for 25 daily batches before expansion. Bank preparation validates complete reference sequences and deduplicates solver positions.
- Participant exposure exclusion checks puzzle IDs and starting-position keys in this browser dataset, including previously aborted/timed-out attempts.
- The bundled 24-item calibration pool is the fallback when no bank exists and the default extension source. Daily serving is the localhost route; the extension supports daily JSON upload.

See [bank preparation and study operation](docs/LOCAL_ENDGAME_TRAINER.md). A fresh clone includes a frozen public CC0 example bank; `npm run bank:example` installs it without replacing an existing local bank. Review its prefix-sample limitations before participant collection. Larger banks can be prepared from the licensed source. Selected source rows, ratings and exact pool JSON are frozen in each session archive. The current bank is a download-prefix sample, not the full or representative endgame population.

## Research records

Records include attempt and step timings, presentation callbacks, moves in UCI/SAN, before/after FEN, search reports, stop reasons, task outcomes, focus/visibility events, protocol/build metadata, source checksums, randomization plans and exposure exclusions.

**Export participant CSV:** 84 columns, one row per attempt. Nulls are empty cells; booleans are `TRUE`/`FALSE`; nested move/search/integrity logs are JSON cells. First-candidate/final-choice summary fields describe the first participant decision; use the nested logs for all steps.

**Export research backup:** complete schema-3 JSON, including all participants in that browser dataset and exact frozen source pools. Keep it private and export regularly. Separately back up `data/endgame` and the source download to reproduce bank preparation and daily issuance.

**Validate dataset:** checks timing, assignments, source consistency, move-log continuity, per-position time limits, exposure exclusions and missing measures. Passing validation does not validate the study design.

Timing uses saved timestamps and deadlines rather than counting display ticks. Reload preserves the deadline and marks an active attempt possibly interrupted. Standalone collection observes focus/visibility while the page is open; extension collection also uses background alarms and allowed tab/window signals. Browser timestamps are not hardware-calibrated onset measurements.

## Skill and move-quality limitations

Participant skill is currently an optional researcher-entered rating with source/scale and timestamp. There is no AI baseline test or locally inferred Elo. The legacy `relative_difficulty` column subtracts ChessTempo puzzle/player ratings and remains empty for local attempts; incompatible rating scales are not mixed.

The 24-item starter pool includes archived initial tablebase WDL benchmarks for the first participant move. The expanded daily bank does not. A source-reference mismatch alone does not establish a worse move. The extension Dataset page supports a researcher-supplied, first-decision engine benchmark with provenance. Finer and later-step analyses need separate documented benchmarks.

Time is a behavioral measure, not a direct cognition measure. Satisfaction-of-search criteria, skill/difficulty calibration, time conditions and the analysis plan need to be finalized before recruitment. See [project overview](docs/PROJECT_OVERVIEW.md#skill-and-relative-difficulty-proposed-work).

## Chrome extension / ChessTempo collector

```sh
npm run build
```

Load `extension/dist` as an unpacked extension from `chrome://extensions` with Developer mode enabled. Popup, side panel and Dataset page share the collector logic. The Dataset page imports researcher-downloaded ChessTempo history CSV, previews parsing/duplicates and matches history to timed attempts with provenance. Ambiguous or conflicting matches require review.

The optional limited ChessTempo metadata bridge is **disabled in default builds**. For the documented local calibration scope:

```sh
npm run build:live
```

See [bridge operation](docs/CHESSTEMPO_LIVE_BRIDGE.md), [permission scope](docs/CHESSTEMPO_PERMISSION.md) and [history import](docs/CHESSTEMPO_IMPORT.md). The bridge does not obtain proprietary puzzles or bypass ChessTempo quotas. The local decision study uses licensed open data independently.

## Storage and privacy

Standalone data is stored in browser localStorage for the chosen host/port/profile, separately from Chrome extension storage. `localhost` and `127.0.0.1` are different origins. Clearing browser data removes records; export JSON regularly. One trainer tab owns session control through a Web Lock. Repository transactions serialize normal app mutations.

There is no cloud synchronization, account service, analytics or telemetry. The local server serves the app and prepared daily pools. Preparation downloads licensed source data; starter-pool preparation queried the public tablebase service. Puzzle play makes no external puzzle/tablebase requests. The extension records allowed numeric tab/window signals; focus loss indicates interruption, not cheating.

Restoring JSON in the extension replaces the target profile's store. Use an isolated profile to review standalone backups or add engine benchmarks; keep the originals. There is no automatic standalone-to-extension synchronization.

## Development and documentation

```sh
npm run typecheck
npm test
npm run build
npm run bank:prepare -- /path/to/licensed-source.csv.zst 5000
```

Current domain/data verification: 207 tests in 24 files. Browser verification artifacts are synthetic and must not be analyzed as participant observations. See the documented publication verification and measurement limits; generated observations stay local, outside Git.

| Document | Purpose |
| --- | --- |
| [Project overview](docs/PROJECT_OVERVIEW.md) | Built features, research interpretation and proposed work |
| [Local decision study](docs/LOCAL_ENDGAME_TRAINER.md) | Run, prepare sources, collect and replay |
| [Data schema](docs/DATA_SCHEMA.md) | Raw records, provenance and derived fields |
| [Research capture](docs/RESEARCH_CAPTURE.md) | Search measures, rating provenance and reproducibility |
| [Experiment protocol](docs/EXPERIMENT_PROTOCOL.md) | Collection workflow and unresolved protocol decisions |
| [Pilot validation](docs/PILOT_VALIDATION.md) | Calibration and validation checklist |

Architecture: vanilla HTML/CSS/TypeScript; chess.js for move legality; esbuild for bundles; Vitest for tests. `extension/src/trainer` owns the local decision interface; `research` owns search capture and seeded plans; `session`, `timer`, `integrity` and `storage` own collection; `export` and `validation` own analysis-ready output/checks; `integrations/chessTempo` owns the optional bridge. Bank/daily preparation and localhost serving live in `scripts`.

Measurement definitions, warning interpretation and remaining gaps: [Measurement audit](docs/MEASUREMENT_AUDIT.md). Validation now includes coverage/formulas and a downloadable per-attempt audit JSON.

Daily schedule, access controls, practice-report limitations and archive rules: [Daily study schedule](docs/DAILY_STUDY_SCHEDULE.md). Daily code changes or a ChatGPT scheduled task are unnecessary; the server selects and archives assignments automatically.

Offline benchmark preparation and initial-position outcome analysis: [Tablebase analysis](docs/TABLEBASE_ANALYSIS.md). The local professor package and `examples/professor-review` include archived WDL coverage for its ten positions.

Public repository: https://github.com/Luseefor/PuzzleTrack. CI runs typechecking, tests and production build on Node.js 20/22. See [third-party notices](THIRD_PARTY_NOTICES.md) and [contributing](CONTRIBUTING.md). This is a pilot software release; mentor-reviewed protocol and skill calibration remain prerequisites for participant research claims.

Original code and documentation are [all rights reserved](LICENSE). CC0 puzzle data and dependency licenses are listed separately in [third-party notices](THIRD_PARTY_NOTICES.md).
