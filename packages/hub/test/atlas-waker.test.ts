import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { SessionInfo } from '@atlas/shared-types';
import type { AtlasChats, DeliveryOutcome } from '../src/atlas-device.ts';
import { AtlasStore, type AtlasChat } from '../src/atlas-store.ts';
import type { TurnState } from '../src/presence.ts';
import {
  AtlasWaker,
  decideWake,
  MAX_WAKES_PER_HOUR,
  SPAWN_INTERVAL_MS,
  SPAWN_STUCK_MS,
} from '../src/atlas-waker.ts';
import type { WakeEvent } from '../src/waker.ts';

type Target = Omit<AtlasChat, 'channelId'>;

class FakeChats implements AtlasChats {
  spawns: string[] = [];
  deliveries: { acpSessionId: string; text: string }[] = [];
  failSpawn = false;
  failDeliver = false;
  #next = 0;

  async spawn(cwd: string, requestId: string): Promise<Target> {
    this.spawns.push(requestId);
    await Promise.resolve(); // settle asynchronously, so concurrent wakes can interleave
    if (this.failSpawn) throw new Error('machine said no');
    return { acpSessionId: `acp-${++this.#next}`, machineId: 'atlas-vps', cwd };
  }

  async deliver(chat: Target, text: string): Promise<DeliveryOutcome> {
    await Promise.resolve();
    if (this.failDeliver) throw new Error('prompt refused');
    this.deliveries.push({ acpSessionId: chat.acpSessionId, text });
    return 'prompted';
  }

  /** Acp session ids whose run currently has an open turn. */
  openTurns = new Set<string>();

  async liveRun(machineId: string, acpSessionId: string): Promise<SessionInfo | undefined> {
    return { sessionId: `run-${acpSessionId}`, machineId, turnOpen: this.openTurns.has(acpSessionId) } as SessionInfo;
  }

  stop(): void {}
}

function wakeEvent(channelId: string, content = 'hi'): WakeEvent {
  const message = {
    reason: 'mention' as const,
    messageId: `m-${content}`,
    authorId: 'peer',
    authorName: 'Sam',
    authorKind: 'human' as const,
    content,
    jumpUrl: 'https://discord.com/channels/g/c/m',
  };
  return { ...message, channelId, postTitle: 'A post', messages: [message] };
}

function setup() {
  let clock = 1_000_000_000;
  let ids = 0;
  const store = new AtlasStore(new Database(':memory:'));
  const chats = new FakeChats();
  const typing: { channelId: string; probe: () => Promise<TurnState> }[] = [];
  const waker = new AtlasWaker({
    store,
    chats,
    cwd: '/root/chats',
    ownerId: 'owner',
    guildId: 'g',
    presence: { startTyping: (channelId, probe) => void typing.push({ channelId, probe }) },
    now: () => clock,
    newRequestId: () => `req-${++ids}`,
  });
  return { store, chats, waker, typing, advance: (ms: number) => (clock += ms), now: () => clock };
}

test('first wake spawns a chat, maps the channel and sends the brief; the next one messages it', async () => {
  const { store, chats, waker } = setup();
  await waker.wake(wakeEvent('c1', 'first'));
  expect(chats.spawns).toEqual(['req-1']);
  expect(store.chat('c1')).toEqual({ channelId: 'c1', acpSessionId: 'acp-1', machineId: 'atlas-vps', cwd: '/root/chats' });
  expect(chats.deliveries).toHaveLength(1);
  expect(chats.deliveries[0]!.text).toContain('You were woken by Backchannel');
  expect(chats.deliveries[0]!.text).toContain('> first');

  await waker.wake(wakeEvent('c1', 'second'));
  expect(chats.spawns).toHaveLength(1);
  expect(chats.deliveries[1]).toMatchObject({ acpSessionId: 'acp-1' });
  expect(chats.deliveries[1]!.text).toContain('New Backchannel messages');
  expect(chats.deliveries[1]!.text).toContain('> second');
});

test('wakes for one channel arriving together open one chat, not two', async () => {
  const { chats, waker } = setup();
  await Promise.all([waker.wake(wakeEvent('c1', 'a')), waker.wake(wakeEvent('c1', 'b')), waker.wake(wakeEvent('c2', 'c'))]);
  expect(chats.spawns).toHaveLength(2);
  const c1 = chats.deliveries.filter((d) => d.acpSessionId === chats.deliveries[0]!.acpSessionId);
  expect(c1.map((d) => d.text.includes('> a') || d.text.includes('> b'))).toEqual([true, true]);
});

test('a failed spawn is retried only after the per-post interval', async () => {
  const { store, chats, waker, advance } = setup();
  chats.failSpawn = true;
  await waker.wake(wakeEvent('c1'));
  expect(chats.spawns).toHaveLength(1);
  expect(store.chat('c1')).toBeUndefined();

  chats.failSpawn = false;
  advance(SPAWN_INTERVAL_MS - 1);
  await waker.wake(wakeEvent('c1'));
  expect(chats.spawns).toHaveLength(1);

  advance(1);
  await waker.wake(wakeEvent('c1'));
  expect(chats.spawns).toHaveLength(2);
  expect(store.chat('c1')?.acpSessionId).toBe('acp-1');
});

test('a failed first prompt keeps the mapping, so the next wake does not open another chat', async () => {
  const { store, chats, waker } = setup();
  chats.failDeliver = true;
  await waker.wake(wakeEvent('c1'));
  expect(store.chat('c1')?.acpSessionId).toBe('acp-1');
  chats.failDeliver = false;
  await waker.wake(wakeEvent('c1'));
  expect(chats.spawns).toHaveLength(1);
  expect(chats.deliveries).toHaveLength(1);
});

test('at most MAX_WAKES_PER_HOUR wakes per sliding hour, across channels', async () => {
  const { chats, waker, advance } = setup();
  for (let i = 0; i < MAX_WAKES_PER_HOUR; i++) {
    await waker.wake(wakeEvent(`c${i % 3}`, `n${i}`));
    advance(1000);
  }
  expect(chats.deliveries).toHaveLength(MAX_WAKES_PER_HOUR);
  await waker.wake(wakeEvent('c0', 'over'));
  expect(chats.deliveries).toHaveLength(MAX_WAKES_PER_HOUR);
  expect(chats.deliveries.some((d) => d.text.includes('> over'))).toBe(false);

  // The oldest wake leaves the window; one more fits.
  advance(60 * 60_000 - MAX_WAKES_PER_HOUR * 1000 + 1);
  await waker.wake(wakeEvent('c0', 'later'));
  expect(chats.deliveries.some((d) => d.text.includes('> later'))).toBe(true);
});

test('a pending spawn blocks another until it settles or is stuck', () => {
  const store = new AtlasStore(new Database(':memory:'));
  const t = 5_000_000;
  store.beginSpawn('r1', 'c1', t);
  expect(decideWake(store, 'c1', t + SPAWN_INTERVAL_MS + 1)).toMatchObject({ kind: 'drop' });
  expect(decideWake(store, 'c1', t + SPAWN_STUCK_MS + 1)).toEqual({ kind: 'spawn' });
  expect(decideWake(store, 'c2', t)).toEqual({ kind: 'spawn' });
});

test('a spawn maps its channel only once, under its own request id', () => {
  const store = new AtlasStore(new Database(':memory:'));
  const chat = (acp: string) => ({ channelId: 'c1', acpSessionId: acp, machineId: 'm', cwd: '/x' });
  store.beginSpawn('r1', 'c1', 1);
  store.beginSpawn('r2', 'c1', 2);
  expect(store.finishSpawn('unknown', chat('acp-0'), 3)).toBe(false);
  expect(store.finishSpawn('r1', { ...chat('acp-1'), channelId: 'c2' }, 3)).toBe(false);
  expect(store.finishSpawn('r1', chat('acp-1'), 3)).toBe(true);
  expect(store.finishSpawn('r1', chat('acp-1b'), 4)).toBe(false);
  // A second attempt landing late never replaces the first chat.
  expect(store.finishSpawn('r2', chat('acp-2'), 4)).toBe(false);
  expect(store.chat('c1')?.acpSessionId).toBe('acp-1');
  store.failSpawn('r1', 'too late');
  expect(store.hasPendingSpawn('c1', 0)).toBe(false);
});

test('spawns a previous process left pending are failed on start, but still count for the interval', async () => {
  const db = new Database(':memory:');
  const store = new AtlasStore(db);
  store.beginSpawn('old', 'c1', 1_000_000_000);
  const chats = new FakeChats();
  const waker = new AtlasWaker({ store, chats, cwd: '/x', ownerId: 'o', guildId: 'g', now: () => 1_000_000_000 + 1000 });
  expect(store.hasPendingSpawn('c1', 0)).toBe(false);
  await waker.wake(wakeEvent('c1'));
  expect(chats.spawns).toHaveLength(0);
});

test('a wake starts typing at once; its probe reads the chat\'s run once the chat is mapped', async () => {
  const { chats, waker, typing } = setup();
  await waker.wake(wakeEvent('c1', 'first'));
  expect(typing.map((t) => t.channelId)).toEqual(['c1']);
  // The spawn mapped the chat, so the probe now reads its run.
  expect(await typing[0]!.probe()).toBe('closed');
  chats.openTurns.add('acp-1');
  expect(await typing[0]!.probe()).toBe('open');

  await waker.wake(wakeEvent('c1', 'second'));
  expect(typing.map((t) => t.channelId)).toEqual(['c1', 'c1']);
});

test('the typing probe is unknown while no chat is mapped', async () => {
  const { waker, typing, chats } = setup();
  chats.failSpawn = true;
  await waker.wake(wakeEvent('c1'));
  expect(typing).toHaveLength(1);
  expect(await typing[0]!.probe()).toBe('unknown');
});

test('a dropped wake does not start typing', async () => {
  const { waker, typing, advance } = setup();
  for (let i = 0; i < MAX_WAKES_PER_HOUR; i++) {
    await waker.wake(wakeEvent(`c${i}`));
    advance(1);
  }
  expect(typing).toHaveLength(MAX_WAKES_PER_HOUR);
  await waker.wake(wakeEvent('over'));
  expect(typing).toHaveLength(MAX_WAKES_PER_HOUR);
});
