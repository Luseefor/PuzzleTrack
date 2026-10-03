import { describe, expect, it } from 'vitest';
import {
  ChessTempoAdapter,
  initialMachine,
  stepMachine,
  type AdapterMachine,
} from '../src/integrations/chessTempo/chessTempoAdapter.js';
import type { PageReading, SiteEvent } from '../src/integrations/chessTempo/chessTempoTypes.js';

const T0 = 1_000_000;

function reading(partial: Partial<PageReading> = {}): PageReading {
  return {
    trainingPage: true,
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
    foundFields: [],
    missingFields: [],
    ...partial,
  };
}

function feed(id: string | null, times: number, start = T0, step = 100): { events: SiteEvent[]; last: ReturnType<typeof stepMachine> } {
  let m = initialMachine();
  const events: SiteEvent[] = [];
  for (let i = 0; i < times; i++) {
    const out = stepMachine(m, reading({ problemId: id }), start + i * step);
    m = out.machine;
    events.push(...out.events);
  }
  return { events, last: stepMachine(m, reading({ problemId: id }), start + times * step) };
}

describe('adapter state machine', () => {
  it('stable new problem emits problem_loaded exactly once', () => {
    const { events } = feed('81496', 5);
    const loaded = events.filter((e) => e.kind === 'problem_loaded');
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.problem?.problemId).toBe('81496');
  });

  it('does not start a new attempt when attaching to an already completed page', () => {
    let machine = initialMachine();
    const events: SiteEvent[] = [];
    for (let i = 0; i < 4; i++) {
      const out = stepMachine(
        machine,
        reading({ problemId: '81357', result: 'correct', timeUsedSeconds: 13 }),
        T0 + i * 100,
      );
      machine = out.machine;
      events.push(...out.events);
    }
    expect(machine.state).toBe('RESULT_DETECTED');
    expect(events.filter((event) => event.kind === 'problem_loaded')).toHaveLength(0);
    expect(events.filter((event) => event.kind === 'problem_completed')).toHaveLength(1);
  });

  it('single sighting does not emit (stability required)', () => {
    const out = stepMachine(initialMachine(), reading({ problemId: '81496' }), T0);
    expect(out.events).toHaveLength(0);
    expect(out.machine.state).toBe('NO_PROBLEM');
  });

  it('rerenders of the same problem never re-emit', () => {
    const { events } = feed('81496', 12);
    expect(events.filter((e) => e.kind === 'problem_loaded')).toHaveLength(1);
  });

  it('result reported exactly once; duplicate result DOM ignored', () => {
    let m = initialMachine();
    const events: SiteEvent[] = [];
    const run = (r: PageReading, t: number): void => {
      const out = stepMachine(m, r, t);
      m = out.machine;
      events.push(...out.events);
    };
    for (let i = 0; i < 3; i++) run(reading({ problemId: '81496' }), T0 + i * 100);
    m = { ...m, state: 'ATTEMPT_ACTIVE' };
    for (let i = 0; i < 4; i++) {
      run(reading({ problemId: '81496', result: 'correct', timeUsedSeconds: 13 }), T0 + 1000 + i * 100);
    }
    const completed = events.filter((e) => e.kind === 'problem_completed');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.result?.result).toBe('correct');
    expect(m.state).toBe('RESULT_DETECTED');
  });

  it('rapid next problem transitions via the fast path', () => {
    let m = initialMachine();
    const events: SiteEvent[] = [];
    const run = (r: PageReading, t: number): void => {
      const out = stepMachine(m, r, t);
      m = out.machine;
      events.push(...out.events);
    };
    for (let i = 0; i < 3; i++) run(reading({ problemId: '81496' }), T0 + i * 100);
    m = { ...m, state: 'ATTEMPT_ACTIVE' };
    run(reading({ problemId: '81496', result: 'correct' }), T0 + 1000);
    for (let i = 0; i < 3; i++) run(reading({ problemId: '92142' }), T0 + 1100 + i * 100);
    const loaded = events.filter((e) => e.kind === 'problem_loaded');
    expect(loaded.map((e) => e.problem?.problemId)).toEqual(['81496', '92142']);
  });

  it('same problem after cleared result waits; new id then loads', () => {
    let m = initialMachine();
    const events: SiteEvent[] = [];
    const run = (r: PageReading, t: number): void => {
      const out = stepMachine(m, r, t);
      m = out.machine;
      events.push(...out.events);
    };
    for (let i = 0; i < 3; i++) run(reading({ problemId: '81496' }), T0 + i * 100);
    m = { ...m, state: 'ATTEMPT_ACTIVE' };
    run(reading({ problemId: '81496', result: 'correct' }), T0 + 1000);
    run(reading({ problemId: '81496' }), T0 + 1100);
    expect(m.state).toBe('WAITING_FOR_NEXT');
    for (let i = 0; i < 3; i++) run(reading({ problemId: '92142' }), T0 + 1200 + i * 100);
    expect(m.state).toBe('PROBLEM_READY');
    expect(events.filter((e) => e.kind === 'problem_loaded')).toHaveLength(2);
  });

  it('different stable id mid-attempt emits one problem_changed', () => {
    let m: AdapterMachine = { ...initialMachine(), state: 'ATTEMPT_ACTIVE', currentId: '81496' };
    const events: SiteEvent[] = [];
    for (let i = 0; i < 6; i++) {
      const out = stepMachine(m, reading({ problemId: '99999' }), T0 + i * 100);
      m = out.machine;
      events.push(...out.events);
    }
    expect(events.filter((e) => e.kind === 'problem_changed')).toHaveLength(1);
    expect(m.state).toBe('ATTEMPT_ACTIVE');
  });

  it('records durations only from explicit step-counter advances', () => {
    let m: AdapterMachine = {
      ...initialMachine(), state: 'ATTEMPT_ACTIVE', currentId: '81496',
      activeStepNumber: 1, activeStepStartedAtMs: T0,
    };
    let out = stepMachine(m, reading({ problemId: '81496', stepNumber: 2, stepTotal: 2 }), T0 + 5000);
    m = out.machine;
    expect(out.events.filter((e) => e.kind === 'step_completed')).toEqual([
      expect.objectContaining({ problemId: '81496', stepNumber: 1, durationMs: 5000 }),
    ]);
    out = stepMachine(m, reading({ problemId: '81496', stepNumber: 2, stepTotal: 2, result: 'correct' }), T0 + 7000);
    expect(out.events.filter((e) => e.kind === 'step_completed')).toEqual([
      expect.objectContaining({ problemId: '81496', stepNumber: 2, durationMs: 2000 }),
    ]);
    expect(out.events.some((e) => e.kind === 'problem_completed')).toBe(true);
  });

  it('marks missed step transitions as unmeasured rather than allocating combined time', () => {
    const m: AdapterMachine = {
      ...initialMachine(), state: 'ATTEMPT_ACTIVE', currentId: '81496',
      activeStepNumber: 1, activeStepStartedAtMs: T0,
    };
    const out = stepMachine(m, reading({ problemId: '81496', stepNumber: 3 }), T0 + 8000);
    expect(out.events.filter((e) => e.kind === 'step_completed').map((e) => [e.stepNumber, e.durationMs]))
      .toEqual([[1, null], [2, null]]);
  });

  it('lost markers drive ADAPTER_ERROR; recovery re-detects', () => {
    let m = initialMachine();
    for (let i = 0; i < 3; i++) m = stepMachine(m, reading({ problemId: '81496' }), T0 + i * 100).machine;
    expect(m.state).toBe('PROBLEM_READY');
    let out = stepMachine(m, { ...reading(), trainingPage: false }, T0 + 400);
    expect(out.machine.state).toBe('ADAPTER_ERROR');
    expect(out.events[0]?.kind).toBe('adapter_lost');
    out = stepMachine(out.machine, reading({ problemId: '81496' }), T0 + 500);
    expect(out.events[0]?.kind).toBe('adapter_recovered');
  });

  it('repeated misses drop a tracked problem silently', () => {
    let m = initialMachine();
    for (let i = 0; i < 3; i++) m = stepMachine(m, reading({ problemId: '81496' }), T0 + i * 100).machine;
    expect(m.state).toBe('PROBLEM_READY');
    for (let i = 0; i < 6; i++) m = stepMachine(m, reading({ problemId: null }), T0 + 1000 + i * 100).machine;
    expect(m.state).toBe('NO_PROBLEM');
  });
});

describe('adapter class notifications', () => {
  function harness() {
    let current = reading({ problemId: '81496' });
    const events: SiteEvent[] = [];
    const adapter = new ChessTempoAdapter({
      readPage: () => current,
      observe: (cb) => {
        void cb;
        return () => undefined;
      },
      now: () => T0,
    });
    adapter.subscribe((e) => events.push(e));
    return {
      adapter,
      events,
      setReading: (r: PageReading) => {
        current = r;
      },
    };
  }

  it('attempt notifications gate READY/ACTIVE transitions', () => {
    const { adapter, events, setReading } = harness();
    expect(adapter.start()).toBe(true);
    adapter.tick();
    adapter.tick();
    adapter.tick();
    expect(events.filter((e) => e.kind === 'problem_loaded')).toHaveLength(1);
    adapter.notifyAttemptStarted('81496');
    expect(adapter.getDiagnostics().state).toBe('ATTEMPT_ACTIVE');
    // Duplicate start notification is harmless.
    adapter.notifyAttemptStarted('81496');
    setReading(reading({ problemId: '81496', result: 'correct', timeUsedSeconds: 13 }));
    adapter.tick();
    expect(events.filter((e) => e.kind === 'problem_completed')).toHaveLength(1);
    adapter.notifyAttemptEnded('81496');
    expect(adapter.getDiagnostics().state).toBe('RESULT_DETECTED');
    adapter.dispose();
  });

  it('start() refuses non-training pages', () => {
    const events: SiteEvent[] = [];
    const adapter = new ChessTempoAdapter({
      readPage: () => reading({ trainingPage: false }),
      observe: () => () => undefined,
      now: () => T0,
    });
    adapter.subscribe((e) => events.push(e));
    expect(adapter.start()).toBe(false);
    expect(events).toHaveLength(0);
    adapter.dispose();
  });
});
