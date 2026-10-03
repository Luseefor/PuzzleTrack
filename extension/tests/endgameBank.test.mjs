import { describe, it, expect } from 'vitest';
import { dailyPool } from '../../scripts/endgame-bank.mjs';
import {readFileSync} from 'node:fs';
const rows=JSON.parse(readFileSync('extension/assets/pilot-pool.json')).puzzles;
const bank={source:{selection:'synthetic'},puzzles:rows.slice(0,8)};
describe('daily bank selection',()=>{
 it('replays selected IDs for one date, varies by date and excludes all issued IDs',()=>{
  const a=dailyPool(bank,'2026-10-02',[],3),b=dailyPool(bank,'2026-10-02',[],3);
  expect(a.puzzles).toEqual(b.puzzles);
  const next=dailyPool(bank,'2026-10-03',[a],3);
  expect(next.puzzles.some(p=>a.puzzles.some(q=>q.PuzzleId===p.PuzzleId))).toBe(false);
  expect(next.source.bank_sha256).toBe(a.source.bank_sha256);
  expect(next.source.excluded_ids_sha256).not.toBe(a.source.excluded_ids_sha256);
  expect(()=>dailyPool(bank,'2026-10-04',[a,next],3)).toThrow('unused');
 });
 it('excludes a repeated board position even when its puzzle ID or move counters differ',()=>{
  const first=dailyPool(bank,'2026-10-02',[],1),row=first.puzzles[0];
  const copy={...row,PuzzleId:'another-id',FEN:row.FEN.split(' ').slice(0,4).join(' ')+' 0 90'};
  const next=dailyPool({...bank,puzzles:[copy,...bank.puzzles]},'2026-10-03',[first],3);
  expect(next.puzzles.some(p=>p.PuzzleId===copy.PuzzleId)).toBe(false);
 });
});
