/**
 * Dataset viewer + ChessTempo import/matching workstation (v0.2).
 * Local only. Import flow: select file -> preview (no writes) -> Continue to
 * Matching (register + auto-apply exact/high only) -> manual review of the
 * rest. Ambiguous matches are never guessed; conflicts never overwritten.
 */
import { Repository } from '../storage/repository.js';
import { ChromeStorageAdapter } from '../storage/chromeAdapter.js';
import { deleteSession, setPilotReview } from '../session/sessionManager.js';
import { attemptsToCsv, downloadFilename } from '../export/csv.js';
import { backupFilename, buildBackup, parseBackup, serializeBackup } from '../export/jsonBackup.js';
import { formatDurationMs } from '../utils/time.js';
import { validateStore, type ValidationIssue } from '../validation/pilotValidator.js';
import { parseChessTempoCsv, buildDuplicateReport, type ImportParseResult } from '../importer/chesstempoImporter.js';
import { assignMatches, isAutoAppliable, scoreAttempt, toMatchable } from '../matching/matcher.js';
import { allImportedRows, applyMatch, registerImport, type ConflictResolution } from '../matching/applyMatch.js';
import { awayTimePercentage, relativeDifficulty, timerDifferenceSeconds } from '../analysis/derived.js';
import type { Attempt, PuzzleTrackStore } from '../models/types.js';
import type { ChessTempoAttempt, MatchConflict, MatchResult } from '../models/chesstempo.js';

const repo = new Repository(new ChromeStorageAdapter());

const COLUMNS: string[] = [
  'Participant', 'Session', 'Attempt', 'Started', 'Elapsed', 'Limit', 'Result', 'Timed Out',
  'Problem ID', 'Problem rating', 'Player rating', 'CT result', 'CT time', 'Moves', 'Rating change',
  'Rel. difficulty', 'Timer diff', 'Focus losses', 'Away time', 'Away %', 'Integrity flag',
];

const $ = (id: string): HTMLElement => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
};

function short(id: string): string {
  return id.slice(0, 8);
}

function download(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fmtNum(v: number | null, signed = false): string {
  if (v === null) return '';
  if (!Number.isFinite(v)) return '';
  const r = Math.round(v * 10) / 10;
  return signed && r > 0 ? `+${r}` : String(r);
}

// ---------------- dataset table ----------------

async function renderTable(): Promise<void> {
  const store = await repo.loadStore();
  const attempts = Object.values(store.attempts);
  const participantBySession = new Map<string, string>();
  for (const s of Object.values(store.sessions)) participantBySession.set(s.session_id, s.participant_id);

  const pSel = $('filter-participant') as HTMLSelectElement;
  const sSel = $('filter-session') as HTMLSelectElement;
  const rSel = $('filter-result') as HTMLSelectElement;
  const mSel = $('filter-matched') as HTMLSelectElement;
  const iSel = $('filter-integrity') as HTMLSelectElement;
  const sortSel = $('sort-by') as HTMLSelectElement;

  const prev = { p: pSel.value, s: sSel.value };
  pSel.innerHTML = '<option value="">All</option>';
  sSel.innerHTML = '<option value="">All</option>';
  const pids = [...new Set(Object.values(store.sessions).map((s) => s.participant_id))].sort();
  for (const p of pids) {
    const o = document.createElement('option');
    o.value = p;
    o.textContent = p;
    pSel.appendChild(o);
  }
  for (const s of Object.values(store.sessions)) {
    const o = document.createElement('option');
    o.value = s.session_id;
    o.textContent = `${s.participant_id} · ${short(s.session_id)} · ${s.status}`;
    sSel.appendChild(o);
  }
  if ([...pSel.options].some((o) => o.value === prev.p)) pSel.value = prev.p;
  if ([...sSel.options].some((o) => o.value === prev.s)) sSel.value = prev.s;

  let rows = attempts.map((a) => ({ participant: participantBySession.get(a.session_id) ?? '(unknown)', attempt: a }));
  if (pSel.value) rows = rows.filter((r) => r.participant === pSel.value);
  if (sSel.value) rows = rows.filter((r) => r.attempt.session_id === sSel.value);
  if (rSel.value) rows = rows.filter((r) => r.attempt.experimental_result === rSel.value);
  if (mSel.value === 'matched') rows = rows.filter((r) => r.attempt.match_confidence !== null);
  if (mSel.value === 'unmatched') rows = rows.filter((r) => r.attempt.match_confidence === null);
  if (iSel.value === 'flagged') rows = rows.filter((r) => r.attempt.integrity_flag);
  if (iSel.value === 'clean') rows = rows.filter((r) => !r.attempt.integrity_flag);
  rows.sort((x, y) =>
    sortSel.value === 'attempt'
      ? x.attempt.attempt_number - y.attempt.attempt_number
      : x.attempt.started_at < y.attempt.started_at ? -1 : 1,
  );

  $('empty').hidden = rows.length > 0;
  const head = $('head-row');
  head.innerHTML = '';
  for (const c of COLUMNS) {
    const th = document.createElement('th');
    th.textContent = c;
    head.appendChild(th);
  }
  const body = $('body-rows');
  body.innerHTML = '';
  for (const { participant, attempt: a } of rows) {
    const tr = document.createElement('tr');
    const awayPct = awayTimePercentage(a);
    const cells = [
      participant,
      short(a.session_id),
      String(a.attempt_number),
      new Date(a.started_at).toLocaleString(),
      formatDurationMs(a.elapsed_ms),
      formatDurationMs(a.time_limit_seconds * 1000),
      a.experimental_result ?? '(in progress)',
      a.timed_out ? 'TRUE' : 'FALSE',
      a.problem_id ?? a.manual_problem_id ?? '',
      a.problem_rating === null ? '' : String(a.problem_rating),
      a.player_rating_before === null ? '' : String(a.player_rating_before),
      a.chesstempo_result ?? '',
      a.chesstempo_time_used_seconds === null ? '' : `${a.chesstempo_time_used_seconds}s`,
      a.moves_used === null ? '' : String(a.moves_used),
      a.rating_change === null ? '' : fmtNum(a.rating_change, true),
      fmtNum(relativeDifficulty(a), true),
      (() => { const d = timerDifferenceSeconds(a); return d === null ? '' : `${fmtNum(d)}s`; })(),
      String(a.focus_loss_count),
      formatDurationMs(a.total_time_away_ms),
      awayPct === null ? '' : `${(awayPct * 100).toFixed(1)}%`,
      a.integrity_flag ? 'TRUE' : 'FALSE',
    ];
    for (const v of cells) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

async function renderImports(): Promise<void> {
  const store = await repo.loadStore();
  const body = $('imports-body');
  body.innerHTML = '';
  const imports = Object.values(store.imports).sort((a, b) => (a.importedAt < b.importedAt ? 1 : -1));
  if (imports.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.textContent = 'No imports yet.';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const imp of imports) {
    const tr = document.createElement('tr');
    for (const v of [
      imp.originalFilename,
      new Date(imp.importedAt).toLocaleString(),
      `${imp.totalRows} (${imp.validRows}/${imp.partialRows}/${imp.invalidRows})`,
      `${imp.matchedRows} / ${imp.totalRows}`,
      imp.fileFingerprint,
    ]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

// ---------------- import flow ----------------

let pending: ImportParseResult | null = null;
let pendingConflicts: { attemptId: string; row: ChessTempoAttempt; conflicts: MatchConflict[] }[] = [];

function rowById(store: PuzzleTrackStore, rowId: string): ChessTempoAttempt | null {
  for (const rows of Object.values(store.importRows)) {
    const found = rows.find((r) => r.rowId === rowId);
    if (found) return found;
  }
  return null;
}

function renderPreview(dup: { alreadyImported: number; newRecords: number; potentialConflicts: number }): void {
  if (!pending) return;
  const { import: imp, rows, mapping } = pending;
  const log = $('import-log');
  log.innerHTML = '';
  const lines: [string, string][] = [
    ['File:', imp.originalFilename],
    ['Rows found:', String(imp.totalRows)],
    ['Valid:', String(imp.validRows)],
    ['Partial:', String(imp.partialRows)],
    ['Invalid:', String(imp.invalidRows)],
  ];
  for (const [k, v] of lines) {
    const p = document.createElement('p');
    p.innerHTML = `<strong></strong> `;
    (p.firstChild as HTMLElement).textContent = k;
    p.append(document.createTextNode(v));
    log.appendChild(p);
  }
  const rec = document.createElement('p');
  rec.innerHTML = '<strong>Recognized fields:</strong> ';
  rec.append(
    document.createTextNode(
      mapping.recognizedFields.length > 0 ? mapping.recognizedFields.map((f) => `✓ ${f}`).join(', ') : '(none)',
    ),
  );
  log.appendChild(rec);
  const miss = document.createElement('p');
  miss.innerHTML = '<strong>Unavailable:</strong> ';
  miss.append(document.createTextNode(mapping.missingFields.length > 0 ? mapping.missingFields.map((f) => `— ${f}`).join(', ') : '(none)'));
  log.appendChild(miss);
  if (mapping.unknownHeaders.length > 0) {
    const unk = document.createElement('p');
    unk.innerHTML = '<strong>Unknown columns (ignored, raw kept):</strong> ';
    unk.append(document.createTextNode(mapping.unknownHeaders.join(', ')));
    log.appendChild(unk);
  }
  const dp = document.createElement('p');
  dp.innerHTML = `<strong>Already imported:</strong> ${dup.alreadyImported} &nbsp; <strong>New records:</strong> ${dup.newRecords} &nbsp; <strong>Potential conflicts:</strong> ${dup.potentialConflicts}`;
  log.appendChild(dp);

  const head = $('preview-head');
  head.innerHTML = '';
  for (const h of ['Row', 'Validity', 'Problem', 'Attempted at', 'Rating', 'Result', 'Time used', 'Notes']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const body = $('preview-body');
  body.innerHTML = '';
  for (const r of rows.slice(0, 8)) {
    const tr = document.createElement('tr');
    for (const v of [
      String(r.sourceRow),
      r.validity,
      r.problemId ?? '',
      r.attemptedAt ? new Date(r.attemptedAt).toLocaleString() : '',
      r.problemRating === null ? '' : String(r.problemRating),
      r.result ?? '',
      r.timeUsedSeconds === null ? '' : `${r.timeUsedSeconds}s`,
      r.validityNotes.join(' ') || '—',
    ]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
  if (rows.length > 8) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.textContent = `… and ${rows.length - 8} more rows (full data applied on Continue).`;
    tr.appendChild(td);
    body.appendChild(tr);
  }
  $('import-preview').hidden = false;
  $('import-results').hidden = true;
}

function describeAttempt(a: Attempt): string {
  const s = new Date(a.started_at).toLocaleTimeString();
  const e = a.ended_at ? new Date(a.ended_at).toLocaleTimeString() : '…';
  return `Attempt ${a.attempt_number}: ${s} → ${e} (${formatDurationMs(a.elapsed_ms)})`;
}

async function renderReview(): Promise<void> {
  const store = await repo.loadStore();
  const log = $('match-log');
  log.innerHTML = '';
  const attempts = Object.values(store.attempts)
    .filter((a) => a.ended_at !== null && !store.matches[a.attempt_id])
    .sort((a, b) => (a.started_at < b.started_at ? -1 : 1));
  const rows = allImportedRows(store);
  const results = assignMatches(attempts.map((a) => scoreAttempt(toMatchable(a), rows)));

  const auto = results.filter((r) => r.chessTempoRowId !== null && (r.confidence === 'exact' || r.confidence === 'high') && r.candidates.length <= 1);
  const needsReview = results.filter((r) => !auto.some((x) => x.attemptId === r.attemptId) && r.candidates.length > 0);
  const noCandidate = results.filter((r) => r.candidates.length === 0);

  const p = document.createElement('p');
  p.textContent = `Unmatched finished attempts: ${attempts.length}. Auto-applied this run are shown in the table above; ${needsReview.length} need manual resolution, ${noCandidate.length} have no candidates.`;
  log.appendChild(p);

  const review = $('match-review');
  review.innerHTML = '';
  for (const r of needsReview) {
    const a = store.attempts[r.attemptId];
    if (!a) continue;
    const div = document.createElement('div');
    div.className = 'candidate';
    const title = document.createElement('p');
    title.innerHTML = `<strong></strong> — <span class="pill pill-low">AMBIGUOUS</span>`;
    (title.firstChild as HTMLElement).textContent = describeAttempt(a);
    div.appendChild(title);
    const rs = document.createElement('p');
    rs.textContent = `Status reasons: ${r.reasons.join(' ')}`;
    div.appendChild(rs);
    for (const c of r.candidates) {
      const row = rowById(store, c.rowId);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small';
      btn.textContent = `Match: Problem #${c.problemId ?? '?'} — ${c.attemptedAt ? new Date(c.attemptedAt).toLocaleString() : 'no timestamp'}`;
      btn.addEventListener('click', () => {
        void (async () => {
          if (!row) return;
          await applyManual(a.attempt_id, row, 'manual');
        })();
      });
      const wrap = document.createElement('div');
      wrap.className = 'row';
      wrap.appendChild(btn);
      div.appendChild(wrap);
    }
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.className = 'btn btn-small btn-ghost';
    leave.textContent = 'Leave Unmatched';
    leave.addEventListener('click', () => div.remove());
    div.appendChild(leave);
    review.appendChild(div);
  }

  const cl = $('conflict-list');
  cl.innerHTML = '';
  for (const pc of pendingConflicts) {
    const a = store.attempts[pc.attemptId];
    if (!a) continue;
    const div = document.createElement('div');
    div.className = 'conflict';
    const title = document.createElement('p');
    title.innerHTML = `<strong></strong> — conflicting ChessTempo data (nothing overwritten)`;
    (title.firstChild as HTMLElement).textContent = describeAttempt(a);
    div.appendChild(title);
    for (const c of pc.conflicts) {
      const line = document.createElement('p');
      line.textContent = `${String(c.field)}: existing ${String(c.existingValue)} vs incoming ${String(c.incomingValue)}`;
      div.appendChild(line);
    }
    const rowBtns = document.createElement('div');
    rowBtns.className = 'row';
    const keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'btn btn-small';
    keep.textContent = 'Keep existing';
    keep.addEventListener('click', () => {
      void (async () => {
        await applyManual(pc.attemptId, pc.row, 'manual', 'keepExisting');
      })();
    });
    const useNew = document.createElement('button');
    useNew.type = 'button';
    useNew.className = 'btn btn-small';
    useNew.textContent = 'Use new values';
    useNew.addEventListener('click', () => {
      void (async () => {
        await applyManual(pc.attemptId, pc.row, 'manual', 'useNew');
      })();
    });
    const later = document.createElement('button');
    later.type = 'button';
    later.className = 'btn btn-small btn-ghost';
    later.textContent = 'Leave unresolved';
    later.addEventListener('click', () => {
      pendingConflicts = pendingConflicts.filter((x) => x.attemptId !== pc.attemptId);
      void renderReview();
    });
    rowBtns.append(keep, useNew, later);
    div.appendChild(rowBtns);
    cl.appendChild(div);
  }
}

async function applyManual(
  attemptId: string,
  row: ChessTempoAttempt,
  matchedBy: 'auto' | 'manual',
  resolution?: ConflictResolution,
  precomputed?: MatchResult,
): Promise<void> {
  const store = await repo.loadStore();
  const attempt = store.attempts[attemptId];
  if (!attempt || !row) return;
  const scored = precomputed ?? scoreAttempt(toMatchable(attempt), allImportedRows(store));
  try {
    const res = resolution === undefined
      ? applyMatch(store, {
          attemptId,
          row,
          confidence: scored.confidence === 'unmatched' ? 'low' : scored.confidence,
          reasons: [...scored.reasons, `Manually confirmed by researcher (${matchedBy}).`],
          timeDeltaMs: scored.timeDeltaMs,
          matchedBy,
        })
      : applyMatch(store, {
          attemptId,
          row,
          confidence: scored.confidence === 'unmatched' ? 'low' : scored.confidence,
          reasons: [...scored.reasons, `Manually confirmed by researcher (${matchedBy}).`],
          timeDeltaMs: scored.timeDeltaMs,
          matchedBy,
          resolution,
        });
    if (!res.applied) {
      if (!pendingConflicts.some((x) => x.attemptId === attemptId)) {
        pendingConflicts.push({ attemptId, row, conflicts: res.conflicts });
      }
    } else {
      pendingConflicts = pendingConflicts.filter((x) => x.attemptId !== attemptId);
    }
    // Merge-save: a running UI tick must not drop this match write, and this
    // write must not drop tick-appended focus events.
    await repo.saveMerged(store, Date.now());
  } catch (e) {
    window.alert(e instanceof Error ? e.message : 'Match failed.');
  }
  await renderTable();
  await renderReview();
  await renderImports();
  await renderPilotReview();
}

function wireImport(): void {
  ($('import-file') as HTMLInputElement).addEventListener('change', (e) => {
    void (async () => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        pending = parseChessTempoCsv(text, file.name, Date.now());
        const store = await repo.loadStore();
        const dup = buildDuplicateReport(allImportedRows(store), pending.rows);
        renderPreview(dup);
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Could not parse file.');
        pending = null;
        $('import-preview').hidden = true;
      }
    })();
  });

  $('btn-import-cancel').addEventListener('click', () => {
    pending = null;
    ($('import-file') as HTMLInputElement).value = '';
    $('import-preview').hidden = true;
    $('import-results').hidden = true;
  });

  $('btn-import-continue').addEventListener('click', () => {
    void (async () => {
      if (!pending) return;
      const store = await repo.loadStore();
      // Duplicate protection: skip exact re-imports of the same fingerprint.
      const sameFile = Object.values(store.imports).find((imp) => imp.fileFingerprint === pending?.import.fileFingerprint);
      if (sameFile && !window.confirm(`This file was already imported as "${sameFile.originalFilename}". Import again (only genuinely new rows will be stored)?`)) {
        return;
      }
      const { skippedDuplicates } = registerImport(store, pending.import, pending.rows);
      await repo.saveMerged(store, Date.now());

      // Score every unfinished-business attempt; auto-apply exact/high only.
      const loaded = await repo.loadStore();
      const attempts = Object.values(loaded.attempts).filter((a) => a.ended_at !== null && !loaded.matches[a.attempt_id]);
      const rows = allImportedRows(loaded);
      const results = assignMatches(attempts.map((a) => scoreAttempt(toMatchable(a), rows)));

      let autoCount = 0;
      const fresh = await repo.loadStore();
      for (const r of results) {
        if (!isAutoAppliable(r) || r.chessTempoRowId === null) continue;
        const row = rowById(fresh, r.chessTempoRowId);
        const attempt = fresh.attempts[r.attemptId];
        if (!row || !attempt) continue;
        try {
          const res = applyMatch(fresh, {
            attemptId: r.attemptId,
            row,
            confidence: r.confidence,
            reasons: [...r.reasons, 'Auto-applied (exact/high confidence, single candidate).'],
            timeDeltaMs: r.timeDeltaMs,
            matchedBy: 'auto',
          });
          if (res.applied) autoCount++;
          else if (!pendingConflicts.some((x) => x.attemptId === r.attemptId)) {
            pendingConflicts.push({ attemptId: r.attemptId, row, conflicts: res.conflicts });
          }
        } catch {
          // 1:1 race (row claimed): leave for manual review.
        }
      }
      await repo.saveMerged(fresh, Date.now());

      const log = $('match-log');
      log.innerHTML = '';
      const done = document.createElement('p');
      done.innerHTML = `<strong>Import registered:</strong> ${pending.rows.length} rows parsed, ${skippedDuplicates} already-imported duplicates skipped. ` +
        `<strong>Auto-applied:</strong> ${autoCount} exact/high matches. Ambiguous and conflicting cases need manual resolution below — nothing was guessed.`;
      log.appendChild(done);

      pending = null;
      ($('import-file') as HTMLInputElement).value = '';
      $('import-preview').hidden = true;
      $('import-results').hidden = false;
      await renderTable();
      await renderReview();
      await renderImports();
      await renderPilotReview();
    })();
  });
}

// ---------------- validation (read-only) ----------------

function renderIssues(containerId: string, title: string, issues: ValidationIssue[]): void {
  const container = $(containerId);
  container.innerHTML = '';
  if (issues.length === 0) return;
  const h = document.createElement('h3');
  h.textContent = `${title} (${issues.length})`;
  container.appendChild(h);
  const ul = document.createElement('ul');
  for (const issue of issues) {
    const li = document.createElement('li');
    li.textContent = `[${issue.code}] ${issue.message}`;
    ul.appendChild(li);
  }
  container.appendChild(ul);
}

async function runValidation(): Promise<void> {
  const store = await repo.loadStore();
  const report = validateStore(store);
  const section = $('validation');
  section.hidden = false;
  const summary = $('validation-summary');
  summary.innerHTML = '';
  const s = report.summary;
  const p = document.createElement('p');
  const verdict = document.createElement('strong');
  verdict.textContent = report.valid ? 'VALID — no errors. ' : 'INVALID — errors found, do not treat this dataset as clean. ';
  p.appendChild(verdict);
  p.append(
    document.createTextNode(
      `Sessions: ${s.sessions} Attempts: ${s.attempts} Events: ${s.events} ChessTempo rows: ${s.chessTempoRows} Matched: ${s.matched} Errors: ${s.errors} Warnings: ${s.warnings}`,
    ),
  );
  summary.appendChild(p);
  renderIssues('validation-errors', 'Errors', report.errors);
  renderIssues('validation-warnings', 'Warnings', report.warnings);
  section.scrollIntoView();
}

// ---------------- pilot review (metadata only, raw untouched) ----------------

async function renderPilotReview(): Promise<void> {
  const store = await repo.loadStore();
  const body = $('review-body');
  body.innerHTML = '';
  const attempts = Object.values(store.attempts).sort((a, b) =>
    a.started_at < b.started_at ? -1 : 1,
  );
  if (attempts.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 14;
    td.textContent = 'No attempts recorded yet.';
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const a of attempts) {
    const tr = document.createElement('tr');
    const rel = relativeDifficulty(a);
    const ctTime = a.chesstempo_time_used_seconds === null ? '' : `${a.chesstempo_time_used_seconds}s`;
    const review = store.pilotReview[a.attempt_id];
    for (const v of [
      `#${a.attempt_number} (${a.experimental_result ?? 'in progress'})`,
      a.problem_id ?? a.manual_problem_id ?? '',
      formatDurationMs(a.elapsed_ms),
      ctTime,
      a.problem_rating === null ? '' : String(a.problem_rating),
      a.player_rating_before === null ? '' : String(a.player_rating_before),
      rel === null ? '' : (rel > 0 ? `+${rel}` : String(rel)),
      a.chesstempo_result ?? '',
      a.experimental_result ?? '',
      String(a.focus_loss_count),
      formatDurationMs(a.total_time_away_ms),
      a.match_confidence ?? 'unmatched',
      review?.status ?? 'unreviewed',
    ]) {
      const td = document.createElement('td');
      td.textContent = v;
      tr.appendChild(td);
    }
    const actionTd = document.createElement('td');
    const mkBtn = (label: string, status: 'verified' | 'needs_review'): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-small';
      btn.textContent = label;
      btn.disabled = review?.status === status;
      btn.addEventListener('click', () => {
        void (async () => {
          const note = window.prompt('Optional review note (stored separately from raw data):', review?.note ?? '') ?? review?.note ?? '';
          try {
            const st = await repo.loadStore();
            setPilotReview(st, a.attempt_id, status, note, Date.now());
            await repo.saveMerged(st, Date.now());
            await renderPilotReview();
          } catch (e) {
            window.alert(e instanceof Error ? e.message : 'Could not save review.');
          }
        })();
      });
      return btn;
    };
    actionTd.append(mkBtn('Verified', 'verified'), mkBtn('Needs Review', 'needs_review'));
    tr.appendChild(actionTd);
    body.appendChild(tr);
  }
}

// ---------------- misc actions ----------------

function wireActions(): void {
  for (const id of ['filter-participant', 'filter-session', 'filter-result', 'filter-matched', 'filter-integrity', 'sort-by']) {
    $(id).addEventListener('change', () => void renderTable());
  }
  $('btn-validate').addEventListener('click', () => void runValidation());
  $('btn-export-all').addEventListener('click', () => {
    void (async () => {
      const store = await repo.loadStore();
      const m = new Map<string, string>();
      for (const s of Object.values(store.sessions)) m.set(s.session_id, s.participant_id);
      download(downloadFilename('full-dataset', new Date().toISOString()), attemptsToCsv(m, Object.values(store.attempts)), 'text/csv');
    })();
  });
  $('btn-export-json').addEventListener('click', () => {
    void (async () => {
      const store = await repo.loadStore();
      const backup = buildBackup(store, Date.now());
      download(backupFilename(backup.exportedAt), serializeBackup(backup), 'application/json');
    })();
  });
  $('btn-delete-session').addEventListener('click', () => {
    void (async () => {
      const store = await repo.loadStore();
      const sSel = $('filter-session') as HTMLSelectElement;
      const id = sSel.value || window.prompt('Paste the session_id to delete (test sessions only):') || '';
      if (!id) return;
      if (!window.confirm(`Delete session ${id} and all its attempts/events? This cannot be undone.`)) return;
      try {
        deleteSession(store, id);
        await repo.saveStore(store);
        await renderTable();
      } catch (e) {
        window.alert(e instanceof Error ? e.message : 'Delete failed.');
      }
    })();
  });
  ($('restore-file') as HTMLInputElement).addEventListener('change', (e) => {
    void (async () => {
      const input = e.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const restored = parseBackup(text);
        const count = Object.keys(restored.attempts).length;
        if (!window.confirm(`Restore backup with ${count} attempts? This REPLACES all current data.`)) return;
        if (!window.confirm('Really replace? This cannot be undone. Export current data first if unsure.')) return;
        await repo.saveStore(restored);
        await renderTable();
        await renderImports();
        await renderReview();
        await renderPilotReview();
        window.alert('Backup restored.');
      } catch (err) {
        window.alert(err instanceof Error ? err.message : 'Restore failed.');
      } finally {
        input.value = '';
      }
    })();
  });
}

wireActions();
wireImport();
void renderTable();
void renderImports();
void renderReview();
void renderPilotReview();
if (window.location.hash === '#import') {
  document.getElementById('import')?.scrollIntoView();
}
