import { expect, test } from 'bun:test';
import {
  PUSH_WINDOW_MS,
  TYPING_IDLE_MS,
  TYPING_REFRESH_MS,
  TypingLoop,
  TypingTracker,
  type TypingTimers,
} from '../src/typing.ts';

test('a tool call covering a pushed channel starts typing there, once', () => {
  const t = new TypingTracker();
  t.pushed('c1', 0);
  expect(t.activity(1_000, ['c2'])).toEqual([]); // never pushed
  expect(t.activity(2_000, ['c1'])).toEqual(['c1']);
  expect(t.activity(3_000, ['c1'])).toEqual([]); // already typing
  expect(t.hasActive).toBe(true);
});

test('typing does not start for a push event older than ten minutes', () => {
  const t = new TypingTracker();
  t.pushed('c1', 0);
  expect(t.activity(PUSH_WINDOW_MS - 1, ['c1'])).toEqual(['c1']);
  const late = new TypingTracker();
  late.pushed('c1', 0);
  expect(late.activity(PUSH_WINDOW_MS, ['c1'])).toEqual([]);
});

test('posting in the channel ends typing and the debt; a new push owes again', () => {
  const t = new TypingTracker();
  t.pushed('c1', 0);
  t.activity(1_000, ['c1']);
  t.answered('c1');
  expect(t.hasActive).toBe(false);
  expect(t.activity(2_000, ['c1'])).toEqual([]);
  t.pushed('c1', 3_000);
  expect(t.activity(4_000, ['c1'])).toEqual(['c1']);
});

test('any tool call keeps typing alive; three idle minutes end it', () => {
  const t = new TypingTracker();
  t.pushed('c1', 0);
  t.activity(0, ['c1']);
  t.activity(TYPING_IDLE_MS - 1); // no channel covered, still counts as activity
  expect(t.tick(TYPING_IDLE_MS - 1 + 10_000)).toEqual(['c1']);
  expect(t.tick(TYPING_IDLE_MS - 1 + TYPING_IDLE_MS)).toEqual([]);
  expect(t.hasActive).toBe(false);
});

test('a tool call after the idle limit does not revive the old typing, but re-covering a still-owed channel restarts it', () => {
  const t = new TypingTracker();
  t.pushed('c1', 0);
  t.activity(0, ['c1']);
  expect(t.activity(TYPING_IDLE_MS)).toEqual([]);
  expect(t.hasActive).toBe(false);
  expect(t.activity(TYPING_IDLE_MS + 1_000, ['c1'])).toEqual(['c1']);
});

class ManualTimers implements TypingTimers {
  clock = 0;
  private next = 1;
  readonly timers = new Map<number, { fn: () => void; at: number }>();
  set(fn: () => void, ms: number): number {
    const id = this.next++;
    this.timers.set(id, { fn, at: this.clock + ms });
    return id;
  }
  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  now(): number {
    return this.clock;
  }
  advance(ms: number): void {
    const target = this.clock + ms;
    for (;;) {
      const due = [...this.timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.clock = due[1].at;
      due[1].fn();
    }
    this.clock = target;
  }
}

test('the loop types on the first covering call, refreshes every 8 s, and goes quiet after 3 idle minutes', () => {
  const timers = new ManualTimers();
  const sent: string[] = [];
  const loop = new TypingLoop(async (c) => void sent.push(c), timers);

  loop.activity(['c1']); // nothing pushed yet
  expect(sent).toEqual([]);
  expect(timers.timers.size).toBe(0);

  loop.pushed('c1');
  loop.activity(['c1']);
  expect(sent).toEqual(['c1']);
  expect(timers.timers.size).toBe(1);

  timers.advance(TYPING_REFRESH_MS);
  expect(sent).toEqual(['c1', 'c1']);

  timers.advance(TYPING_IDLE_MS + TYPING_REFRESH_MS);
  const settled = sent.length;
  expect(timers.timers.size).toBe(0);
  timers.advance(60_000);
  expect(sent).toHaveLength(settled);
  // 1 immediate + refreshes every 8 s until the 3 minute mark.
  expect(settled).toBeLessThanOrEqual(1 + TYPING_IDLE_MS / TYPING_REFRESH_MS);
});

test('posting stops the loop and its timer', () => {
  const timers = new ManualTimers();
  const sent: string[] = [];
  const loop = new TypingLoop(async (c) => void sent.push(c), timers);
  loop.pushed('c1');
  loop.activity(['c1']);
  loop.answered('c1');
  expect(timers.timers.size).toBe(0);
  timers.advance(60_000);
  expect(sent).toEqual(['c1']);
});

test('a failing or throwing send is swallowed and the loop keeps its schedule', async () => {
  const timers = new ManualTimers();
  let calls = 0;
  const loop = new TypingLoop(() => {
    calls++;
    if (calls === 1) throw new Error('not configured');
    return Promise.reject(new Error('Missing Access'));
  }, timers);
  loop.pushed('c1');
  loop.activity(['c1']);
  timers.advance(TYPING_REFRESH_MS);
  await Promise.resolve();
  expect(calls).toBe(2);
  expect(timers.timers.size).toBe(1);
});
