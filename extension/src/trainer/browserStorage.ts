import type { StorageAdapter } from '../storage/storageAdapter.js';
/** Standalone localhost storage, separate from the extension; export JSON to archive/transfer. */
export class BrowserStorageAdapter implements StorageAdapter {
  private readonly key = 'puzzletrack.local-trainer.v1';
  async load() { return localStorage.getItem(this.key); }
  async save(raw: string) { localStorage.setItem(this.key, raw); }
  async clear() { localStorage.removeItem(this.key); }
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!navigator.locks) throw new Error('Use localhost or the extension in a browser supporting Web Locks.');
    return navigator.locks.request('puzzletrack-local-trainer', {mode:'exclusive'}, operation);
  }
}
