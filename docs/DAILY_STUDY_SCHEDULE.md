# Participant-specific pilot and daily study schedule

## Current state: professor-review pilot

Main-study dates/hours remain **disabled**, as requested. `config/study-schedule.json` is a reviewable draft, not an approved or running study. The approved provisional bands are Lichess source ratings **easy 400–1399**, **hard 1800–2600**, inclusive. Ratings 1400–1799 are outside these two bands. These labels do not imply participant-relative difficulty or cognition scores.

Each pilot participant receives exactly **10 endgame puzzle sequences: 5 easy + 5 hard**, each with **900 seconds (15 minutes)**. A separate SHA-256-derived ordering seed makes presentation order reproducible. The server selects different positions for different pseudonymous participant IDs, excluding IDs and solver-position keys previously archived on this server. Reusing an ID retrieves its exact first batch; it does not draw extra puzzles. Keep one ID per actual participant. IDs are identifiers, not authenticated accounts.

A frozen, unplayed professor assignment has been issued for **PROF_REVIEW**. The app can be opened locally at `http://localhost:8769/?participant=PROF_REVIEW`. A localhost URL is only accessible on the computer running the server. Use the portable review package for another computer. Do not email `data/endgame/study`, browser backups, participant responses or other private research records indiscriminately.

The standalone browser permits one started pilot batch per participant ID in its retained dataset. Completed or archived batches cannot be started again in that dataset; active batches can resume. Clearing storage, changing IDs, modifying the client or using another deployment can bypass this client completion check. Server issuance remains frozen for the same ID. This is a supervised research workflow, not an anti-cheating system.

## How assignment selection works

1. Validate schedule identity, timezone, explicit rating bands and day quotas. Bands cannot overlap; every day totals exactly 10 puzzles.
2. Hash the JSON-serialized schedule and bank. The archived source contains those hashes and the original schedule JSON. Bank identity is sensitive to its serialized row order; replay requires the exact snapshot.
3. Exclude all previously archived daily/study puzzle IDs and presented-position FEN keys on this deployment, including pilot allocations. Allocation reserves all ten positions even if some are never played.
4. For each requested band, rank eligible rows by SHA-256 of `bank hash : schedule hash : allocation date : participant ID : band ID : puzzle ID`; take the exact quota while excluding duplicate solver positions. SHA-256 ordering is a deterministic sampling rule, not a psychometric calibration.
5. Archive the completed pool before serving it. Later requests read that archive unchanged. Source rows, ratings, RD, FEN and complete legal reference lines remain frozen.
6. Presentation order uses `createStudyPlan` with the frozen ten-item reference pool, participant seed and fixed bounds 10/10. All ten are presented once, with the fixed session time. Missing responses are preserved as missing, never replaced by fabricated attempts.

The pilot archive lives at `data/endgame/study/<schedule-sha256>/pilot-review/<participant-id>.json`. Main study archives use the study-local calendar date instead of `pilot-review`. The pilot date is the actual allocation date, not a fabricated study day. `schedule_day=1` in the pilot identifies the draft configuration entry used, not day one of the main study. `batch_code` identifies a participant assignment and is **not a password or access token**.

If a band lacks enough unused positions, issuance fails. It never silently substitutes a different rating, repeats a position or falls back to the 24-item starter bank. Disjoint bands ensure counts are unambiguous. Separate deployments have separate allocation histories; use one coordinator/server if cross-participant non-overlap must hold for the whole study. Portable copies do not synchronize responses or allocations.

## Enabling the actual daily schedule later

After professor review, set the start date, study length (`days` array), IANA timezone, same-day `opens`/`closes`, explicit daily time/quotas, revision and `enabled: true`. The current 12-entry draft gives three repetitions of each combination:

| Condition | Time per puzzle | Quota |
| --- | --- | --- |
| Mixed / 15 | 15 minutes | 5 easy + 5 hard |
| Hard / 20 | 20 minutes | 10 hard |
| Mixed / 20 | 20 minutes | 5 easy + 5 hard |
| Hard / 15 | 15 minutes | 10 hard |

The draft varies order across four-day blocks; it is not a validated counterbalancing or sample-size design. The same day condition is used for all participants, while positions differ. Participant-specific random condition order is not implemented. Consider calendar day/order/fatigue and participant differences in the analysis. Having all combinations avoids perfectly confounding time with difficulty, but does not eliminate those other effects. Review this draft rather than assume twelve days is an approved duration.

The window must accommodate **10 × the per-puzzle maximum duration**, and should include extra time for instructions/breaks. Ten 15-minute puzzles can take 150 minutes; ten 20-minute puzzles can take 200 minutes. The server rejects a window shorter than that. Session start requires enough remaining time for all ten maximum-duration attempts; each subsequent puzzle requires enough remaining time for its full limit. Opening is inclusive, closing exclusive. Study dates are computed in the configured timezone; ambiguous/nonexistent daylight-saving window times are rejected. Before/after the study, and outside the window, the server refuses participant pool access; the browser hides the board and rejects new search actions/start actions. No timer reset is introduced.

An unfinished assignment cannot spill into a later day or new schedule revision. Export it and use **End this session early** to preserve its attempts, close any current attempt, and mark the session abandoned. Unanswered planned positions remain in the plan, not synthetic dataset rows. Archiving consumes that participant's batch; it does not unlock a replay. Completed study batches are limited to one started batch per participant/day in the retained browser store. Do not change a live protocol/config revision mid-collection; save a new reviewed phase and document deviations.

The draft pilot is deliberately accessible at any hour so your professor can review it. Hours become active only when the main study is enabled. A local server must be running to serve/check assignments; it does not need ChatGPT, a cron job or daily app-code updates. The next day's allocation happens on the first eligible request and is archived. Bank expansion is a separate researcher action; quota exhaustion fails visibly.

## Training and outside practice

This app can restrict its own supervised study flow. It cannot prevent playing chess on other sites, offline, on another device or under another ID. Daily changing access codes would not prove absence of training.

Setup now collects an optional self-report of other chess practice: whole minutes and notes since the previous study session, or the last 24 hours for a first session. Blank minutes mean unknown; zero means explicitly reported none. The report includes its timestamp/method and is repeated across that session's CSV rows; it is not ten independent reports. Maintain participant instructions and a practice diary if required by the protocol. Within-study exposure/trial order and cumulative participation must also be considered; daily play itself can produce familiarity. No automatic subtraction or hidden adjustment for training is performed.

## Data and exports

Full JSON is the primary archive. It includes exact per-participant source pool, schedule JSON/hash/revision, phase, band thresholds/quotas, allocation date, day entry, window, fixed limit, participant seed, batch code and complete raw observations. Store server allocation files, original bank snapshot, protocol and code/build revision with it.

CSV now has **84 columns**, adding `study_phase`, `schedule_sha256`, `schedule_day`, `batch_code`, `difficulty_band`, `schedule_opens_at`, `schedule_closes_at`, `schedule_json`, `prior_chess_practice_minutes`, `prior_chess_practice_notes`, and `practice_reported_at`. The appended fields are blank for old observations; no historical answers or practice reports are invented. The measurement audit also includes assignment source metadata and the practice report.

The move-quality and cognition limitations remain: the app does not automatically embed benchmarks in expanded-bank trials; the professor package now includes a separate ten-position WDL sidecar, source reference mismatch is not proof of suboptimality, reported stopping is not a direct cognition measure, and local skill calibration is unfinished. Professor review should cover those endpoint definitions and the duration/burden before recruitment. See [Measurement audit](MEASUREMENT_AUDIT.md).

For reproducible post-review WDL analysis, see [Tablebase analysis](TABLEBASE_ANALYSIS.md). The included sidecar is separate from the immutable source pool and only supports outcome-class comparisons.
