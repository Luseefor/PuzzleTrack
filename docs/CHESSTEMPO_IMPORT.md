# Importing ChessTempo History (v0.2)

PuzzleTrack never scrapes ChessTempo, reads its pages, or calls its APIs.
Instead, **you download your own history export from ChessTempo** and import
that file into PuzzleTrack. Everything happens locally in your browser.

## How to export your ChessTempo history

1. Log in to ChessTempo in your browser.
2. Open your tactics / endgame attempt history.
3. Use ChessTempo's own export/download function to save the history as a
   **CSV file** (e.g. `history.csv`). Any text-based export with a header row works.
4. Keep the file as-is — PuzzleTrack never modifies the original.

> ChessTempo's exact export columns may vary over time. PuzzleTrack does not
> hard-code one true layout (see "Recognized fields" below).

## How to import it

1. Open the PuzzleTrack **Dataset** page (`View Dataset`, or `Import ChessTempo History` after a session).
2. Scroll to **ChessTempo History Import** and choose your CSV file.
3. Review the **import preview** (nothing is written yet):
   - `Rows found / Valid / Partial / Invalid`
   - `Recognized fields` (✓) and `Unavailable` (—) lists
   - unknown columns (ignored for matching, raw values kept)
   - `Already imported / New records / Potential conflicts` (duplicate protection)
   - a preview of the first 8 rows
4. Click **Cancel** to discard, or **Continue to Matching** to register the import.
5. Obvious matches are applied automatically (see confidence rules).
   Ambiguous and conflicting cases appear for **manual resolution** — nothing is guessed.
6. Export the research dataset (CSV) or a full JSON backup.

## Recognized fields

Headers are matched case- and punctuation-insensitively against alias lists:

| PuzzleTrack field | Example headers accepted |
|---|---|
| Problem ID | `Problem ID`, `problem_id`, `puzzle_id`, `Problem`, `#` stripped |
| Attempt time | `Date`, `Time`, `Datetime`, `Played At`, `Attempted At`, `Timestamp` |
| Problem rating | `Problem Rating`, `puzzle_rating`, `Rating`, `Elo` (bare `Rating`/`Elo` claimed only when no specific problem-rating column exists) |
| Player rating | `Player Rating`, `My Rating`, `User Rating`, `Rating Before` |
| Player rating after | `Player Rating After`, `New Rating`, `Rating After` |
| Result | `Result`, `Outcome`, `W/L`, `Score`, `Solved` (raw string preserved; correctness is a documented heuristic, see below) |
| Time used | `Time Used (s)`, `Time Used`, `Duration`, `Seconds`, `Time Spent` |
| Moves used | `Moves`, `Moves Used`, `Move Count` |
| Average moves | `Average Moves`, `Avg Moves` |
| Rating change | `Rating Change`, `Rating Diff` |
| Difficulty label | `Difficulty`, `Level` |

Row classification: **valid** (problem ID + attempt time present), **partial**
(one of them), **invalid** (neither). Malformed rows are classified with notes —
never silently dropped. Raw cells are always preserved per row for audit.

## How matching works

Matching is deterministic and never by row order. For each finished,
unmatched PuzzleTrack attempt, every usable ChessTempo row is scored on:

1. **Problem-ID match** — the optional manual Problem ID you can enter during
   or right after an attempt (heavily preferred), compared case-insensitively.
2. **Timestamp proximity** — ChessTempo `attemptedAt` relative to the
   PuzzleTrack `[started_at − 60s, ended_at + window]` interval.
3. **Time-used similarity** — supporting signal when both PuzzleTrack elapsed
   and ChessTempo time-used exist (agreement = within 60 s).

Windows: **tight** = up to 120 s after attempt end (auto-match territory);
**wide** = 120–600 s after end (manual review only); beyond 600 s = no match.

## Confidence levels

| Level | Meaning | Auto-applied? |
|---|---|---|
| `exact` | Single problem-ID match + timestamp in tight window + time-used agrees (or is missing) | Yes |
| `high` | ID match in wide window / without timestamp, or single candidate in tight window | Yes, only with a single candidate |
| `medium` | Single candidate in wide window | No — researcher confirms |
| `low` | Ambiguous (≥2 plausible rows) or otherwise indecisive | No — researcher resolves |
| `unmatched` | No candidate at all | — |

One ChessTempo row can match at most one attempt and vice versa (greedy 1:1,
exact first). If the best row is already claimed, the loser is demoted to
manual review.

## Ambiguous records

Attempt lists every plausible record with problem ID + timestamp and offers
**one button per candidate** plus **Leave Unmatched**. The match is written
only when you click. Reasons (timestamp deltas, ID agreement, time-used
comparison) are shown to support your decision.

## Raw vs derived fields

- **RAW** (stored exactly as measured/imported): all experimental timing and
  integrity fields; all `problem_*`, `player_*`, `chesstempo_*`, `moves_*`,
  `rating_change`, `difficulty_label` values.
- **PROVENANCE** (stored): `chesstempo_import_id`, `chesstempo_source_row`,
  `match_confidence`, plus the `imports` table and per-row `raw` cells.
- **DERIVED** (computed on demand at view/export time, never stored as raw):
  `relative_difficulty`, `timer_difference_seconds`, `away_time_percentage`,
  `completed_within_limit`, correctness counts (heuristic — see below).

The "Correct X / Y" summary uses a conservative heuristic (`win/won/correct/
solved/success/1/1-0/true/yes`, case-insensitive); anything else counts as
not-correct, and missing results are excluded from the denominator display.
Verify it against your ChessTempo result vocabulary before publishing.

## Duplicate protection

- Each file gets an FNV-1a fingerprint; re-importing the same file warns you.
- Rows are fingerprinted on `problemId | attemptedAt | result | timeUsed`;
  exact duplicates are **skipped, never stored twice**.
- Same problem + timestamp with different values is flagged as a
  **potential conflict** for review.

## Conflict handling

If a new row disagrees with already-matched values (e.g. problem rating 704
vs 709), nothing is overwritten. You choose per attempt: **Keep existing**,
**Use new values** (provenance records `conflictResolved: true`), or
**Leave unresolved**. Unmatching an attempt clears its chess fields and link
for re-matching.

## Privacy boundaries

- Only files **you explicitly select** are read, only in memory, only locally.
- The importer stores normalized rows + provenance, never the original file blob.
- Study-tab tracking stores only the numeric tab id — never URLs, titles,
  page contents, history, keystrokes, or screenshots.
- No network requests exist anywhere in the extension. Verify in DevTools.
