/**
 * JSON backup / reproducibility export (v0.2).
 * Contains participants, sessions, attempts, events, imports, import rows,
 * and match metadata — everything needed to reproduce the research dataset.
 * Local file download only; no network. Re-import validates schema version.
 */
import { SCHEMA_VERSION, type PuzzleTrackStore } from '../models/types.js';
import { migrateStore } from '../storage/migration.js';

export interface JsonBackup {
  format: 'puzzletrack-backup';
  formatVersion: 1;
  schemaVersion: number;
  exportedAt: string;
  store: PuzzleTrackStore;
}

export function buildBackup(store: PuzzleTrackStore, nowMs: number = Date.now()): JsonBackup {
  return {
    format: 'puzzletrack-backup',
    formatVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date(nowMs).toISOString(),
    store,
  };
}

export function serializeBackup(backup: JsonBackup): string {
  return JSON.stringify(backup, null, 2);
}

/** Parse + validate a backup file; migrates older schemas. Throws on invalid input. */
export function parseBackup(text: string): PuzzleTrackStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Backup file is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('Backup file has invalid shape.');
  const obj = parsed as Record<string, unknown>;
  if (obj['format'] !== 'puzzletrack-backup') throw new Error('Not a PuzzleTrack backup file.');
  if (obj['store'] === undefined) throw new Error('Backup file is missing the store payload.');
  return migrateStore(obj['store']);
}

export function backupFilename(whenIso: string): string {
  return `puzzletrack-backup-${whenIso.replace(/[:.]/g, '-')}.json`;
}
