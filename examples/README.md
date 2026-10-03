# Public source examples — no participant responses

`public-endgame-bank.json` is the frozen 5,000-position CC0 Lichess prefix sample prepared for this prototype. It contains only public source rows, provenance and source checksum metadata. Install a local working copy with `npm run bank:example`; existing working data are preserved. No network is required for example-bank installation or puzzle play.

`professor-review/pool.json` is the exact unplayed ten-position PROF_REVIEW assignment (5 easy / 5 hard, 15 minutes each), with frozen schedule metadata and legal reference sequences. `professor-review/benchmarks.json` binds to that exact file's SHA-256 and archives all ten initial tablebase probes. It is a public source fixture, not a participant observation or a cognition result.

The original professor assignment was allocated using the researcher's then-existing issuance history. A new deployment with a different history will select a different pool, even with the same participant ID. To review/replay this exact fixture, archive it unchanged or use the local review package, which preloads it. Cross-deployment allocation and response synchronization are not implemented.

Bank source: https://database.lichess.org/#puzzles (CC0). Preserve the embedded source selection/rating/RD/retrieval/checksum fields. The sample is not representative of all endgames or calibrated to individual skill. Tablebase factual probe source: https://tablebase.lichess.ovh/; move perspective and limitations are documented in `docs/TABLEBASE_ANALYSIS.md`.
