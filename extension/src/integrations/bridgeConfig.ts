/**
 * Live-bridge registration config (v0.3). Single source for the narrow host
 * scope and script identity used with chrome.scripting.
 *
 * Host-scope uncertainty (documented, not hidden): ChessTempo publishes no
 * documented training-URL contract, so the match pattern covers the host root
 * over https — the minimum pattern that certainly includes endgame/tactics
 * training pages. The adapter's detectPage() markers then gate actual
 * observation per page, so non-training ChessTempo pages stay idle. If
 * ChessTempo documents stable training paths, narrow this list and recalibrate
 * per docs/CHESSTEMPO_LIVE_BRIDGE.md.
 *
 * Requesting this host permission surfaces an install-time warning
 * ("read and change your data on chesstempo.com"). That warning is honest and
 * required for any content-script approach; the CHESSTEMPO_LIVE_BRIDGE flag
 * (default OFF) additionally guarantees nothing is injected until the
 * researcher explicitly connects a study tab.
 */
export const BRIDGE_SCRIPT_ID = 'pt-chesstempo-bridge';
export const BRIDGE_CONTENT_SCRIPT_FILE = 'content-script.js';
export const BRIDGE_HOST_MATCHES: string[] = ['https://chesstempo.com/*'];
