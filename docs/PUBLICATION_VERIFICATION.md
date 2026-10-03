# Source-publication verification — 0.6.0

The software is published as a documented **pilot instrument**, with no GitHub Release and no claim that cognition or skill measures have been validated. Original code is all rights reserved at the owner's request. Public CC0 source positions and separate dependency notices are included; private/generated research artifacts are ignored.

## Verified

- 207 domain tests in 24 files, TypeScript checking and default build pass. CI runs the same checks on Node.js 20/22.
- Exact daily quotas, disjoint source-rating bands, unique positions, source/exposure consistency, deterministic plan replay, fixed 10-question/20-minute sessions and absent-versus-false endpoint behavior are covered by tests.
- Schedule tests check timezone/date boundaries, same-day window duration, half-open access windows, ambiguous/nonexistent DST hours, outside-window refusal and quota exhaustion without substitution.
- An isolated server integration check issued different ten-position pilot batches for two IDs, reloaded an identical assignment, opened an enabled test-only schedule, returned HTTP 403 outside that window and blocked legacy calibration endpoints in main mode. The real study configuration remained disabled.
- T3 browser verification created a synthetic pilot ID, confirmed 5 easy/5 hard and 900-second limits, recorded initial/per-step choices, solved one full reference sequence, and ended the session early. Its nine unplayed assignments remained unobserved. The 24 prior stored attempts were preserved; the validation view reported zero errors and 46 warnings (25 missing skill ratings, 21 missing initial reports), rather than deleting tests to improve the counts.
- Actual downloaded participant CSV has 84 columns and one synthetic observation. Full JSON preserves the ten-position source, practice-report unknown values and abandoned-session state.
- Benchmark preparation archived 10/10 initial positions for the unplayed professor batch, with no failures. A separate synthetic backup/sidecar analysis produced one available operational WDL proxy for one completed attempt. Inputs were not rewritten.
- Portable package server launched without npm installation, served the exact pre-issued PROF_REVIEW source pool and disabled schedule, and served the current app. Public source examples contain no participant response data. The ZIP stays local for emailing.

T3 snapshot capture failed at the preview client; focused DOM evaluation, native button actions, actual downloads and `render_game_to_text` succeeded. No new screenshot/visual-regression claim is made. Generated browser observations, analysis artifacts and the local ZIP are excluded from Git.

## Scientific boundaries

A software pass does not establish a validated cognitive construct, representative sample, calibrated individual skill rating, within-WDL-class move superiority, sample size, ethics/consent readiness or an approved causal model. The professor must review endpoint definitions, timing burden, practice effects, dates/hours and analysis before the main study is enabled. The ten-position sidecar supports outcome-class comparisons only. External practice restrictions are limited to this supervised app; no cross-device/site monitoring is claimed.
