import { describe, expect, it } from 'vitest';
import {
  buildDuplicateReport,
  fingerprintText,
  mapHeaders,
  parseChessTempoCsv,
  rowDedupKey,
} from '../src/importer/chesstempoImporter.js';
import { parseCsvText } from '../src/importer/csvParse.js';

const VALID_CSV = [
  'Problem ID,Date,Problem Rating,Player Rating,Result,Time Used (s),Moves,Rating Change',
  '81496,2026-09-20 13:02:44,1200,1000,Win,43,12,+16',
  '99213,2026-09-20 13:16:05,1250,1016,Loss,102,18,-11',
].join('\n');

describe('csv parser', () => {
  it('parses quoted cells with commas and escaped quotes', () => {
    const p = parseCsvText('a,b\n"win, ""brilliant""",2');
    expect(p.headers).toEqual(['a', 'b']);
    expect(p.rows[0]).toEqual(['win, "brilliant"', '2']);
  });

  it('rejects empty files', () => {
    expect(() => parseCsvText('   \n ')).toThrow();
  });

  it('rejects unterminated quotes', () => {
    expect(() => parseCsvText('a\n"oops')).toThrow();
  });
});

describe('chesstempo importer', () => {
  it('parses a valid CSV with recognized fields', () => {
    const { import: imp, rows, mapping } = parseChessTempoCsv(VALID_CSV, 'history.csv', 1_000_000);
    expect(imp.totalRows).toBe(2);
    expect(imp.validRows).toBe(2);
    expect(imp.partialRows).toBe(0);
    expect(imp.invalidRows).toBe(0);
    expect(mapping.recognizedFields).toContain('Problem ID');
    expect(mapping.recognizedFields).toContain('Attempt time');
    expect(rows[0]?.problemId).toBe('81496');
    expect(rows[0]?.problemRating).toBe(1200);
    expect(rows[0]?.playerRatingBefore).toBe(1000);
    expect(rows[0]?.result).toBe('Win');
    expect(rows[0]?.timeUsedSeconds).toBe(43);
    expect(rows[0]?.movesUsed).toBe(12);
    expect(rows[0]?.ratingChange).toBe(16);
    expect(rows[0]?.attemptedAt).toBe(new Date(Date.parse('2026-09-20 13:02:44')).toISOString());
    expect(rows[0]?.validity).toBe('valid');
    expect(rows[0]?.sourceRow).toBe(1);
    expect(rows[0]?.raw['Problem ID']).toBe('81496');
  });

  it('reports missing optional columns and unknown headers', () => {
    const { mapping, import: imp } = parseChessTempoCsv('Problem ID,Some Weird Column\n81496,x', 'h.csv');
    expect(mapping.missingFields).toContain('Average moves');
    expect(mapping.unknownHeaders).toEqual(['Some Weird Column']);
    expect(imp.totalRows).toBe(1);
  });

  it('classifies partial and invalid rows without dropping them', () => {
    const csv = ['Problem ID,Date', '81496,', ',2026-09-20 13:02:44', ','].join('\n');
    const { import: imp, rows } = parseChessTempoCsv(csv, 'h.csv');
    expect(imp.validRows).toBe(0);
    expect(imp.partialRows).toBe(2);
    expect(imp.invalidRows).toBe(1);
    expect(rows).toHaveLength(3); // nothing silently dropped
    expect(rows[2]?.validityNotes.length).toBeGreaterThan(0);
  });

  it('keeps malformed rows with notes (bad column count)', () => {
    const { rows } = parseChessTempoCsv('Problem ID,Date\n81496,2026-09-20,EXTRA', 'h.csv');
    expect(rows[0]?.validityNotes.some((n) => n.includes('Column count'))).toBe(true);
  });

  it('mapHeaders does not hard-code one true layout', () => {
    const m = mapHeaders(['puzzle_id', 'played_on', 'puzzle_rating', 'outcome']);
    expect(m.mapped['problemId']).toBe(0);
    expect(m.mapped['attemptedAt']).toBe(1);
    expect(m.mapped['problemRating']).toBe(2);
    expect(m.mapped['result']).toBe(3);
  });

  it('fingerprints are stable and content-sensitive', () => {
    expect(fingerprintText(VALID_CSV)).toBe(fingerprintText(VALID_CSV + '\n'));
    expect(fingerprintText(VALID_CSV)).not.toBe(fingerprintText(VALID_CSV + 'x'));
  });

  it('duplicate report flags re-imports and overlaps', () => {
    const a = parseChessTempoCsv(VALID_CSV, 'history.csv');
    const b = parseChessTempoCsv(VALID_CSV, 'history.csv');
    const dup = buildDuplicateReport(a.rows, b.rows);
    expect(dup.alreadyImported).toBe(2);
    expect(dup.newRecords).toBe(0);

    const overlap = parseChessTempoCsv(VALID_CSV + '\n777,2026-09-21 10:00:00,1300,1016,Win,50,10,+14', 'history2.csv');
    const dup2 = buildDuplicateReport(a.rows, overlap.rows);
    expect(dup2.alreadyImported).toBe(2);
    expect(dup2.newRecords).toBe(1);
  });

  it('same problem+timestamp with different values is a potential conflict, not a duplicate', () => {
    const a = parseChessTempoCsv(VALID_CSV, 'h1.csv');
    // Same problem + timestamp but different time-used: dedup keys differ,
    // anchor matches -> potential conflict (researcher decides, never auto).
    const changed = VALID_CSV.replace('Win,43,12', 'Win,44,12');
    const b = parseChessTempoCsv(changed, 'h2.csv');
    const dup = buildDuplicateReport(a.rows, b.rows);
    expect(dup.potentialConflicts).toBe(1);
    expect(rowDedupKey(a.rows[0] as (typeof a.rows)[number])).not.toBe(
      rowDedupKey(b.rows[0] as (typeof b.rows)[number]),
    );
  });
});
