# PuzzleTrack v0.2 — Experiment Protocol (preliminary, configurable)

> This protocol is preliminary and configurable. Adjust puzzle counts, time limits, and
> instructions per ethics approval before running participants.
>
> v0.3 adds an **Auto Mode** variant below. It requires a calibration build
> (`PT_LIVE_BRIDGE=1`) and operates under the written approval recorded in
> `docs/CHESSTEMPO_PERMISSION.md` — limited scope only. Default production
> builds run Manual Mode.

## Recommended workflow (Manual Mode — supported)

1. Participant opens ChessTempo endgame training in a browser tab.
2. Participant opens the PuzzleTrack **side panel** (stays visible beside ChessTempo;
   popup remains available for quick access).
3. Participant designates the ChessTempo tab as the **Study Tab**
   (`Designate current tab as Study Tab` — stores only the numeric tab id).
4. Researcher/participant enters the Participant ID (e.g. `P01`).
5. Selects the experimental time limit (15 / 30 / 45 / 60 minutes per puzzle).
6. Clicks **Start Session** (creates `session_id`, records `started_at`; timer does NOT start yet).
7. Immediately before starting each chess problem, clicks **Start Attempt** in PuzzleTrack
   (creates `attempt_id`, records `started_at`, starts countdown + integrity monitoring).
   Optionally enter the ChessTempo **Problem ID** shown on screen — this greatly improves
   later matching and is the only typing ever asked for.
8. Solves the problem, then clicks **Complete Attempt** — or lets the countdown reach zero
   (**TIME LIMIT REACHED**, recorded as `timeout`, result locked) — or **Abort Attempt**
   (confirmed) if the trial is invalid. The Problem ID can also be entered right after.
9. Clicks **Next Puzzle** and repeats for the target number of attempts.
10. After the final puzzle, reviews **SESSION COMPLETE** (experimental, chess, integrity,
    and matching sections).
11. Participant/researcher downloads their **ChessTempo history CSV** (ChessTempo's own export).
12. Researcher imports the file via the Dataset page, reviews the preview, continues to
    matching, and resolves any ambiguous/conflicting cases manually.
13. Researcher exports the final dataset (**Session/Full CSV** + **JSON backup**).

## Auto Mode workflow (v0.3 — permission + calibration build required)

1. Open ChessTempo endgame training.
2. Open the PuzzleTrack side panel.
3. Select operating mode **Auto** and click **Connect ChessTempo study tab**,
   then confirm **Use connected tab as Study Tab**.
4. Select P01, 10 attempts, the single time condition.
5. Click **Start Research Session ONCE**.
6. Solve ten endgames normally. PuzzleTrack starts each attempt when a new
   problem stabilizes, stops it when the visible result appears, and advances
   automatically. Timeouts stay authoritative; connection loss shows
   Reconnect / Switch to Manual without touching timer data.
7. Session completes automatically at the target count — no attempt 11.
8. Export backup, download official history, import, and review only
   conflicts/unmatched attempts (live observations show as CONFIRMED where the
   history agrees).
9. Export the final research dataset.

## Researcher notes

- **What counts as an interruption:** leaving the designated study tab
  (`study_tab_inactive`), hiding the PuzzleTrack UI (`tab_hidden`), or leaving Chrome
  (`window_blur`) while an attempt is active. Overlapping signals collapse into one
  away-window. Recorded neutrally as `focus_loss_count` / `total_time_away_ms` /
  `integrity_flag`. It is NOT labeled cheating.
- **For the cleanest signal:** use the side panel plus a designated study tab. If all UI
  surfaces are closed, only window-level and study-tab transitions are captured.
- **Timeouts:** automatic and locked; participants cannot override them.
- **Matching:** only `exact` (and single-candidate `high`) matches apply automatically.
  Ambiguous cases show every plausible record with timestamps — choose one or leave
  unmatched. Never invent a match; unresolved cases stay `null`, never fabricated.
- **Conflicts/duplicates:** re-importing the same file skips existing rows; differing
  values for the same problem+timestamp require an explicit keep/use-new decision.
- **Interruptions / crashes:** if Chrome closes mid-attempt, PuzzleTrack flags
  `possibly_interrupted` on recovery. The researcher may resume (if time remains) or mark
  the attempt aborted. Nothing is auto-fabricated or silently deleted.
- **Data handling:** all data stays in the browser (`chrome.storage.local`). Export CSV
  after each session, keep the JSON backup, and back up the files. Deleting a test session
  requires confirmation and cannot be undone. Restoring a backup replaces current data
  (double-confirmed).
