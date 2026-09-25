/**
 * Minimal RFC-4180 CSV parser (pure, no dependencies).
 * Handles quoted cells, escaped quotes (""), commas/newlines inside quotes,
 * and CRLF/LF line endings. Returns headers + data rows with source line info.
 * Throws on empty input; never silently drops content.
 */

export interface ParsedCsv {
  headers: string[];
  /** Data rows (header excluded). Each row: raw cell strings. */
  rows: string[][];
}

export function parseCsvText(text: string): ParsedCsv {
  // Strip BOM; reject empty files explicitly (caller reports "empty file").
  const src = text.replace(/^\uFEFF/, '');
  if (src.trim().length === 0) throw new Error('File is empty: no headers or rows found.');

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let i = 0;
  const pushCell = (): void => {
    row.push(cell);
    cell = '';
  };
  const pushRow = (): void => {
    // Skip fully-blank lines (e.g. trailing newline) but keep partial rows.
    if (!(row.length === 1 && (row[0] as string).trim() === '')) rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        cell += ch;
        i += 1;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i += 1;
      } else if (ch === ',') {
        pushCell();
        i += 1;
      } else if (ch === '\r') {
        pushCell();
        pushRow();
        i += src[i + 1] === '\n' ? 2 : 1;
      } else if (ch === '\n') {
        pushCell();
        pushRow();
        i += 1;
      } else {
        cell += ch;
        i += 1;
      }
    }
  }
  if (inQuotes) throw new Error('Malformed CSV: unterminated quoted cell.');
  pushCell();
  pushRow();

  if (rows.length === 0) throw new Error('File is empty: no headers or rows found.');
  const headers = (rows[0] as string[]).map((h) => h.trim());
  if (headers.every((h) => h === '')) throw new Error('CSV header row is empty.');
  return { headers, rows: rows.slice(1) };
}
