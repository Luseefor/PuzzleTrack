import { describe, expect, it } from 'vitest';
import {
  parseMoves,
  parseProblemId,
  parseRating,
  parseRatingChange,
  parseRatingWithChange,
  parseResult,
  parseStepCounter,
  parseTimeUsed,
} from '../src/integrations/chessTempo/chessTempoParser.js';
import { FIELD_SELECTORS } from '../src/integrations/chessTempo/chessTempoSelectors.js';

describe('chessTempoParser: problem id', () => {
  it('accepts documented forms', () => {
    expect(parseProblemId('Problem #81496')).toBe('81496');
    expect(parseProblemId('#81496')).toBe('81496');
    expect(parseProblemId('81496')).toBe('81496');
    expect(parseProblemId('  Problem #92142  ')).toBe('92142');
  });
  it('rejects non-ids without guessing', () => {
    expect(parseProblemId('')).toBeNull();
    expect(parseProblemId('no numbers here')).toBeNull();
    expect(parseProblemId('Rating 1700')).toBeNull();
    expect(parseProblemId('#')).toBeNull();
  });
});

describe('chessTempoParser: ratings', () => {
  it('parses plausible ratings', () => {
    expect(parseRating('702')).toBe(702);
    expect(parseRating('Rating: 1,507')).toBe(1507);
  });
  it('rejects implausible values', () => {
    expect(parseRating('???')).toBeNull();
    expect(parseRating('99')).toBeNull();
    expect(parseRating('99999')).toBeNull();
  });
  it('parses rating change', () => {
    expect(parseRatingChange('+16')).toBe(16);
    expect(parseRatingChange('-11')).toBe(-11);
    expect(parseRatingChange('+6 pts')).toBe(6);
    expect(parseRatingChange('n/a')).toBeNull();
  });
});

describe('chessTempoParser: result', () => {
  it('maps confident result text', () => {
    expect(parseResult('Correct!')).toBe('correct');
    expect(parseResult('Incorrect')).toBe('incorrect');
    expect(parseResult('Puzzle failed')).toBe('incorrect');
    expect(parseResult('Puzzle completed')).toBe('completed');
  });
  it('returns null when interpretation is not confident', () => {
    expect(parseResult('')).toBeNull();
    expect(parseResult('Nice try, keep going')).toBeNull();
    expect(parseResult('Loading…')).toBeNull();
  });
});

describe('chessTempoParser: visible step counter', () => {
  it('parses explicit step and move counters', () => {
    expect(parseStepCounter('Step 2 of 5')).toEqual({ stepNumber: 2, stepTotal: 5 });
    expect(parseStepCounter('Move 3 / 7')).toEqual({ stepNumber: 3, stepTotal: 7 });
    expect(parseStepCounter('Step 4')).toEqual({ stepNumber: 4, stepTotal: null });
    expect(parseStepCounter('2/5')).toEqual({ stepNumber: 2, stepTotal: 5 });
  });
  it('rejects ambiguous, out-of-range and non-counter text', () => {
    expect(parseStepCounter('1. Kc1 c2')).toBeNull();
    expect(parseStepCounter('6 of 4')).toBeNull();
    expect(parseStepCounter('')).toBeNull();
  });
});

describe('chessTempoParser: time and moves', () => {
  it('parses time-used forms', () => {
    expect(parseTimeUsed('13 s')).toBe(13);
    expect(parseTimeUsed('43s')).toBe(43);
    expect(parseTimeUsed('0:13')).toBe(13);
    expect(parseTimeUsed('1:02')).toBe(62);
    expect(parseTimeUsed('90')).toBe(90);
    expect(parseTimeUsed('soon')).toBeNull();
  });
  it('parses moves', () => {
    expect(parseMoves('5 moves')).toBe(5);
    expect(parseMoves('7')).toBe(7);
    expect(parseMoves('many')).toBeNull();
  });

  it('does not use the generic result output as a move-count source', () => {
    const moveSelectors = FIELD_SELECTORS.find((field) => field.role === 'moves')?.candidates ?? [];
    expect(moveSelectors).not.toContain('.ct-problem-result-output');
  });
});

describe('chessTempoParser: rating with change (calibration formats)', () => {
  it('splits current rating from signed change, decimals preserved', () => {
    expect(parseRatingWithChange('1506.9 +6.9')).toEqual({ rating: 1506.9, change: 6.9 });
    expect(parseRatingWithChange('702.17 -0.08')).toEqual({ rating: 702.17, change: -0.08 });
    expect(parseRatingWithChange('1507 (+6)')).toEqual({ rating: 1507, change: 6 });
  });
  it('lone rating yields no change; unsigned seconds never become changes', () => {
    expect(parseRatingWithChange('1507')).toEqual({ rating: 1507, change: null });
    expect(parseRatingWithChange('1506.9')).toEqual({ rating: 1506.9, change: null });
    expect(parseRatingWithChange('1507 6')).toEqual({ rating: 1507, change: null });
    expect(parseRatingWithChange('no numbers')).toEqual({ rating: null, change: null });
  });
  it('decimal ratings parse in the single-value parser', () => {
    expect(parseRating('1506.9')).toBe(1506.9);
    expect(parseRating('702.17')).toBe(702.17);
    expect(parseRatingChange('+6.9')).toBe(6.9);
    expect(parseRatingChange('-0.08')).toBe(-0.08);
  });
});

describe('chessTempoParser: calibration time/move formats', () => {
  it('clock times with leading zeros', () => {
    expect(parseTimeUsed('00:13')).toBe(13);
    expect(parseTimeUsed('1:04')).toBe(64);
    expect(parseTimeUsed('12:35')).toBe(755);
  });
  it('annotated move counts', () => {
    expect(parseMoves('Moves: 3 (Perfect!)')).toBe(3);
    expect(parseMoves('3')).toBe(3);
  });
});
