# Measurement audit and remaining gaps

Validate dataset now reports **the entire stored browser dataset**, not just the participant entered in setup. Expand “Measurement coverage & formulas” for counts and computation rules. Export the measurement audit JSON alongside the full research backup. The audit includes validation findings, affected IDs, every finished attempt's available measures, research-event references, and a machine-readable measure dictionary. It is read-only and never repairs, imputes, excludes or deletes observations.

Coverage denominators include every finished attempt, including timeouts and aborts. Active attempts are counted separately. Multiple warnings can refer to one attempt. `available` means inputs exist, including provisional inputs; it does not mean scientifically validated. A zero denominator is an empty dataset, not a 100% pass. Audit values are reproducible from its accompanying full backup using `buildMeasurementAudit`; retain code/build revision too. The audit is an analysis view, not a replacement for raw JSON, source pools or original engine output.

## Observed warnings on 2026-10-02

The reviewed localhost dataset contained 24 finished attempts in four sessions, zero structural errors and 45 warnings:

- 24 `ratings-missing`: participant skill rating absent. Local source puzzle ratings are available separately. Supplying a cross-platform rating does not calibrate relative difficulty.
- 21 `search-measures-missing`: initial-position candidate or decision absent. Later-step records cannot fill this gap. Ending an attempt before a choice can legitimately leave this measure missing; preserve the termination outcome and handle missingness under the protocol.

These counts describe the browser store at review time, not a universal property of the app or proof of participant data quality. Prior synthetic verification observations remain stored. Nothing was removed to improve validation results. Do not retrospectively invent skill ratings, candidates or thought timestamps.

## What the instrument quantifies

| Measure | Definition | Limit |
| --- | --- | --- |
| Assigned time | `attempt.time_limit_seconds` and saved plan assignment | An experimental condition; not actual search duration |
| Attempt interval | `elapsed_ms`; seconds = milliseconds / 1000 | Browser wall clock; timeout interval equals configured deadline and is censored |
| Participant step interval | participant ply `recorded_at - turn_started_at` stored as `step_elapsed_ms` | Includes rendering, reporting and move entry; not pure thought time |
| Candidate and decision | Initial step (1 or legacy absent step number), first event of each kind, with `elapsed_ms` | Explicit reports; unreported thoughts are absent |
| Candidate-to-decision interval | Decision elapsed minus first candidate elapsed, only if candidate precedes/equal decision | Not all search time |
| Candidate count | Number of recorded candidate events across all steps | Not total moves mentally considered; first-step summaries and all-step counts are different scopes |
| Termination and local outcome | `experimental_result`; `local_trial.outcome` | Reference mismatch is not necessarily suboptimal; timeouts/aborts are not incorrect solutions |
| Source difficulty | Frozen source rating and rating scale, RD and original row in full backup | Population puzzle rating, not participant-specific easiness |
| Reported skill | Session rating, source/scale and timestamp | Manual report; no AI skill test or uncertainty-calibrated player estimate |
| Focus | Away fraction = `total_time_away_ms / elapsed_ms`, null at zero duration | Only observed browser signals; cannot reconstruct missing crash events |
| CP regret | Last supplied benchmark `best_cp - chosen_cp`; missed option iff gap **strictly exceeds** `threshold_cp` | Researcher supplied; collector does not verify original engine output or binding to position/chosen move |
| WDL regret | Archived initial tablebase child categories inverted to solver perspective; ranks loss 0, draw 1, win 2; chosen rank < API-ranked first move's rank | Only initial move and outcome class; absent/ambiguous cursed/blessed categories yield null; no within-class improvement measure |
| Replay provenance | Seed, eligible pool, algorithm, ordered assignments, SHA-256, source snapshots in backup | Audit presence counts alone do not replay or verify cryptographic hashes |

All search endpoint summaries now select the initial position. Later-step events remain in raw research events and local plies. CSV's candidate count remains all steps; this is explicitly distinguished from the first-position endpoint.

## Provisional satisfaction-of-search endpoints

The audit exports two separate, explicitly provisional operational proxies. Neither establishes an internal cognitive process or diagnoses bias.

Both require an initial-position candidate recorded before/equal to the initial decision. Define `stopped_satisfied_on_first_candidate` as exact recorded move-string equality between those two reports **and** stop reason `satisfied`. There is no inference of “plausibility” beyond the participant's candidate report.

- CP proxy additionally requires a researcher-supplied CP benchmark and `best_cp - chosen_cp > threshold_cp`.
- WDL proxy additionally requires a valid initial tablebase comparison and a lower chosen outcome rank.

If any required input is missing, the endpoint is **null**, even if another condition would be false. False means all prerequisites were available and the complete rule was false. Exact move-string equality is conservative for manual labels; local inputs are normalized UCI. CP uses the last appended benchmark revision; full JSON preserves all revisions. The threshold and rule require a prespecified protocol, and supplied engine provenance/output must be checked before analysis. Do not combine CP and WDL into one hidden score.

## Unimplemented or unobservable quantities

- Direct cognition, total mental search, and the instant a thought occurred are not collected. Timing and reports are behavioral observations. No numeric cognition score is invented.
- The daily bank lacks engine/tablebase move benchmarks. Source reference sequences alone cannot establish a missed better option. Archived starter positions have only first-move WDL comparisons.
- A standardized AI skill assessment and calibrated local player model are not implemented. Local relative difficulty remains null; subtracting unrelated rating scales is unsupported. Legacy ChessTempo rating difference is a separate variable, not an equivalent local measure.
- Causal effects of time on thinking are not estimated by this collector. A prespecified repeated-measures analysis must account for participant, source difficulty, order, exposure, fatigue, censoring and missingness. Random assignments and retained logs make such analysis inspectable; they do not supply the study design or statistical conclusions.

Before participant analysis, the remaining work is a reviewed endpoint/missingness protocol, reproducible move-quality benchmarks for the study positions, and a defined participant skill measure. Preserve source/engine versions, parameters and outputs so every derived result can be traced to its inputs.
