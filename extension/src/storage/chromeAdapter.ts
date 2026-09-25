import type { StorageAdapter } from './storageAdapter.js';

/**
 * chrome.storage.local adapter. Key: single JSON blob ('puzzletrack.v1').
 * Quota is ample for v0.1 scale (tens of sessions). No network calls.
 */
const STORAGE_KEY = 'puzzletrack.v1';

export class ChromeStorageAdapter implements StorageAdapter {
  async load(): Promise<string | null> {
    const out = await chrome.storage.local.get(STORAGE_KEY);
    const v: unknown = (out as Record<string, unknown>)[STORAGE_KEY];
    return typeof v === 'string' ? v : null;
  }
  async save(raw: string): Promise<void> {
    await chrome.storage.local.set({ [STORAGE_KEY]: raw });
  }
  async clear(): Promise<void> {
    await chrome.storage.local.remove(STORAGE_KEY);
  }
}
