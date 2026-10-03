/** Minimal async key-value adapter so domain logic stays independent of chrome.storage. */
export interface StorageAdapter {
  load(): Promise<string | null>;
  save(raw: string): Promise<void>;
  clear(): Promise<void>;
  /** Serialize a complete read/modify/write transaction across all writers. */
  withLock?<T>(operation: () => Promise<T>): Promise<T>;
}

const localQueues = new WeakMap<StorageAdapter, Promise<unknown>>();
export function withStorageLock<T>(adapter: StorageAdapter, operation: () => Promise<T>): Promise<T> {
  if (adapter.withLock) return adapter.withLock(operation);
  const result = (localQueues.get(adapter) ?? Promise.resolve()).then(operation, operation);
  localQueues.set(adapter, result.catch(() => undefined));
  return result;
}

/** In-memory adapter: used by unit tests and as fallback. */
export class MemoryStorageAdapter implements StorageAdapter {
  private raw: string | null = null;
  async load(): Promise<string | null> {
    return this.raw;
  }
  async save(raw: string): Promise<void> {
    this.raw = raw;
  }
  async clear(): Promise<void> {
    this.raw = null;
  }
  /** Simulate a reload: create a fresh repository handle over the same bytes. */
  snapshot(): string | null {
    return this.raw;
  }
  restore(raw: string | null): void {
    this.raw = raw;
  }
}
