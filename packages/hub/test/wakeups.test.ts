import { expect, test } from 'bun:test';
import type { WakeMessage } from '../src/waker.ts';
import {
  debounceDelay,
  Debouncer,
  isMarker,
  mergeWakeMessages,
  needsClaimantLookup,
  wakeReason,
  WAKE_MAX_MS,
  WAKE_QUIET_MS,
  type Scheduler,
  type WakeInput,
} from '../src/wakeups.ts';
import type { ListenMode } from '@backchannel/core';

const T = 'target';
const HUB = 'hub';
/** A bot message in a text channel: never ambient, so only direct triggers wake on it. */
const base: WakeInput = {
  authorId: 'someone',
  mentionedUserIds: [],
  ambient: { fromBot: true, type: 0, where: 'text', channelName: 'general' },
};
const human: WakeInput = { ...base, ambient: { ...base.ambient, fromBot: false } };
const reason = (input: WakeInput, listen: ListenMode = 'all') => wakeReason(input, T, HUB, listen);

test('mention, reply and post ownership each wake the target', () => {
  expect(reason({ ...base, mentionedUserIds: [T] })).toBe('mention');
  expect(reason({ ...base, repliedToAuthorId: T })).toBe('reply');
  expect(reason({ ...base, post: { starterAuthorId: T, claimantId: null } })).toBe('started_post');
  expect(reason({ ...base, post: { starterAuthorId: 'x', claimantId: T } })).toBe('claimed_post');
});

test('a reply that also pings is a reply', () => {
  expect(reason({ ...base, repliedToAuthorId: T, mentionedUserIds: [T] })).toBe('reply');
});

test('listen all: a person talking wakes as ambient, a bot talking does not', () => {
  expect(reason(human)).toBe('ambient');
  expect(reason({ ...human, ambient: { ...human.ambient, where: 'forum_post' } })).toBe('ambient');
  expect(reason({ ...human, ambient: { ...human.ambient, type: 19 } })).toBe('ambient');
  expect(reason(base)).toBeNull();
  expect(reason({ ...base, mentionedUserIds: ['other'], repliedToAuthorId: 'other' })).toBeNull();
  expect(reason({ ...base, post: { starterAuthorId: 'x', claimantId: 'y' } })).toBeNull();
});

test('listen all: system messages, #starboard and other channel kinds stay quiet', () => {
  expect(reason({ ...human, ambient: { ...human.ambient, type: 7 } })).toBeNull();
  expect(reason({ ...human, ambient: { ...human.ambient, type: 18 } })).toBeNull();
  expect(reason({ ...human, ambient: { ...human.ambient, channelName: 'starboard' } })).toBeNull();
  expect(reason({ ...human, ambient: { ...human.ambient, where: 'other' } })).toBeNull();
});

test('a direct trigger wakes even from a bot, and beats ambient', () => {
  expect(reason({ ...base, mentionedUserIds: [T] })).toBe('mention');
  expect(reason({ ...human, mentionedUserIds: [T] })).toBe('mention');
});

test('listen mentions: only direct triggers wake', () => {
  expect(reason(human, 'mentions')).toBeNull();
  expect(reason({ ...human, mentionedUserIds: [T] }, 'mentions')).toBe('mention');
  expect(reason({ ...base, repliedToAuthorId: T }, 'mentions')).toBe('reply');
});

test('messages from the target and from the hub are ignored', () => {
  const aimed = { ...human, mentionedUserIds: [T], post: { starterAuthorId: T, claimantId: T } };
  expect(reason({ ...aimed, authorId: T })).toBeNull();
  expect(reason({ ...aimed, authorId: HUB })).toBeNull();
});

test('claimant lookup is skipped when the answer is already known', () => {
  const post = { starterAuthorId: 'x', claimantId: null };
  expect(needsClaimantLookup({ ...base, post }, T)).toBe(true);
  expect(needsClaimantLookup({ ...base, post: { ...post, starterAuthorId: T } }, T)).toBe(false);
  expect(needsClaimantLookup({ ...base, post, mentionedUserIds: [T] }, T)).toBe(false);
  expect(needsClaimantLookup(base, T)).toBe(false);
});

/** A clock plus timers that fire in due order when the clock is moved. */
class ManualScheduler implements Scheduler {
  private next = 1;
  clock = 0;
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

test('debounceDelay waits the quiet time, capped by the time left until the maximum', () => {
  expect(debounceDelay(0, 0, 1500, 5000)).toBe(1500);
  expect(debounceDelay(0, 2000, 1500, 5000)).toBe(1500);
  expect(debounceDelay(0, 4000, 1500, 5000)).toBe(1000);
  expect(debounceDelay(0, 5000, 1500, 5000)).toBe(0);
  expect(debounceDelay(0, 9000, 1500, 5000)).toBe(0);
});

test('a lone message flushes 1.5 s after it arrived', async () => {
  const sched = new ManualScheduler();
  const flushed: [string, number[]][] = [];
  const d = new Debouncer<number>(WAKE_QUIET_MS, WAKE_MAX_MS, (k, items) => void flushed.push([k, items]), sched);
  d.add('post1', 1);
  sched.advance(1499);
  expect(flushed).toEqual([]);
  sched.advance(1);
  expect(flushed).toEqual([['post1', [1]]]);
});

test('each new message in a channel pushes its flush back, separately per channel', () => {
  const sched = new ManualScheduler();
  const flushed: [string, number[]][] = [];
  const d = new Debouncer<number>(1500, 5000, (k, items) => void flushed.push([k, items]), sched);
  d.add('post1', 1);
  d.add('post2', 3);
  expect(sched.timers.size).toBe(2);
  sched.advance(1000);
  d.add('post1', 2); // pushes post1's flush to 2500; post2 is untouched
  sched.advance(500);
  expect(flushed).toEqual([['post2', [3]]]);
  sched.advance(999);
  expect(flushed).toEqual([['post2', [3]]]);
  sched.advance(1);
  expect(flushed).toEqual([
    ['post2', [3]],
    ['post1', [1, 2]],
  ]);
  d.add('post1', 4);
  expect(sched.timers.size).toBe(1);
});

test('a chatty channel is flushed 5 s after its first message at the latest', () => {
  const sched = new ManualScheduler();
  const flushed: number[][] = [];
  const d = new Debouncer<number>(1500, 5000, (_k, items) => void flushed.push(items), sched);
  for (let i = 0; i < 8; i++) {
    d.add('busy', i);
    sched.advance(1000); // never quiet for 1.5 s
  }
  // Messages arrive at t=0..4000 and are flushed at t=5000 (5 s after the first), before the
  // message that arrives at t=5000.
  expect(flushed[0]).toEqual([0, 1, 2, 3, 4]);
  // The rest start a new batch with a fresh 5 s ceiling; it is quiet 1.5 s after t=7000.
  sched.advance(5000);
  expect(flushed[1]).toEqual([5, 6, 7]);
});

test('debouncer flushAll sends pending batches and cancels timers', async () => {
  const sched = new ManualScheduler();
  const flushed: number[][] = [];
  const d = new Debouncer<number>(1500, 5000, (_k, items) => void flushed.push(items), sched);
  d.add('a', 1);
  d.add('a', 2);
  await d.flushAll();
  expect(flushed).toEqual([[1, 2]]);
  expect(sched.timers.size).toBe(0);
});

test('mergeWakeMessages mirrors the newest message with the strongest reason', () => {
  const msg = (messageId: string, reason: WakeMessage['reason']): WakeMessage => ({
    reason,
    messageId,
    authorId: 'a',
    authorName: 'n',
    authorKind: 'human',
    content: messageId,
    jumpUrl: `url/${messageId}`,
  });
  const event = mergeWakeMessages('chan', { postTitle: 'T', forumName: 'F' }, [msg('1', 'mention'), msg('2', 'started_post')]);
  expect(event.messageId).toBe('2');
  expect(event.reason).toBe('mention');
  expect(event.channelId).toBe('chan');
  expect(event.postTitle).toBe('T');
  expect(event.messages.map((m) => m.messageId)).toEqual(['1', '2']);
});

test('isMarker matches claim and release first lines only', () => {
  expect(isMarker('🔒 Claimed by atlas\nplan')).toBe(true);
  expect(isMarker('🔓 Released by atlas – now Done')).toBe(true);
  expect(isMarker('talking about 🔒 Claimed by someone')).toBe(false);
});
