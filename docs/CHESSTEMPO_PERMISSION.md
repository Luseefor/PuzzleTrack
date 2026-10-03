# ChessTempo Research Permission Record

> This file records the permission state for the PuzzleTrack live bridge. It
> contains no correspondence, no email addresses, and no personal information.
> Original correspondence is retained separately in research records — do NOT
> commit email screenshots or personal correspondence to this repository.

## Status

ChessTempo provided **written approval on September 26, 2026** for the limited
non-commercial academic research integration described in the research request.
PuzzleTrack remains constrained to that approved scope.

## Approved scope (only)

For consenting research participants using their own ChessTempo accounts:

- reading limited metadata already displayed on the current endgame-training page:
  - problem ID
  - problem rating
  - participant displayed rating
  - result
  - time used
  - moves used
  - rating change
- The project owner has confirmed a separate written approval addendum covering
  per-step elapsed durations from visible progress changes. The addendum is
  retained outside this repository; its date and correspondence are not stored
  here. PuzzleTrack records step numbers and durations only, never move text or
  board positions.
- PuzzleTrack's own timer/integrity telemetry
- official ChessTempo history export for later validation

## Explicitly excluded (never implemented)

- downloading or copying the ChessTempo puzzle database
- chess-engine assistance
- automated moves or solutions
- private or undocumented APIs
- network interception
- unrelated ChessTempo or browser data

## Interpretation rules

- Do NOT interpret this permission more broadly than the scope above.
- Do NOT claim partnership, endorsement, official integration status, blanket
  API access, or permission beyond the described research use.
- The `CHESSTEMPO_LIVE_BRIDGE` feature flag stays in place regardless:
  production builds ship with the bridge disabled, and live collection is
  enabled per-study only after confirming this record.
- If the research use changes (new fields, new pages, new automation), fresh
  approval is required before implementation.
