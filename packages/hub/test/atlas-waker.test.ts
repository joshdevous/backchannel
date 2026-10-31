import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { SessionInfo } from '@atlas/shared-types';
import type { AtlasChats, DeliveryOutcome } from '../src/atlas-device.ts';
import type { AtlasProject } from '../src/atlas-projects.ts';
import { AtlasStore, UNFILED, type AtlasChat, type ChatTarget } from '../src/atlas-store.ts';
import type { TurnState } from '../src/presence.ts';
import type { Classification, ClassifyInput, ProjectRouting } from '../src/project-classifier.ts';
import {
  AtlasWaker,
  decideWake,
  MAX_WAKES_PER_HOUR,
  SPAWN_INTERVAL_MS,
  SPAWN_STUCK_MS,
} from '../src/atlas-waker.ts';
import type { WakeEvent } from '../src/waker.ts';

type Target = ChatTarget;

const BACKCHANNEL: AtlasProject = { id: 'p-bc', name: 'Backchannel', description: '', checkouts: [] };
const RPAI: AtlasProject = { id: 'p-rpai', name: 'ResourcePack AI', description: '', checkouts: [] };
const ATLAS: AtlasProject = { id: 'p-atlas', name: 'Atlas', description: '', checkouts: ['/gone/atlas', '/root/projects/atlas'] };

class FakeProjects implements ProjectRouting {
  /** What the next classification returns; `undefined` is "no project list". */
  next: AtlasProject | undefined = BACKCHANNEL;
  calls: ClassifyInput[] = [];
  filed: { projectId: string; conversationId: string }[] = [];
  failFile = false;

  async classify(input: ClassifyInput): Promise<Classification> {
    this.calls.push(input);
    await Promise.resolve();
    return { project: this.next, name: this.next?.name ?? 'Backchannel', ms: 7 };
  }

  async file(projectId: string, conversationId: string): Promise<void> {
    await Promise.resolve();
    if (this.failFile) throw new Error('HTTP 500');
    this.filed.push({ projectId, conversationId });
  }
}

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
  return { ...message, channelId, postTitle: 'A post', forumName: 'misc', messages: [message] };
}

/** A batch in a plain channel (#general): no post title, classified every batch. */
function generalEvent(channelId: string, content: string): WakeEvent {
  const { postTitle: _title, forumName: _forum, ...rest } = wakeEvent(channelId, content);
  return { ...rest, channelName: 'general' };
}

function setup() {
  let clock = 1_000_000_000;
  let ids = 0;
  const store = new AtlasStore(new Database(':memory:'));
  const chats = new FakeChats();
  const projects = new FakeProjects();
  const typing: { channelId: string; probe: () => Promise<TurnState> }[] = [];
  const waker = new AtlasWaker({
    store,
    chats,
    projects,
    cwd: '/root/chats',
    dirExists: (path) => path === '/root/projects/atlas',
    ownerId: 'owner',
    guildId: 'g',
    presence: { startTyping: (channelId, probe) => void typing.push({ channelId, probe }) },
    now: () => clock,
    newRequestId: () => `req-${++ids}`,
  });
  return { store, chats, projects, waker, typing, advance: (ms: number) => (clock += ms), now: () => clock };
}

test('first wake spawns a chat, maps the channel and sends the brief; the next one messages it', async () => {
  const { store, chats, waker } = setup();
  await waker.wake(wakeEvent('c1', 'first'));
  expect(chats.spawns).toEqual(['req-1']);
  expect(store.chat('c1')).toEqual({
    channelId: 'c1',
    projectId: 'p-bc',
    projectName: 'Backchannel',
    acpSessionId: 'acp-1',
    machineId: 'atlas-vps',
    cwd: '/root/chats',
  });
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
  store.beginSpawn('r1', 'c1', 'p1', t);
  expect(decideWake(store, 'c1', 'p1', t + SPAWN_INTERVAL_MS + 1)).toMatchObject({ kind: 'drop' });
  expect(decideWake(store, 'c1', undefined, t + SPAWN_INTERVAL_MS + 1)).toMatchObject({ kind: 'drop' });
  expect(decideWake(store, 'c1', 'p1', t + SPAWN_STUCK_MS + 1)).toEqual({ kind: 'spawn' });
  expect(decideWake(store, 'c2', 'p1', t)).toEqual({ kind: 'spawn' });
  // Another project in the same channel is another chat.
  expect(decideWake(store, 'c1', 'p2', t)).toEqual({ kind: 'spawn' });
});

test('a spawn maps its channel only once, under its own request id', () => {
  const store = new AtlasStore(new Database(':memory:'));
  const chat = (acp: string): AtlasChat => ({ channelId: 'c1', projectId: 'p1', projectName: 'P', acpSessionId: acp, machineId: 'm', cwd: '/x' });
  store.beginSpawn('r1', 'c1', 'p1', 1);
  store.beginSpawn('r2', 'c1', 'p1', 2);
  expect(store.finishSpawn('unknown', chat('acp-0'), 3)).toBe(false);
  expect(store.finishSpawn('r1', { ...chat('acp-1'), channelId: 'c2' }, 3)).toBe(false);
  expect(store.finishSpawn('r1', { ...chat('acp-1'), projectId: 'p2' }, 3)).toBe(false);
  expect(store.finishSpawn('r1', chat('acp-1'), 3)).toBe(true);
  expect(store.finishSpawn('r1', chat('acp-1b'), 4)).toBe(false);
  // A second attempt landing late never replaces the first chat.
  expect(store.finishSpawn('r2', chat('acp-2'), 4)).toBe(false);
  expect(store.chat('c1')?.acpSessionId).toBe('acp-1');
  store.failSpawn('r1', 'too late');
  expect(store.hasPendingSpawn('c1', undefined, 0)).toBe(false);
});

test('spawns a previous process left pending are failed on start, but still count for the interval', async () => {
  const db = new Database(':memory:');
  const store = new AtlasStore(db);
  store.beginSpawn('old', 'c1', 'p-bc', 1_000_000_000);
  const chats = new FakeChats();
  const projects = new FakeProjects();
  const waker = new AtlasWaker({ store, chats, projects, cwd: '/x', ownerId: 'o', guildId: 'g', now: () => 1_000_000_000 + 1000 });
  expect(store.hasPendingSpawn('c1', undefined, 0)).toBe(false);
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

test('an ambient wake is delivered but shows no typing', async () => {
  const { waker, typing, chats } = setup();
  const event = wakeEvent('c1', 'chatter');
  await waker.wake({ ...event, reason: 'ambient', messages: event.messages.map((m) => ({ ...m, reason: 'ambient' as const })) });
  expect(typing).toHaveLength(0);
  expect(chats.deliveries.some((d) => d.text.includes('Nobody asked you directly'))).toBe(true);
});

test('only the first wake of a channel fetches the earlier messages for its brief', async () => {
  const { waker, chats } = setup();
  let fetches = 0;
  const earlier = async () => {
    fetches++;
    return [{ messageId: 'e1', authorId: 'owner', authorName: 'J', authorKind: 'human' as const, content: 'context line' }];
  };
  await waker.wake({ ...wakeEvent('c1', 'first'), earlier });
  expect(chats.deliveries[0]!.text).toContain('(message e1): "context line"');
  await waker.wake({ ...wakeEvent('c1', 'second'), earlier });
  expect(fetches).toBe(1);
  expect(chats.deliveries[1]!.text).not.toContain('context line');
});

test('a failing earlier fetch still sends the first brief', async () => {
  const { waker, chats } = setup();
  await waker.wake({ ...wakeEvent('c1', 'first'), earlier: async () => Promise.reject(new Error('nope')) });
  expect(chats.deliveries[0]!.text).toContain('> first');
});

test('a forum post is classified once, when its chat opens, and keeps that project and chat', async () => {
  const { store, chats, projects, waker } = setup();
  projects.next = RPAI;
  await waker.wake({ ...wakeEvent('post1', 'first'), postTitle: 'Better prompts', forumName: 'resourcepack-ai' });
  expect(projects.calls).toHaveLength(1);
  expect(projects.calls[0]).toMatchObject({ forumName: 'resourcepack-ai', postTitle: 'Better prompts' });
  expect(projects.calls[0]!.hint).toBeUndefined();
  expect(store.chat('post1')).toMatchObject({ projectId: 'p-rpai', projectName: 'ResourcePack AI', cwd: '/root/chats' });
  expect(projects.filed).toEqual([{ projectId: 'p-rpai', conversationId: 'acp-1' }]);
  expect(chats.deliveries[0]!.text).toContain('filed in the Atlas project "ResourcePack AI"');
  expect(chats.deliveries[0]!.text).not.toContain('sorts');

  // Later batches go to the same chat without asking again, whatever they talk about.
  projects.next = BACKCHANNEL;
  await waker.wake({ ...wakeEvent('post1', 'second'), postTitle: 'Better prompts', forumName: 'resourcepack-ai' });
  expect(projects.calls).toHaveLength(1);
  expect(chats.spawns).toHaveLength(1);
  expect(chats.deliveries[1]).toMatchObject({ acpSessionId: 'acp-1' });
});

test('a plain channel is classified every batch and has one chat per project', async () => {
  const { store, chats, projects, waker } = setup();
  projects.next = RPAI;
  await waker.wake(generalEvent('general', 'the resource pack generator is slow'));
  projects.next = BACKCHANNEL;
  await waker.wake(generalEvent('general', 'what is everyone up to tonight'));
  projects.next = RPAI;
  await waker.wake(generalEvent('general', 'back to the generator'));

  expect(projects.calls.map((c) => c.hint)).toEqual([undefined, 'ResourcePack AI', 'Backchannel']);
  expect(projects.calls[0]).toMatchObject({ channelName: 'general' });
  expect(chats.spawns).toHaveLength(2);
  expect(store.chat('general', 'p-rpai')?.acpSessionId).toBe('acp-1');
  expect(store.chat('general', 'p-bc')?.acpSessionId).toBe('acp-2');
  expect(projects.filed).toEqual([
    { projectId: 'p-rpai', conversationId: 'acp-1' },
    { projectId: 'p-bc', conversationId: 'acp-2' },
  ]);
  expect(chats.deliveries.map((d) => d.acpSessionId)).toEqual(['acp-1', 'acp-2', 'acp-1']);
  expect(chats.deliveries[0]!.text).toContain('#general');
  expect(chats.deliveries[0]!.text).toContain('The hub sorts #general by topic');
  expect(chats.deliveries[2]!.text).toContain('sorted to this chat as about "ResourcePack AI"');
});

test('the spawn interval is per (channel, project) in a plain channel', async () => {
  const { chats, projects, waker } = setup();
  chats.failSpawn = true;
  projects.next = RPAI;
  await waker.wake(generalEvent('general', 'a'));
  chats.failSpawn = false;
  await waker.wake(generalEvent('general', 'b'));
  expect(chats.spawns).toHaveLength(1);
  projects.next = BACKCHANNEL;
  await waker.wake(generalEvent('general', 'c'));
  expect(chats.spawns).toHaveLength(2);
});

test("a chat opens in its project's first checkout that exists, else the fallback cwd", async () => {
  const { store, projects, waker } = setup();
  projects.next = ATLAS;
  await waker.wake(generalEvent('general', 'the relay is down'));
  expect(store.chat('general', 'p-atlas')?.cwd).toBe('/root/projects/atlas');
});

test('a failed filing is logged, the chat is still prompted and no second chat is opened', async () => {
  const { store, chats, projects, waker } = setup();
  projects.failFile = true;
  await waker.wake(wakeEvent('c1', 'first'));
  await waker.wake(wakeEvent('c1', 'second'));
  expect(chats.spawns).toHaveLength(1);
  expect(chats.deliveries).toHaveLength(2);
  expect(store.chat('c1')?.acpSessionId).toBe('acp-1');
});

test('without a project list the chat is opened unfiled in the fallback cwd', async () => {
  const { store, chats, projects, waker } = setup();
  projects.next = undefined;
  await waker.wake(generalEvent('general', 'hello'));
  expect(store.chat('general', UNFILED)).toMatchObject({ projectName: '', cwd: '/root/chats' });
  expect(projects.filed).toHaveLength(0);
  expect(chats.deliveries[0]!.text).toContain('This chat stays tied to that channel');
});

test('a batch over the hourly limit is dropped before it is classified', async () => {
  const { store, projects, waker } = setup();
  for (let i = 0; i < MAX_WAKES_PER_HOUR; i++) store.recordWake('x', 'deliver', 1_000_000_000);
  await waker.wake(generalEvent('general', 'hi'));
  expect(projects.calls).toHaveLength(0);
});

test('the store moves chats keyed by channel alone to the (channel, project) key', () => {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE atlas_chats (
    channel_id TEXT PRIMARY KEY, acp_session_id TEXT NOT NULL, machine_id TEXT NOT NULL, cwd TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  db.run(`CREATE TABLE atlas_spawns (
    request_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, started_at INTEGER NOT NULL, state TEXT NOT NULL, acp_session_id TEXT, error TEXT
  )`);
  db.run(`INSERT INTO atlas_chats VALUES ('post1', 'acp-old', 'atlas-vps', '/root/chats', 1)`);
  db.run(`INSERT INTO atlas_spawns VALUES ('r0', 'post1', 1, 'done', 'acp-old', NULL)`);
  const store = new AtlasStore(db);
  expect(store.chat('post1')).toMatchObject({ projectId: UNFILED, acpSessionId: 'acp-old' });
  expect(store.lastSpawnAt('post1', UNFILED)).toBe(1);
  // Opening the store again leaves the migrated table alone.
  expect(new AtlasStore(db).chat('post1')?.acpSessionId).toBe('acp-old');
});
