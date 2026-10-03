/**
 * Feature flags for the live site bridge (v0.3).
 *
 * CHESSTEMPO_LIVE_BRIDGE gates ALL live ChessTempo observation:
 * - false (default, production): no content script is registered or injected,
 *   no live adapter runs, and all bridge UI stays hidden. The official
 *   CSV-history import workflow remains fully functional.
 * - true (local development only): enables the connect flow so the adapter
 *   can be calibrated against real pages.
 *
 * Compile-time flag: esbuild defines PT_LIVE_BRIDGE from the environment
 * (`PT_LIVE_BRIDGE=1 npm run build`). The ambient declaration keeps
 * typechecking happy without bundler magic in tests.
 *
 * The flag is orthogonal to permission: written approval for the approved
 * research scope is recorded in docs/CHESSTEMPO_PERMISSION.md. The flag stays
 * because it gives reproducible builds, safe testing, and a hard off-switch
 * for site integration. The flag being on does NOT broaden the approved scope.
 */
declare const PT_LIVE_BRIDGE: string | undefined;

function readFlag(): boolean {
  try {
    return typeof PT_LIVE_BRIDGE !== 'undefined' && PT_LIVE_BRIDGE === '1';
  } catch {
    return false;
  }
}

export const CHESSTEMPO_LIVE_BRIDGE: boolean = readFlag();
