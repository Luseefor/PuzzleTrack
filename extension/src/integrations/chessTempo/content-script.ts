/**
 * Content-script entry (v0.3). Runs ONLY when explicitly injected by the
 * background worker after the researcher enables the bridge AND connects a
 * study tab (dynamic chrome.scripting registration — nothing is injected
 * while the CHESSTEMPO_LIVE_BRIDGE flag is off).
 *
 * Defense in depth: exits immediately if the flag is off or the page is not
 * a training page. Responsibilities strictly limited to:
 * - observe visible training UI state,
 * - parse permitted research metadata,
 * - emit typed semantic messages to the background worker.
 *
 * Must NOT: touch game state, click, solve, navigate, inject scripts, read
 * other tabs, or perform any network request.
 */
import { CHESSTEMPO_LIVE_BRIDGE } from '../featureFlags.js';
import { ChessTempoAdapter } from './chessTempoAdapter.js';
import { observeTrainingPage, readTrainingPage } from './chessTempoObserver.js';
import type { SiteEvent } from './chessTempoTypes.js';

// One observer per page even when Connect injects the script again.
const page = globalThis as typeof globalThis & { __puzzleTrackBridge?: boolean };
if (CHESSTEMPO_LIVE_BRIDGE && !page.__puzzleTrackBridge) {
  page.__puzzleTrackBridge = true;
  void (async () => {
    const scope = await chrome.runtime.sendMessage({ kind: 'pt-outbox-scope' }) as { tabId?: number };
    if (scope.tabId === undefined) throw new Error('No study-tab scope for observation outbox.');
    const prefix = `pt-outbox:${scope.tabId}:`;
    const adapter = new ChessTempoAdapter({ readPage: readTrainingPage, observe: observeTrainingPage });
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let chain: Promise<void> = Promise.resolve();
    const drain = async (): Promise<void> => {
      if (stopped) return;
      const pending = await chrome.storage.local.get(null);
      const entries = Object.entries(pending).filter(([key]) => key.startsWith(prefix))
        .sort((a, b) => (a[1] as { event: SiteEvent }).event.atMs - (b[1] as { event: SiteEvent }).event.atMs);
      for (const [key, message] of entries) {
        const ack = await chrome.runtime.sendMessage(message) as { ok?: boolean; error?: string };
        if (!ack?.ok) throw new Error(ack?.error ?? 'Observation not acknowledged.');
        await chrome.storage.local.remove(key);
      }
    };
    const enqueue = (event?: SiteEvent): void => {
      chain = chain.catch(() => undefined).then(async () => {
        if (event) {
          const eventId = crypto.randomUUID();
          await chrome.storage.local.set({ [`${prefix}${eventId}`]: { kind: 'pt-site-event', eventId, event } });
        }
        await drain();
      }).catch(() => {
        if (!stopped && retry === null) retry = setTimeout(() => { retry = null; enqueue(); }, 1000);
      });
    };
    // Subscribe before start() so initial observations cannot be missed.
    adapter.subscribe(event => enqueue(event));
    const listener = (msg: { kind?: string; problemId?: string }, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void): boolean => {
      if (msg.kind === 'pt-attempt-started' && typeof msg.problemId === 'string') {
        adapter.notifyAttemptStarted(msg.problemId);
        sendResponse({ ok: true });
      } else if (msg.kind === 'pt-attempt-ended' && typeof msg.problemId === 'string') {
        adapter.notifyAttemptEnded(msg.problemId);
        sendResponse({ ok: true });
      } else if (msg.kind === 'pt-session-started') {
        adapter.tick();
        sendResponse({ ok: true, replayed: adapter.replayReadyProblem() });
      } else if (msg.kind === 'pt-diagnostic-request') {
        sendResponse({ ok: true, diagnostics: adapter.getDiagnostics() });
      } else if (msg.kind === 'pt-bridge-shutdown') {
        stopped = true;
        if (retry !== null) clearTimeout(retry);
        adapter.dispose();
        chrome.runtime.onMessage.removeListener(listener);
        page.__puzzleTrackBridge = false;
        sendResponse({ ok: true });
      } else sendResponse({ ok: false });
      return false;
    };
    chrome.runtime.onMessage.addListener(listener);
    adapter.start();
    enqueue(); // recover any unacknowledged observations for this tab
    window.addEventListener('pagehide', () => {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      adapter.dispose();
    }, { once: true });
  })().catch(error => {
    page.__puzzleTrackBridge = false;
    console.error('PuzzleTrack bridge could not start:', error instanceof Error ? error.message : 'unknown error');
  });
}
