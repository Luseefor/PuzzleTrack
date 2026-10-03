# Professor review — PuzzleTrack 0.6.0

This is an instrument pilot, not participant study data. The assigned ID is **PROF_REVIEW**. It has ten unique legal endgame puzzles, 5 easy source-rated 400–1399 and 5 hard source-rated 1800–2600, with 15 minutes maximum per puzzle. Ratings are provisional source bands, not a calibrated skill-relative scale. Main-study dates and hour restrictions are disabled pending your advice.

## Run the portable package

1. Unzip the package. Install Node.js 20 or newer if it is not already installed.
2. In a terminal, enter the unzipped `PuzzleTrack-professor-review` directory and run `node scripts/serve-trainer.mjs`. No npm install is needed in this package; its server dependency is bundled.
3. Open `http://localhost:8769/?participant=PROF_REVIEW` in a modern desktop browser. Keep one study tab open and the server running. If port 8769 is already used, stop the other PuzzleTrack server first.
4. Retain PROF_REVIEW as your ID, optionally report existing rating and other practice, then start. Record a candidate when it becomes plausible; select your stopping reason before playing the chosen move. You may end a position if needed. The source reference continuation controls puzzle progress.
5. After review, export the participant CSV and full JSON. The JSON includes the frozen assignment and all recorded events. If stopping early, export and archive the unfinished session; its unplayed questions stay unobserved.
6. Stop the server with Ctrl+C. Data remain in that browser on that machine; deleting storage removes observations. The package does not upload or email anything.

You can use another pseudonymous ID to inspect participant-specific allocation, but that will be another pilot assignment, not another identity for the same research participant. Each deployment allocates independently; this portable copy does not synchronize with the researcher's server. The package includes the public CC0 source bank and only the professor's preassigned batch, not participant response data. Source solutions are technically inspectable; review is intended to be supervised.

## Please assess

- Whether endgame search/stopping is an appropriate construct for the intended research question.
- Candidate reporting and its possible effect on search; the operational rule for satisfied stopping and what establishes a meaningful missed alternative.
- Baseline skill measurement and source-rating thresholds; puzzle types vary even within a rating band.
- Time conditions and participant burden: ten full 15-minute attempts can take 150 minutes, before breaks; 20 minutes each can take 200 minutes.
- Study duration, time windows/timezone, order/counterbalancing, practice reporting, missingness/timeouts/interruptions and participant inclusion.
- Move-quality benchmarking for the main study: other batches need benchmark preparation; this professor package includes a separate ten-position WDL sidecar and the app does not directly measure cognition.

Suggested email text:

> I have attached a local pilot of our endgame search/stopping instrument. It assigns ten puzzles per participant, with a reproducible five-easy/five-hard source-rating mix and fifteen minutes per puzzle. Please review the task and proposed endpoints before we set dates or recruit participants. The included instructions explain how to run it and export your pilot logs. I would especially value your advice on baseline skill, move-quality benchmarks, time conditions, practice effects and the study schedule.

This is draft text for the researcher to send; no email has been sent automatically.

For reproducible post-review WDL analysis, see [Tablebase analysis](TABLEBASE_ANALYSIS.md). The included sidecar is separate from the immutable source pool and only supports outcome-class comparisons.

For a clone-based setup instead of the local ZIP, use Node.js 20+, run `npm ci`, `npm run bank:example`, then `npm run trainer`. The repository includes public source examples, not participant responses. No GitHub Release is published. The pre-issued professor source fixture is `examples/professor-review/pool.json`; preserve its hash and sidecar when using that exact fixture.
