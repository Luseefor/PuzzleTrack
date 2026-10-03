# ChessTempo adapter fixtures (v0.3 test harness)

Static, sanitized, minimal HTML snapshots representing page states the live
adapter must handle. They contain ONLY the minimum markup needed to exercise
the adapter — no real page content, no scripts, no styling.

## Status: illustrative, NOT calibrated

ChessTempo publishes no documented DOM contract, so these fixtures model the
*documented adapter roles* (problem identity, ratings, result markers) rather
than the real site. They serve three purposes:

1. Human-readable specification of what the adapter looks for.
2. Source of representative strings for parser unit tests
   (`chessTempoParser.test.ts` feeds the same shapes).
3. Calibration template: replace the `data-pt-*` hooks with real selectors in
   `chessTempoSelectors.ts`, then re-run the calibration procedure in
   `docs/CHESSTEMPO_LIVE_BRIDGE.md` against a local harness page.

## Fixtures

| File | Page state | Expected adapter behavior |
|---|---|---|
| `01-problem-ready.html` | New problem #81496 stable | `problem_loaded` exactly once |
| `02-problem-active.html` | Same problem mid-solving | No new events on rerender |
| `03-result-correct.html` | Visible correct result | `problem_completed(correct)` once |
| `04-result-incorrect.html` | Visible incorrect result | `problem_completed(incorrect)` once |
| `05-next-problem.html` | Different stable id #92142 | `problem_loaded` exactly once |
| `06-malformed.html` | Training page, id missing | No problem reported; fields listed missing |

Unit tests drive the pure state machine (`stepMachine`) with equivalent
`PageReading` sequences, since the suite must not require live ChessTempo or a
browser DOM.
