/**
 * DOM observation layer (v0.3). The ONLY code that touches document occasionally:
 * - reads element text through the centralized selector candidates,
 * - parses with the pure string parsers (never guesses),
 * - reports field presence for diagnostics (never DOM fragments, never page text).
 *
 * Must NOT: modify game state, click, navigate, inject scripts, read unrelated
 * tabs, or transmit anything over the network. Emission goes to the adapter,
 * which forwards semantic events to the background worker.
 */
import {
  FIELD_SELECTORS,
  PROBLEM_ID_ATTRIBUTE,
  RESULT_MARKERS,
  TRAINING_MARKERS,
} from './chessTempoSelectors.js';
import {
  parseMoves,
  parseProblemId,
  parseRating,
  parseRatingChange,
  parseRatingWithChange,
  parseResult,
  parseStepCounter,
  parseTimeUsed,
} from './chessTempoParser.js';
import type { PageReading } from './chessTempoTypes.js';

function isVisible(el: Element): boolean {
  if (el.closest('[hidden], [aria-hidden="true"]')) return false;
  const style = getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && el.getClientRects().length > 0;
}

function firstText(candidates: string[], preferAriaLabel = false): string | null {
  for (const sel of candidates) {
    let el: Element | null = null;
    try {
      el = [...document.querySelectorAll(sel)].find(isVisible) ?? null;
    } catch {
      continue; // malformed candidate: skip, never crash observation
    }
    if (el) {
      // The combined header contains linked puzzle/replacement IDs. Only its
      // direct text nodes carry the displayed rating; never parse an ID as rating.
      const text = el.matches('.ct-problem-info-collapsible .ct-collapsible-header-content')
        ? [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(' ')
        : preferAriaLabel ? el.getAttribute('aria-label') ?? el.textContent : el.textContent;
      if ((text ?? '').trim() !== '') return text;
    }
  }
  return null;
}

function hasMarker(selectors: string[]): boolean {
  return selectors.some((sel) => {
    try {
      return [...document.querySelectorAll(sel)].some(isVisible);
    } catch {
      return false;
    }
  });
}

function readField(role: string, found: string[], missing: string[], parse: (text: string) => string | number | null): string | number | null {
  const entry = FIELD_SELECTORS.find((f) => f.role === role);
  if (!entry) {
    missing.push(role);
    return null;
  }
  const text = firstText(entry.candidates, role === 'result');
  if (text === null) {
    missing.push(role);
    return null;
  }
  const value = parse(text);
  if (value === null) {
    missing.push(`${role} (unparseable)`);
    return null;
  }
  found.push(role);
  return value;
}

/** One-shot semantic snapshot of the page. Pure extraction, no side effects. */
export function readTrainingPage(): PageReading {
  const found: string[] = [];
  const missing: string[] = [];
  if (!hasMarker(TRAINING_MARKERS)) {
    return {
      trainingPage: false,
      problemId: null,
      problemRating: null,
      difficultyLabel: null,
      mode: null,
      displayedRating: null,
      result: null,
      timeUsedSeconds: null,
      movesUsed: null,
      stepNumber: null,
      stepTotal: null,
      playerRatingAfter: null,
      ratingChange: null,
      foundFields: found,
      missingFields: ['training-page'],
    };
  }
  found.push('training-page');

  // Problem identity prefers the explicit attribute, then visible DOM text.
  let problemId: string | null = null;
  const attrEl = [...document.querySelectorAll(`[${PROBLEM_ID_ATTRIBUTE}]`)].find(isVisible);
  const attrValue = attrEl?.getAttribute(PROBLEM_ID_ATTRIBUTE);
  if (attrValue) problemId = parseProblemId(attrValue);
  if (problemId !== null) {
    found.push('problem-id');
  } else {
    const parsed = readField('problem-id', found, missing, parseProblemId);
    problemId = typeof parsed === 'string' ? parsed : null;
  }

  const problemRatingRaw = readField('problem-rating', found, missing, parseRating);
  const difficultyRaw = readField('difficulty', found, missing, (t) => {
    const v = t.trim();
    return v === '' || v.length > 64 ? null : v;
  });
  let stepNumber: number | null = null;
  let stepTotal: number | null = null;
  const stepRole = FIELD_SELECTORS.find((f) => f.role === 'step-counter');
  const stepText = stepRole ? firstText(stepRole.candidates) : null;
  if (stepText === null) {
    missing.push('step-counter');
  } else {
    const parsed = parseStepCounter(stepText);
    if (!parsed) missing.push('step-counter (unparseable)');
    else {
      stepNumber = parsed.stepNumber;
      stepTotal = parsed.stepTotal;
      found.push('step-counter');
    }
  }
  const modeRaw = readField('mode', found, missing, (t) => {
    const v = t.trim();
    return v === '' || v.length > 64 ? null : v;
  });
  // Player rating display, possibly combined like "1506.9 +6.9": split current
  // rating from change so the delta is never mistaken for the rating. The
  // change half is used only in result context; here only the rating is kept.
  let displayedRating: number | null = null;
  {
    const entry = FIELD_SELECTORS.find((f) => f.role === 'player-rating');
    const text = entry ? firstText(entry.candidates) : null;
    if (text === null) {
      missing.push('player-rating');
    } else {
      const split = parseRatingWithChange(text);
      if (split.rating === null) missing.push('player-rating (unparseable)');
      else {
        found.push('player-rating');
        displayedRating = split.rating;
      }
    }
  }

  // Result state only counts when a result marker is visibly present.
  let result: PageReading['result'] = null;
  let timeUsedSeconds: number | null = null;
  let movesUsed: number | null = null;
  let playerRatingAfter: number | null = null;
  let ratingChange: number | null = null;
  if (hasMarker(RESULT_MARKERS)) {
    const parsed = readField('result', found, missing, parseResult);
    // A visible terminal marker with unfamiliar vocabulary still ends the
    // solving run; preserve an unknown outcome and require review.
    result = (parsed as PageReading['result']) ?? 'unknown';
    if (result !== null) {
      found.push('result-visible');
      const tu = readField('time-used', found, missing, parseTimeUsed);
      timeUsedSeconds = typeof tu === 'number' ? tu : null;
      const mv = readField('moves', found, missing, parseMoves);
      movesUsed = typeof mv === 'number' ? mv : null;
      const resultText = firstText(['.ct-problem-result-output']);
      // Result text may contain move numbers. Accept rating only from an
      // explicit rating field, not arbitrary result prose.
      const combinedRating = resultText !== null && /^\s*\d{3,4}(?:\.\d+)?\s+[+-]\d/.test(resultText) ? parseRatingWithChange(resultText) : { rating: null, change: null };
      const ra = combinedRating.rating ?? readField('rating-after', found, missing, (t) => parseRatingWithChange(t).rating);
      playerRatingAfter = typeof ra === 'number' ? ra : null;
      const rc = combinedRating.change ?? readField('rating-change', found, missing, parseRatingChange);
      ratingChange = typeof rc === 'number' ? rc : null;
    } else {
      missing.push('result (unparseable)');
    }
  }

  return {
    trainingPage: true,
    problemId,
    problemRating: typeof problemRatingRaw === 'number' ? problemRatingRaw : null,
    difficultyLabel: typeof difficultyRaw === 'string' ? difficultyRaw : null,
    mode: typeof modeRaw === 'string' ? modeRaw : null,
    displayedRating,
    result,
    timeUsedSeconds,
    movesUsed,
    stepNumber,
    stepTotal,
    playerRatingAfter,
    ratingChange,
    foundFields: found,
    missingFields: missing,
  };
}

/**
 * Batched DOM observation. MutationObserver with childList+subtree+characterData
 * notifies on change only — never polls. The callback receives no DOM content,
 * just a change signal; the adapter re-reads semantically.
 */
export function observeTrainingPage(onChange: () => void): () => void {
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      onChange();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-label', 'aria-hidden', 'data-pt-problem-id'] });
  return () => observer.disconnect();
}
