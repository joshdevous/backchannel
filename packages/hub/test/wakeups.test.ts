import { expect, test } from 'bun:test';
import type { WakeMessage } from '../src/waker.ts';
import {
  Debouncer,
  isMarker,
  mergeWakeMessages,
  needsClaimantLookup,
  wakeReason,
  type Scheduler,
  type WakeInput,
} from '../src/wakeups.ts';

const T = 'target';
const HUB = 'hub';
const base: WakeInput = { authorId: 'someone', mentionedUserIds: [] };

test('mention, reply and post ownership each wake the target', () => {
  expect(wakeReason({ ...base, mentionedUserIds: [T] }, T, HUB)).toBe('mention');
  expect(wakeReason({ ...base, repliedToAuthorId: T }, T, HUB)).toBe('reply');
  expect(wakeReason({ ...base, post: { starterAuthorId: T, claimantId: null } }, T, HUB)).toBe('own-post');
  expect(wakeReason({ ...base, post: { starterAuthorId: 'x', claimantId: T } }, T, HUB)).toBe('claimed-post');
});

test('a reply that also pings is a reply', () => {
  expect(wakeReason({ ...base, repliedToAuthorId: T, mentionedUserIds: [T] }, T, HUB)).toBe('reply');
});

test('unrelated messages do not wake', () => {
  expect(wakeReason(base, T, HUB)).toBeNull();
  expect(wakeReason({ ...base, mentionedUserIds: ['other'], repliedToAuthorId: 'other' }, T, HUB)).toBeNull();
  expect(wakeReason({ ...base, post: { starterAuthorId: 'x', claimantId: 'y' } }, T, HUB)).toBeNull();
});

test('messages from the target and from the hub are ignored', () => {
  const aimed = { mentionedUserIds: [T], post: { starterAuthorId: T, claimantId: T } };
  expect(wakeReason({ ...aimed, authorId: T }, T, HUB)).toBeNull();
  expect(wakeReason({ ...aimed, authorId: HUB }, T, HUB)).toBeNull();
});

test('claimant lookup is skipped when the answer is already known', () => {
  const post = { starterAuthorId: 'x', claimantId: null };
  expect(needsClaimantLookup({ ...base, post }, T)).toBe(true);
  expect(needsClaimantLookup({ ...base, post: { ...post, starterAuthorId: T } }, T)).toBe(false);
  expect(needsClaimantLookup({ ...base, post, mentionedUserIds: [T] }, T)).toBe(false);
  expect(needsClaimantLookup(base, T)).toBe(false);
});

class ManualScheduler implements Scheduler {
  private next = 1;
  readonly timers = new Map<number, { fn: () => void; ms: number }>();
  set(fn: () => void, ms: number): number {
    const id = this.next++;
    this.timers.set(id, { fn, ms });
    return id;
  }
  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }
  fireAll(): void {
    for (const [id, t] of [...this.timers]) {
      this.timers.delete(id);
      t.fn();
    }
  }
}

test('debouncer batches per key with one window per key', async () => {
  const sched = new ManualScheduler();
  const flushed: [string, number[]][] = [];
  const d = new Debouncer<number>(20_000, (k, items) => void flushed.push([k, items]), sched);
  d.add('post1', 1);
  d.add('post1', 2);
  d.add('post2', 3);
  d.add('post1', 4);
  expect(sched.timers.size).toBe(2);
  expect([...sched.timers.values()].every((t) => t.ms === 20_000)).toBe(true);
  expect(flushed).toEqual([]);
  sched.fireAll();
  await Promise.resolve();
  expect(flushed).toEqual([
    ['post1', [1, 2, 4]],
    ['post2', [3]],
  ]);
  d.add('post1', 5);
  expect(sched.timers.size).toBe(1);
});

test('debouncer flushAll sends pending batches and cancels timers', async () => {
  const sched = new ManualScheduler();
  const flushed: number[][] = [];
  const d = new Debouncer<number>(20_000, (_k, items) => void flushed.push(items), sched);
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
  const event = mergeWakeMessages('chan', { postTitle: 'T', forumName: 'F' }, [msg('1', 'mention'), msg('2', 'own-post')]);
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
