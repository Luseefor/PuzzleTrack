/**
 * Manual ChessTempo history importer (v0.2).
 *
 * Local-only: parses a user-downloaded history CSV into normalized
 * ChessTempoAttempt rows. No network, no scraping, original file untouched.
 * Because ChessTempo's exact export columns may vary, headers are matched
 * against alias lists; recognized/missing/unknown columns are REPORTED, and
 * nothing is destructively guessed. Malformed rows are classified, never
 * silently dropped (raw cells always preserved).
 */
import { newUuid } from '../utils/ids.js';
import { nowIso } from '../utils/time.js';
import type { ChessTempoAttempt, ChessTempoImport, DuplicateReport } from '../models/chesstempo.js';
import { parseCsvText } from './csvParse.js';

type LogicalField =
  | 'problemId'
  | 'attemptedAt'
  | 'problemRating'
  | 'playerRatingBefore'
  | 'playerRatingAfter'
  | 'result'
  | 'timeUsedSeconds'
  | 'movesUsed'
  | 'averageMoves'
  | 'ratingChange'
  | 'difficultyLabel';

const FIELD_LABELS: Record<LogicalField, string> = {
  problemId: 'Problem ID',
  attemptedAt: 'Attempt time',
  problemRating: 'Problem rating',
  playerRatingBefore: 'Player rating',
  playerRatingAfter: 'Player rating after',
  result: 'Result',
  timeUsedSeconds: 'Time used',
  movesUsed: 'Moves used',
  averageMoves: 'Average moves',
  ratingChange: 'Rating change',
  difficultyLabel: 'Difficulty label',
};

/** Header aliases (normalized: lowercase, non-alphanumeric stripped). Order matters. */
const ALIASES: Record<LogicalField, string[]> = {
  problemId: ['problemid', 'problemnumber', 'problemno', 'puzzleid', 'puzzlenumber', 'puzzleno', 'problem', 'puzzle'],
  attemptedAt: ['attemptedat', 'attemptedon', 'playedat', 'playedon', 'completedat', 'datetime', 'timestamp', 'date', 'time'],
  problemRating: ['problemrating', 'puzzlerating', 'problemelo', 'puzzleelo'],
  playerRatingBefore: ['playerratingbefore', 'playerrating', 'userrating', 'myrating', 'ratingbefore', 'startingrating'],
  playerRatingAfter: ['playerratingafter', 'ratingafter', 'newrating', 'finalrating', 'endingrating'],
  result: ['result', 'outcome', 'winloss', 'wl', 'score', 'success', 'solved'],
  timeUsedSeconds: ['timeusedseconds', 'timeused', 'timeuseds', 'timespent', 'timetaken', 'durationseconds', 'duration', 'durations', 'elapsedseconds', 'secondsused', 'seconds', 'timeseconds'],
  movesUsed: ['movesused', 'movesplayed', 'movecount', 'numberofmoves', 'moves', 'plies'],
  averageMoves: ['averagemoves', 'avgmoves', 'averagenoofmoves'],
  ratingChange: ['ratingchange', 'ratingdiff', 'ratingdelta', 'elochange'],
  difficultyLabel: ['difficultylabel', 'difficulty', 'level'],
};

const GENERIC_RATING_ALIASES = ['rating', 'elo'];

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface HeaderMapping {
  /** logical field -> column index (only for recognized fields). */
  mapped: Partial<Record<LogicalField, number>>;
  recognizedFields: string[];
  missingFields: string[];
  unknownHeaders: string[];
}

export function mapHeaders(headers: string[]): HeaderMapping {
  const norm = headers.map(normalizeHeader);
  const used = new Set<number>();
  const mapped: Partial<Record<LogicalField, number>> = {};
  const recognizedFields: string[] = [];
  const missingFields: string[] = [];

  const fields = Object.keys(ALIASES) as LogicalField[];
  for (const field of fields) {
    let found = -1;
    for (const alias of ALIASES[field]) {
      const idx = norm.findIndex((h, i) => !used.has(i) && h === alias);
      if (idx >= 0) {
        found = idx;
        break;
      }
    }
    if (found >= 0) {
      used.add(found);
      mapped[field] = found;
      recognizedFields.push(FIELD_LABELS[field]);
    } else {
      missingFields.push(FIELD_LABELS[field]);
    }
  }

  // A bare "rating"/"elo" column most likely means the problem rating
  // (ChessTempo history shows the problem's rating). Only claim it when
  // problemRating is still unmapped, and say so in the recognized label.
  if (mapped['problemRating'] === undefined) {
    for (const alias of GENERIC_RATING_ALIASES) {
      const idx = norm.findIndex((h, i) => !used.has(i) && h === alias);
      if (idx >= 0) {
        used.add(idx);
        mapped['problemRating'] = idx;
        recognizedFields.push('Problem rating');
        const miss = missingFields.indexOf('Problem rating');
        if (miss >= 0) missingFields.splice(miss, 1);
        break;
      }
    }
  }

  const unknownHeaders = headers.filter((_, i) => !used.has(i));
  return { mapped, recognizedFields, missingFields, unknownHeaders };
}

function parseNumberOrNull(raw: string, notes: string[], label: string): number | null {
  const t = raw.trim().replace(/,/g, '');
  if (t === '') return null;
  // Tolerate trailing units like "43s" / "1200 pts".
  const m = t.match(/^[+-]?(\d+(\.\d+)?)/);
  if (!m) {
    notes.push(`${label} not numeric ("${raw.trim()}") — kept null, raw preserved.`);
    return null;
  }
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function parseDateOrNull(raw: string, notes: string[], label: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) {
    notes.push(`${label} not a recognized date ("${t}") — kept null, raw preserved.`);
    return null;
  }
  return new Date(ms).toISOString();
}

/** FNV-1a 32-bit hex over normalized text — stable file fingerprint. */
export function fingerprintText(text: string): string {
  const norm = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i) as number;
    h = Math.imul(h, 0x01000193);
  }
  return ('0000000' + ((h as number) >>> 0).toString(16)).slice(-8);
}

/** Stable row identity for duplicate detection (no guessing). */
export function rowDedupKey(row: Pick<ChessTempoAttempt, 'problemId' | 'attemptedAt' | 'result' | 'timeUsedSeconds'>): string {
  return [row.problemId ?? '', row.attemptedAt ?? '', (row.result ?? '').toLowerCase(), row.timeUsedSeconds ?? ''].join('|');
}

export interface ImportParseResult {
  import: ChessTempoImport;
  rows: ChessTempoAttempt[];
  mapping: HeaderMapping;
}

export function parseChessTempoCsv(
  fileText: string,
  originalFilename: string,
  nowMs: number = Date.now(),
): ImportParseResult {
  const { headers, rows } = parseCsvText(fileText);
  const mapping = mapHeaders(headers);
  const importId = newUuid();
  const importedAt = nowIso(nowMs);

  const out: ChessTempoAttempt[] = [];
  let valid = 0;
  let partial = 0;
  let invalid = 0;

  rows.forEach((cells, i) => {
    const sourceRow = i + 1;
    const notes: string[] = [];
    const raw: Record<string, string> = {};
    headers.forEach((h, ci) => {
      raw[h] = (cells[ci] as string | undefined) ?? '';
    });
    if (cells.length !== headers.length) {
      notes.push(
        `Column count ${cells.length} differs from header count ${headers.length} — row ${cells.length < headers.length ? 'padded' : 'truncated'}.`,
      );
    }
    const at = (f: LogicalField): string => {
      const ci = mapping.mapped[f];
      if (ci === undefined) return '';
      return (cells[ci] as string | undefined) ?? '';
    };

    const problemRaw = at('problemId').trim().replace(/^#/, '');
    const problemId = problemRaw === '' ? null : problemRaw;
    const attemptedAt = mapping.mapped['attemptedAt'] !== undefined ? parseDateOrNull(at('attemptedAt'), notes, 'Attempt time') : null;
    const problemRating = parseNumberOrNull(at('problemRating'), notes, 'Problem rating');
    const playerRatingBefore = parseNumberOrNull(at('playerRatingBefore'), notes, 'Player rating');
    const playerRatingAfter = parseNumberOrNull(at('playerRatingAfter'), notes, 'Player rating after');
    const resultRaw = at('result').trim();
    const result = resultRaw === '' ? null : resultRaw;
    const timeUsedSeconds = parseNumberOrNull(at('timeUsedSeconds'), notes, 'Time used');
    const movesUsed = parseNumberOrNull(at('movesUsed'), notes, 'Moves used');
    const averageMoves = parseNumberOrNull(at('averageMoves'), notes, 'Average moves');
    const ratingChange = parseNumberOrNull(at('ratingChange'), notes, 'Rating change');
    const diffRaw = at('difficultyLabel').trim();
    const difficultyLabel = diffRaw === '' ? null : diffRaw;

    let validity: ChessTempoAttempt['validity'];
    if (problemId !== null && attemptedAt !== null) {
      validity = 'valid';
      valid++;
    } else if (problemId !== null || attemptedAt !== null) {
      validity = 'partial';
      notes.push(
        problemId === null ? 'Missing problem ID — row is partial.' : 'Missing/unparseable attempt time — row is partial.',
      );
      partial++;
    } else {
      validity = 'invalid';
      notes.push('Missing both problem ID and attempt time — row is invalid.');
      invalid++;
    }

    out.push({
      rowId: `${importId}:row:${sourceRow}`,
      importId,
      sourceRow,
      problemId,
      attemptedAt,
      problemRating,
      playerRatingBefore,
      playerRatingAfter,
      result,
      timeUsedSeconds,
      movesUsed,
      averageMoves,
      ratingChange,
      difficultyLabel,
      validity,
      validityNotes: notes,
      raw,
    });
  });

  const totalRows = out.length;
  const fingerprint = fingerprintText(fileText);
  return {
    mapping,
    rows: out,
    import: {
      importId,
      importedAt,
      originalFilename,
      fileFingerprint: fingerprint,
      totalRows,
      validRows: valid,
      partialRows: partial,
      invalidRows: invalid,
      matchedRows: 0,
      unmatchedRows: totalRows,
      recognizedFields: mapping.recognizedFields,
      missingFields: mapping.missingFields,
      unknownHeaders: mapping.unknownHeaders,
    },
  };
}

/**
 * Compare incoming rows against all previously imported rows.
 * - alreadyImported: exact dedup-key matches (same file re-imported / overlap).
 * - potentialConflicts: same problem+timestamp but differing chess values
 *   (kept separate — never auto-overwritten).
 */
export function buildDuplicateReport(
  existingRows: ChessTempoAttempt[],
  incomingRows: ChessTempoAttempt[],
): DuplicateReport {
  const byKey = new Map<string, ChessTempoAttempt[]>();
  for (const r of existingRows) {
    const k = rowDedupKey(r);
    const list = byKey.get(k) ?? [];
    list.push(r);
    byKey.set(k, list);
  }
  const duplicateRowIds: string[] = [];
  const newRowIds: string[] = [];
  const conflictRowIds: string[] = [];

  for (const inc of incomingRows) {
    const k = rowDedupKey(inc);
    const prev = byKey.get(k);
    if (prev && prev.length > 0) {
      duplicateRowIds.push(inc.rowId);
      continue;
    }
    // Same problem + timestamp but different result/time → potential conflict.
    const sameAnchor = existingRows.filter(
      (e) => e.problemId !== null && e.problemId === inc.problemId && e.attemptedAt !== null && e.attemptedAt === inc.attemptedAt,
    );
    if (sameAnchor.length > 0) conflictRowIds.push(inc.rowId);
    else newRowIds.push(inc.rowId);
  }

  return {
    alreadyImported: duplicateRowIds.length,
    newRecords: newRowIds.length,
    potentialConflicts: conflictRowIds.length,
    duplicateRowIds,
    newRowIds,
    conflictRowIds,
  };
}
