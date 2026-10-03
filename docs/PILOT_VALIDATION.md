# PuzzleTrack — Pilot Validation Plan

Purpose: validate the **instrument**, not any research hypothesis. Do not draw
scientific conclusions from pilot data. Work in two stages: first a disposable
controlled session (TEST01), then one real 10-puzzle session (P01).

Conventions used below: times are examples — use a stopwatch/phone timer as
ground truth alongside PuzzleTrack's own display.

---

## STAGE A — CONTROLLED TEST SESSION (disposable participant TEST01)

Use one experimental time condition for the whole stage (e.g. 15 minutes; the
timeout test below does not wait out the full limit — see Attempt 2 note).

### A.1 Setup

1. Load the extension build (`extension/dist`) in Chrome.
2. Open the PuzzleTrack side panel; keep it visible.
3. Start a session: Participant `TEST01`, target attempts `3`, time limit `15 minutes`.
4. Do NOT designate a study tab yet (keeps Stage A focused on core timing).

### A.2 Attempt 1 — normal completion with one interruption

1. Click **Start Attempt** and note the wall-clock time `T_start`.
2. Wait ~10 s, then leave the study context once (switch to another tab or
   minimize Chrome). Remain away ~8 s (count with a stopwatch: `T_away ≈ 8 s`).
3. Return to PuzzleTrack. Wait ~5 s.
4. Click **Complete Attempt**, note `T_end`.

Expected in the attempt summary and Dataset view:

- `elapsed_ms ≈ (T_end − T_start)` within ±2 s (UI tick granularity + human reaction).
- `experimental_result = completed`, `timed_out = FALSE`.
- `focus_loss_count = 1` (blur+hidden collapse into one away-window — if you see
  2, file a bug: that is double counting).
- `total_time_away_ms ≈ T_away` within ±3 s. Must be nowhere near `2 × T_away`.
- `integrity_flag = TRUE`.
- Raw events contain `attempt_started`, one loss-cluster (`tab_hidden` and/or
  `window_blur`), the matching regain events, and `attempt_completed`.

### A.3 Attempt 2 — timeout (short-circuit allowed)

Waiting out a full 15-minute limit is unnecessary for validation: the timeout
path is timestamp-deterministic, so you may verify it two equivalent ways —
(a) run a **separate 1-attempt session** with the same condition and wait for a
small limit… but limits are fixed at ≥15 min. Therefore:

1. Start Attempt 2, wait ~30 s, then **close Chrome entirely** (or kill the tab)
   with the attempt active — this exercises crash recovery, not timeout.
2. Reopen Chrome + PuzzleTrack. Expect the **interrupted-attempt banner**
   (`possibly_interrupted`), the timer resumed from `started_at` (NOT restarted),
   and no fabricated result.
3. To validate the timeout branch itself without waiting 15 minutes: open
   DevTools on a copy of the logic is out of scope — instead, verify timeout on
   the real path during Stage B only if a genuine timeout occurs; otherwise the
   timeout path is covered by the automated suite (`timer.test.ts`,
   `session.test.ts`) plus the alarm handler. Record in your notes whether a
   live timeout was observed.

Timeout expectations (whenever one occurs, live or future):

- `timed_out = TRUE`, `experimental_result = timeout`.
- `elapsed_ms` equals the configured limit exactly (e.g. `900000`).
- The summary shows TIME LIMIT REACHED; the result cannot be changed in the UI.

### A.4 Attempt 3 — manual abort

1. Start Attempt 3, wait ~20 s.
2. Click **Abort Attempt**, confirm the dialog.
3. Expected: `experimental_result = aborted`, `timed_out = FALSE`,
   `elapsed_ms ≈ 20 s` (preserved, not zeroed), not counted as completed/timeout.

### A.5 Reload / close torture (during any active attempt)

- Close and reopen the side panel mid-attempt → timer continues, no duplicate
  `attempt_started` event, countdown matches wall clock.
- Close and reopen the popup mid-attempt → same.
- Reload the extension UI (`chrome://extensions` → reload) mid-attempt →
  attempt recovered from `started_at`; alarm still fires at deadline.
- Expected: exactly one `attempt_started` per attempt in the event log; elapsed
  time never jumps backward or resets.

### A.6 Validate + discard

1. Open Dataset → **Validate Dataset**. Expected: `Errors: 0`. Warnings about
   unmatched attempts are normal (no ChessTempo import in Stage A).
2. Export JSON backup (keep the file: it is your Stage A evidence).
3. Delete the TEST01 session (confirmed delete) and re-run validation to confirm
   a clean slate for Stage B.

---

## STAGE B — REAL 10-PUZZLE PILOT (P01)

One participant (`P01`), 10 puzzles, **one** time condition (e.g. 15 minutes).
No scientific conclusions — instrument validation only.

1. Open ChessTempo endgame training in a tab.
2. Open the PuzzleTrack side panel (preferred surface for the whole session).
3. Click **Designate current tab as Study Tab** while the ChessTempo tab is active
   (stores the numeric tab id only — never URL/title/contents).
4. Start session: Participant `P01`, target `10`, chosen time limit.
5. For each of the 10 problems:
   - Click **Start Attempt** immediately before beginning the ChessTempo problem.
     Optionally type the ChessTempo Problem ID if visible.
   - Solve the endgame normally.
   - Click **Complete Attempt** immediately after the ChessTempo result.
   - Confirm the correct attempt number advanced (`Puzzle N of 10`).
6. After attempt 10: confirm **SESSION COMPLETE** shows Attempts: 10 and the
   session status is `completed`.
7. Export PuzzleTrack **JSON backup** (`p01-pre-import`).
8. Export PuzzleTrack **CSV** (`p01-pre-import`).
9. Download the official ChessTempo history export covering the session window.
10. Dataset → ChessTempo History Import → select the file → review the preview
    (recognized columns, valid/partial/invalid counts, duplicate report).
11. **Continue to Matching**; review every non-auto match manually
    (Match A / Match B / Leave Unmatched). Resolve conflicts explicitly
    (keep existing / use new / leave unresolved).
12. In **Pilot Review**, compare all 10 rows against your session notes
    (problem order, approximate times, results) and mark each
    **Verified** or **Needs Review** with a note where useful.
13. Run **Validate Dataset** again. Expected: `Errors: 0`; warnings only for
    items you consciously left unmatched or large timer differences you noted.
14. Export the final merged **CSV** + final **JSON backup** (`p01-final`).

## STAGE B-AUTO — LIVE-BRIDGE VARIANTS (calibration build + approval only)

Run these only with a `PT_LIVE_BRIDGE=1` build under the approval recorded in
`docs/CHESSTEMPO_PERMISSION.md`. Manual Mode (Stage A/B above) always works and
is the fallback for every step below.

### TEST01 live run (3 attempts, Auto Mode)

Use Participant `TEST01`, target `3`, Auto Mode, and the **dev-only 2-minute
limit** only for the timeout drill (never for real participants).

ATTEMPT 1 — automatic lifecycle:
- Connect the ChessTempo tab; confirm diagnostics show the live problem id.
- Start the session ONCE. Solve the first problem normally, touching nothing
  in PuzzleTrack.
- Verify: attempt auto-started on the new problem (correct problem ID, timer
  running), auto-completed on the visible result (exact elapsed, site metadata
  stored, `capture_origin = live`), no duplicate attempts, alarm cleared.

ATTEMPT 2 — interruption under automation:
- Let the next problem auto-start. Switch away from the study tab ~5 seconds,
  return, finish the puzzle normally.
- Verify: one interruption window of ~5 s (no double counting), attempt still
  auto-completed with the site result, `integrity_flag = true`.

ATTEMPT 3 — timeout drill (dev build only):
- Start a fresh TEST01 session with the dev-only 2-minute limit. Let the next
  problem auto-start, then do not solve — wait for `00:00`.
- Verify: `experimental_result = timeout`, `timed_out = true`, elapsed exactly
  the limit. Then solve the ChessTempo problem: the late site result must be
  stored separately (`chesstempo_result = correct`) WITHOUT altering the
  timeout record.

After TEST01 verify: exactly 3 attempts with unique IDs, correct problem IDs,
no duplicate auto-starts, correct end states, correct focus telemetry, no
active attempt remains, session completed, Dataset Validation passes
(`Errors: 0`), and the readiness view shows which items remain.

### Cross-validation after TEST01

1. Download the official ChessTempo history covering the TEST01 window.
2. Import it; match against the live observations.
3. Verify per attempt: problem ID, problem rating, time used (when shown),
   result, rating change → statuses `CONFIRMED` / `CONFLICT` / empty
   (unmatched). Missing fields are empty, never conflicts.
4. Raw live and raw history values must both remain auditable (live
   observation record + import row + match reasons).

### P01 live pilot (10 puzzles, Auto Mode)

1. Build the approved live-bridge version (`PT_LIVE_BRIDGE=1 npm run build`).
2. Reload the extension.
3. Open ChessTempo endgame training.
4. Open the PuzzleTrack side panel.
5. Select P01.
6. Target = 10 puzzles.
7. Select the professor-approved experimental time condition.
8. Connect the current ChessTempo tab.
9. Confirm the adapter shows READY.
10. Start the session ONCE.
11. Solve ten endgames normally.
12. Do NOT manually enter problem metadata unless automation fails.
13. Do NOT manually press Complete unless Auto Mode fails and fallback is required.
14. Allow the session to complete automatically at attempt 10.
15. Export the PuzzleTrack JSON backup.
16. Export the raw CSV.
17. Download the official ChessTempo history.
18. Import the history.
19. Review conflicts/unmatched attempts.
20. Run Dataset Validation.
21. Manually verify all 10 problem IDs.
22. Export the final merged research CSV.

Do NOT analyze the hypothesis from this pilot. This pilot validates the
measurement system. Only its success determines readiness for longitudinal
collection — do not call the instrument ready for full research yet.

---

## PILOT CHECKLIST

### PRE-SESSION

- [ ] Correct participant selected (`TEST01` for Stage A, `P01` for Stage B)
- [ ] Correct time condition selected (one condition for the whole session)
- [ ] Target attempts correct (3 for Stage A, 10 for Stage B)
- [ ] ChessTempo tab designated as Study Tab (Stage B)
- [ ] Side panel open and visible
- [ ] No previous active session (Dataset shows none active)

### PER ATTEMPT

- [ ] PuzzleTrack attempt started before solving
- [ ] Correct attempt number shown (`Puzzle N of 10`)
- [ ] Timer visibly running (countdown decreasing)
- [ ] ChessTempo puzzle completed normally
- [ ] PuzzleTrack completed/timeout/abort recorded immediately after
- [ ] No unexpected interruption recorded (or interruption noted with cause)

### POST-SESSION

- [ ] All attempts exist (3 or 10) with sequential numbers
- [ ] Session marked `completed`
- [ ] JSON backup exported (pre-import and final)
- [ ] CSV exported (pre-import and final merged)
- [ ] ChessTempo history downloaded from the official export
- [ ] ChessTempo import completed with preview reviewed
- [ ] All matches reviewed (auto + manual); conflicts resolved explicitly
- [ ] Pilot Review: 10/10 attempts marked Verified (or Needs Review with notes)
- [ ] Dataset Validation: 0 errors; warnings understood and noted
- [ ] TEST01 session deleted before/after Stage B (keep stages separate)

---

## MANUAL QA INSTRUCTIONS (numbered, no guessing)

### A. Install / update the extension

1. `cd /path/to/PuzzleTrack && npm ci && npm run build`
2. Open `chrome://extensions`, enable Developer mode.
3. If PuzzleTrack is already loaded: click Reload on its card. Otherwise: Load
   unpacked → select `extension/dist`.
4. Confirm version `0.2.x` on the card and no errors.

### B. Create TEST01

5. Open the side panel via the toolbar button (pin the extension first).
6. Enter Participant `TEST01`, Number of puzzles `3`, `15 minutes` → Start Session.

### C. Controlled 3-attempt test

7. Attempt 1: §A.2 (one ~8 s interruption, complete). Record `T_start/T_end/T_away`.
8. Attempt 2: §A.3 (close Chrome mid-attempt, verify recovery banner + resumed timer).
9. Attempt 3: §A.4 (abort after ~20 s, confirm dialog).
10. Torture checks from §A.5 during any active attempt.

### D. Inspect Dataset Validation

11. Open Dataset → **Validate Dataset**.
12. Confirm `Errors: 0`; note any warnings. Screenshot or save the summary line.
13. Check the event log counts look plausible (one `attempt_started` per attempt).

### E. Delete / discard TEST01

14. Export the TEST01 JSON backup first (Stage A evidence — keep the file).
15. Delete the TEST01 session (confirmed delete). Re-run validation: Sessions 0.

### F. Create P01

16. Designate the ChessTempo tab as Study Tab.
17. Start session: `P01`, `10` puzzles, your single chosen time condition.

### G. Run 10 real ChessTempo endgames

18. Follow Stage B steps 5–6, keeping handwritten notes (problem order, times, results).

### H. Export PuzzleTrack backup

19. Dataset → Export JSON (`p01-pre-import`). Also export pre-import CSV.

### I. Download ChessTempo history

20. Use ChessTempo's own export; save locally (never commit; see `fixtures/local/README.md`).

### J. Import it

21. Dataset → Import → select file → read the preview carefully (columns, counts, duplicates).
22. Continue to Matching only when the preview matches your expectation of the file.

### K. Review matching

23. Accept auto-applied exact/high matches after spot-checking 2–3.
24. Resolve every ambiguous case manually; resolve conflicts explicitly.

### L. Manually compare all 10 attempts

25. Pilot Review table vs your handwritten notes → Verified / Needs Review + notes.

### M. Run Dataset Validation again

26. Expect `Errors: 0`. Every warning must map to a conscious decision in your notes.

### N. Export final merged CSV (+ final JSON backup)

27. Save as `p01-final`. This plus the JSON backup is the pilot evidence package.

### O. Readiness decision

28. The instrument is ready for longitudinal collection iff: all Stage A
    expectations held, validation shows 0 errors, all 10 P01 attempts verified,
    no data was lost/duplicated/guessed at any step, and every warning is
    explained in your notes. Otherwise, stop and file the discrepancy — do not
    proceed to real participants.

---

## Testing a real ChessTempo export locally (no private data in git)

- `fixtures/local/` is gitignored (`*.csv`, `*.txt`, `*.json`).
- Place a real download at `fixtures/local/chesstempo-real.csv` and import it
  through the Dataset page in a throwaway browser profile or TEST session.
- The preview exposes recognized/unrecognized columns before anything is
  written; Cancel leaves the database untouched.
- Never commit files from `fixtures/local/` (only its README is tracked).
