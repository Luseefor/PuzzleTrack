# ChessTempo Live Bridge (v0.3 engineering)

> **Permission status: APPROVED (limited scope).** ChessTempo provided written
> approval on September 26, 2026 for the limited non-commercial academic
> research integration described in the research request (see
> `docs/CHESSTEMPO_PERMISSION.md`). This is not a partnership, endorsement, or
> blanket API grant. The bridge stays flag-gated and constrained to the
> approved fields regardless.

## Architecture

Core PuzzleTrack (session, timer, repository, analysis, matching) contains
**zero** ChessTempo selectors, DOM references, or page assumptions. It talks
to the bridge exclusively through semantic events:

```text
ChessTempo page
  → content-script.ts (flag-gated entry, observes + parses only)
  → ChessTempoAdapter (pure state machine over semantic readings)
  → SiteEvent { problem_loaded | problem_completed | problem_changed | … }
  → background service worker → autoController.handleSiteEvent(store, event)
  → sessionManager (startAttempt / completeAttempt / recordLateSiteResult)
  → merge-save → alarms, bridge status, UI
```

Files (all under `src/integrations/`, none imported by core):

| File | Role | Page knowledge |
|---|---|---|
| `featureFlags.ts` | `CHESSTEMPO_LIVE_BRIDGE` compile-time flag | none |
| `bridgeConfig.ts` | script id + narrow host scope | host only |
| `siteAdapter.ts` | `StudySiteAdapter` interface (core-facing contract) | none |
| `chessTempo/chessTempoTypes.ts` | `SiteProblem`, `SiteResult`, `SiteEvent`, states | none |
| `chessTempo/chessTempoSelectors.ts` | centralized selector candidates | isolated here |
| `chessTempo/chessTempoParser.ts` | pure string→value parsers, null on doubt | none |
| `chessTempo/chessTempoObserver.ts` | MutationObserver + text extraction | reads only |
| `chessTempo/chessTempoAdapter.ts` | pure reducer + adapter class | semantic only |
| `chessTempo/content-script.ts` | injection entry, message bridge | wires only |
| `autoController.ts` | store orchestration over `SiteEvent`s | none |

## Feature flag

- Default production build: `npm run build` → flag **off**. No content script
  is registered or injected, bridge UI stays hidden, CSV-history workflow is
  byte-for-byte unaffected.
- Local calibration build: `PT_LIVE_BRIDGE=1 npm run build` → flag on. The
  build log prints `CHESSTEMPO_LIVE_BRIDGE: ENABLED (local dev only)`.
- The flag is inlined at compile time (no residual identifier in `dist/`).

## Minimum permissions

- `scripting` permission + `host_permissions: ["https://chesstempo.com/*"]`.
- No `<all_urls>`, no content-script declarations in the manifest, no host
  access beyond the single ChessTempo host over https.
- Registration is **dynamic** (`chrome.scripting.registerContentScripts`,
  non-persistent) only after the researcher clicks Connect on a study tab, plus
  an explicit `executeScript` into that tab if already loaded. Disconnect /
  tab-close unregisters and sends shutdown.
- Installing the extension shows an honest host warning for chesstempo.com.
  The flag guarantees the capability is dormant until explicitly connected.

## Fields captured (and NOT captured)

Captured, all nullable (missing stays null, never fabricated):

- `SiteProblem`: problemId, problemRating, difficultyLabel, mode.
- `SiteParticipantContext`: displayedRating only. **Usernames are never read.**
- `SiteResult`: result, timeUsedSeconds, movesUsed, averageMoves,
  playerRatingAfter, ratingChange.
- Visible step-counter transitions: elapsed milliseconds for each observed step.
  Only the step index and duration are retained; move text and board positions
  are not collected. Missed transitions remain null and require review.
- PuzzleTrack identity stays `P01…`; displayed rating provides continuity. No
  account fingerprinting is implemented; see identity strategy below.

Explicitly never captured: board positions in bulk, puzzle databases, unrelated
page text, URLs, titles, keystrokes, screenshots, network traffic, credentials.
The observer reads element *text* through allow-listed selectors only.

## State machine

Adapter states: `NO_PROBLEM → PROBLEM_READY → ATTEMPT_ACTIVE →
RESULT_DETECTED → (WAITING_FOR_NEXT) → PROBLEM_READY …`, plus `ADAPTER_ERROR`.

- A problem is reported (`problem_loaded`) exactly once per **stable** new id
  (same id across consecutive readings or a dwell time). Rerenders never re-emit.
- Results latch per problem: duplicate result DOM is ignored.
- A stable *different* id mid-attempt emits one informational
  `problem_changed`; the controller flags the attempt for review, never guesses.
- Lost training markers → `ADAPTER_ERROR` + `adapter_lost` (no data recorded);
  markers returning → `adapter_recovered` + fresh detection.

## Auto-start / auto-complete triggers

- **Start** (`problem_loaded`): requires an active auto-mode session, no active
  attempt, finished count below target, and an id unseen in this session.
  Creates the attempt UUID, attaches problem/rating/player-before immediately,
  opens a live observation, starts the timestamp timer + integrity monitoring,
  schedules the timeout alarm.
- **Complete** (`problem_completed`): finishes the matched active attempt with
  exact PuzzleTrack elapsed, stores site metadata + provenance, clears the alarm.
  Unknown site outcomes finish as `completed` with `chesstempo_result`
  `"unknown"` and `requires_review = true` — raw timing preserved, result not
  guessed.
- **Timeout remains authoritative**: the alarm path finishes the attempt at
  exactly the limit. A later site result is recorded via `recordLateSiteResult`
  (site fields + observation only) and can never overwrite the timeout.

## Duplicate-event prevention

Stability gating + per-problem latches in the adapter; session-level id scan,
active-attempt guard, and target-count guard in the controller; greedy 1:1
matching unchanged. Covered by unit tests (rerenders, double result DOM,
rapid next-problem, already-claimed rows).

## Timeout race behavior

Whichever side is processed first wins, ordered by stored timestamps: site
completion first → alarm finds a finished attempt and no-ops; timeout first →
the site result lands as a late arrival. Both orders are unit-tested.

## Fallback behavior

Manual controls are never removed. Mode is per session (`auto_mode`, default
manual). Connection loss shows **ChessTempo connection lost — timer continues**
with **Reconnect** / **Switch to Manual**; the active attempt and its
timestamps are untouched. Switching to manual only flips the flag and
disconnects the script.

## History cross-validation

Official CSV import after the session compares each matched row against the
live observation (id, rating, time-used ±2 s, result vocabulary): agreement →
`cross_validation = confirmed`, `capture_origin = live+history`; disagreement →
field conflicts through the existing review flow (`cross_validation =
conflict`). Unmatching restores live values instead of erasing the run. CSV
gains `capture_origin` + `cross_validation` columns.

## Identity strategy

`participant_id` (`P01`) remains canonical. Only the displayed rating is
collected for continuity. No usernames are read or stored, and no account
fingerprint is computed — there is deliberately no code path that could export
ChessTempo account identity in the default research CSV. If a future protocol
requires account-consistency checking, it must be designed, documented, and
consented separately.

## Privacy boundaries

Same as core, extended: numeric tab ids only; no URLs/titles/contents; no
network calls anywhere (content script included); observation limited to
allow-listed training metadata; diagnostics show field presence + values, never
DOM fragments or page text; calibration view hidden during sessions.

## Permission requirement

Live collection operates under the written approval recorded in
`docs/CHESSTEMPO_PERMISSION.md` (September 26, 2026, limited
non-commercial academic scope). Confirm that record before any deployment;
any use beyond the approved fields or pages needs fresh approval first.

## Calibration procedure (real endgame-training UI)

Build with the live bridge enabled:

```bash
PT_LIVE_BRIDGE=1 npm run build
```

Then follow these exact manual steps (nothing here writes research data —
diagnostics are read-only):

1. **Reload the unpacked extension.** Open `chrome://extensions`, find the
   PuzzleTrack card, click **Reload**. Confirm no errors on the card.
2. **Open ChessTempo endgame training** in a normal tab and log in with the
   research account if required. Keep a problem visible on screen.
3. **Open the PuzzleTrack side panel** (toolbar icon → Open Side Panel, or the
   in-extension button). The panel and the ChessTempo tab stay side by side.
4. **Connect the current ChessTempo tab.** In the panel's setup view, the
   *Operating mode* + **Connect ChessTempo study tab** controls are visible
   only in this build. Click it while the ChessTempo tab is active. Expect the
   status line to change to *Live bridge: connected*.
5. **Open diagnostics.** Still in the setup view (idle — diagnostics never
   appear during sessions), read the **Bridge diagnostics** block:
   `Adapter state`, `Problem detected`, `Fields found`, `Fields missing`.
6. **Inspect which fields PuzzleTrack sees.** Walk through a problem while
   watching diagnostics update:
- a stable problem on screen → `Problem detected: #<id>`, state `READY`;
- a visible progress counter → current step index and total, when the site exposes them;
   - solve it to the visible result → `Result: <value>`, plus time/moves/
     rating fields if the page shows them;
   - advance to the next problem → the id changes exactly once.
   - Compare every value against what is visibly on the ChessTempo page.
7. **Record gaps.** Any required field (problem id, problem rating, displayed
   player rating, result state) showing as missing or wrong means selectors
   are uncalibrated — do not proceed to TEST01; recalibrate first (next section).

During calibration, diagnostics display ONLY semantic extracted values such as:

```text
Adapter state: READY
Problem ID: 81496
Problem rating: 702
Player rating: 1506.9
Result: null
Time used: null
Moves: null
Rating change: null
```

They never dump page HTML, DOM fragments, unrelated text, URLs beyond what is
already needed internally, usernames, or page contents unrelated to the
research fields.

## Recalibrating selectors after a ChessTempo UI change

1. Build with `PT_LIVE_BRIDGE=1`, load unpacked, open a ChessTempo training page.
2. Connect the tab; open the setup-view **Bridge diagnostics** (idle only).
3. Read *missing* fields; map each to the real element in DevTools.
4. Add candidates to `chessTempoSelectors.ts` (never scatter them elsewhere).
5. Extend `extension/tests/fixtures/chesstempo/` + parser/machine tests.
6. Re-run `npm run typecheck`, `npx vitest run`, `npm run build`.
7. The adapter must reach `PROBLEM_READY → ATTEMPT_ACTIVE → RESULT_DETECTED`
   on a rehearsal session before any real collection.

## Known selector uncertainties

- All selectors are **uncalibrated structural guesses**; real ChessTempo DOM is
  unknown to this project. Expect the adapter to sit in `NO_PROBLEM` /
  `ADAPTER_ERROR` until calibrated.
- The exact endgame-training URL path is unknown; host scope is therefore
  `https://chesstempo.com/*` with per-page marker gating (see bridgeConfig).
- Result vocabulary, time formats, and rating placement are covered by tolerant
  parsers, but unseen formats yield nulls (safe) rather than values.
- `averageMoves` has no observable source in the current design and stays null
  for live observations (history import remains its source).
