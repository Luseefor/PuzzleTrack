# Reproducible initial-position WDL analysis

The professor pilot now has a separate archived benchmark sidecar covering all ten initial positions. The original issued pool is unchanged. The app itself continues collecting without engine/tablebase requests during play; offline post-collection analysis is separate from source-reference correctness.

## Prepare a benchmark sidecar

```sh
npm ci
npm run build
npm run benchmarks:prepare -- /path/to/frozen-participant-pool.json /path/to/new-benchmarks.json
```

Preparation sends only the public board FEN to the Lichess tablebase service, one request per second. It never sends participant IDs, responses or ratings. It records exact FEN, URL, retrieval timestamp, complete raw response and SHA-256; failure entries remain explicit. No source pool is rewritten and an existing output file is never overwritten. Archive successful and failed responses. Run preparation before/after supervised collection, not as participant assistance.

The local professor review package includes `benchmarks/professor-benchmarks.json`, with 10/10 positions archived. Other participant batches need their own sidecars. Use the exact issued pool file in `data/endgame/study`, including its original bytes; the sidecar binds to its SHA-256. A server/preparer dependency on internet availability is not silently replaced with fake benchmarks.

## Analyze a matching backup

```sh
npm run analyze:tablebase -- /path/to/full-backup.json /path/to/benchmarks.json /path/to/new-report.json
```

The analyzer validates the backup structurally, checks frozen pool/parsed-data identity and every sidecar response checksum, validates returned move legality, and binds the recorded initial decision to the actual participant move and the exact initial FEN. Outputs are new, read-only JSON reports. It never rewrites the original backup, research events, source pool or manual benchmark revisions. Coverage is scoped to finished attempts using that exact pool; aborted/time-out attempts are retained. Store code/build version with the report and archive the inputs.

WDL is from the solver's perspective. The API's child move categories are inverted (`loss` becomes solver `win`, `win` becomes solver `loss`, `draw` stays `draw`). Rank loss=0, draw=1, win=2; the API-ranked first move provides the best outcome. Chosen rank lower than best rank yields WDL regret. Ambiguous cursed/blessed or unrecognized categories remain null. No mate, DTZ or WDL value is converted into centipawns.

The provisional satisfied-stopping proxy requires an initial candidate recorded at/before the decision, a decision that matches the actual first participant move, and an available WDL comparison:

`candidate == final choice AND stop_reason == satisfied AND chosen WDL rank < best WDL rank`

Any missing prerequisite produces null; complete evidence that fails the rule produces false. Candidate plausibility and satisfaction are participant reports. The raw evidence and coverage are retained per attempt.

## Limits

This endpoint detects **worse outcome classes**, not faster wins, easier lines, all within-class superior moves or internal cognitive bias. Skill calibration, meaningful within-class improvement thresholds and the study's statistical model still require a reviewed protocol and data. Source puzzle rating is not an individual success probability. A completed software pipeline does not validate those constructs.

For the professor, review the task first; after export, the researcher can run this analysis against the included sidecar. Do not merge the professor's pilot into main participant data without an explicit protocol decision.

Sources: [Lichess tablebase API](https://github.com/lichess-org/lila-tablebase#http-api), [Lichess public puzzle data](https://database.lichess.org/#puzzles).

Public GitHub examples contain the exact unplayed professor pool and matching sidecar under `examples/professor-review`. They are source fixtures, not a participant dataset.

Frozen JSON/CSV source files are marked as byte-preserving in `.gitattributes`, so Git checkout does not silently change their line endings and invalidate sidecar hashes.
