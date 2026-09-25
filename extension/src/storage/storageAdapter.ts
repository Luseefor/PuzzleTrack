/** Minimal async key-value adapter so domain logic stays independent of chrome.storage. */
export interface StorageAdapter {
  load(): Promise<string | null>;
  save(raw: string): Promise<void>;
  clear(): Promise<void>;
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
