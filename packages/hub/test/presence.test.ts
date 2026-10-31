import { expect, test } from 'bun:test';
import { ACK_EMOJI } from '@backchannel/core';
import { botIdFromToken, loadAgentToken } from '../src/config.ts';
import {
  AgentPresence,
  nextTypingStep,
  TYPING_MAX_MS,
  TYPING_NO_TURN_GRACE_MS,
  TYPING_REFRESH_MS,
  TypingKeeper,
  type AgentBotApi,
  type TurnState,
} from '../src/presence.ts';
import type { Scheduler } from '../src/wakeups.ts';

const run = (startedAt = 0, turnSeen = false) => ({ startedAt, turnSeen });

test('typing carries on while the turn is open and stops once it closes after being seen', () => {
  expect(nextTypingStep(run(), 'open', 8_000)).toEqual({ keep: true, turnSeen: true });
  expect(nextTypingStep(run(0, true), 'open', 60_000)).toEqual({ keep: true, turnSeen: true });
  expect(nextTypingStep(run(0, true), 'closed', 60_000)).toEqual({ keep: false, turnSeen: true });
});

test('typing waits for a turn that has not started yet, but only for the grace period', () => {
  expect(nextTypingStep(run(), 'closed', 8_000).keep).toBe(true);
  expect(nextTypingStep(run(), 'unknown', TYPING_NO_TURN_GRACE_MS - 1).keep).toBe(true);
  expect(nextTypingStep(run(), 'closed', TYPING_NO_TURN_GRACE_MS).keep).toBe(false);
  expect(nextTypingStep(run(), 'unknown', TYPING_NO_TURN_GRACE_MS).keep).toBe(false);
});

test('an unknown state (probe failed) leaves a seen turn alone, and typing still ends after ten minutes', () => {
  expect(nextTypingStep(run(0, true), 'unknown', 120_000).keep).toBe(true);
  expect(nextTypingStep(run(0, true), 'open', TYPING_MAX_MS).keep).toBe(false);
  expect(nextTypingStep(run(0, true), 'unknown', TYPING_MAX_MS - 1).keep).toBe(true);
});

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
  /** Moves the clock and runs what is due, letting each timer's async work settle first. */
  async advance(ms: number): Promise<void> {
    const target = this.clock + ms;
    for (;;) {
      const due = [...this.timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.clock = due[1].at;
      due[1].fn();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    this.clock = target;
  }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

test('the keeper types at once, refreshes every 8 s while the turn is open, and stops when it closes', async () => {
  const sched = new ManualScheduler();
  const sent: string[] = [];
  const keeper = new TypingKeeper(async (c) => void sent.push(c), sched);
  let turn: TurnState = 'unknown';
  keeper.startTyping('c1', async () => turn);
  await settle();
  expect(sent).toEqual(['c1']);

  turn = 'open';
  await sched.advance(TYPING_REFRESH_MS);
  expect(sent).toEqual(['c1', 'c1']);
  await sched.advance(TYPING_REFRESH_MS);
  expect(sent).toHaveLength(3);

  turn = 'closed';
  await sched.advance(TYPING_REFRESH_MS);
  expect(sent).toHaveLength(3);
  expect(keeper.active).toEqual([]);
  expect(sched.timers.size).toBe(0);
});

test('the keeper stops when the agent posts, and never types past ten minutes', async () => {
  const sched = new ManualScheduler();
  const sent: string[] = [];
  const keeper = new TypingKeeper(async (c) => void sent.push(c), sched);
  keeper.startTyping('posted', async () => 'open');
  keeper.startTyping('endless', async () => 'open');
  await settle();
  keeper.stop('posted');
  expect(sched.timers.size).toBe(1);

  await sched.advance(TYPING_MAX_MS + TYPING_REFRESH_MS);
  expect(keeper.active).toEqual([]);
  const before = sent.length;
  await sched.advance(60_000);
  expect(sent).toHaveLength(before);
  // 1 immediate + one per refresh until the cap (the beat at the cap itself stops instead).
  expect(sent.filter((c) => c === 'endless').length).toBeLessThanOrEqual(TYPING_MAX_MS / TYPING_REFRESH_MS + 1);
});

test('a second wake for a channel already typing shares one loop and restarts its clock', async () => {
  const sched = new ManualScheduler();
  const sent: string[] = [];
  const keeper = new TypingKeeper(async (c) => void sent.push(c), sched);
  keeper.startTyping('c1', async () => 'closed');
  await settle();
  await sched.advance(50_000);
  keeper.startTyping('c1', async () => 'closed');
  expect(sched.timers.size).toBe(1);
  await sched.advance(50_000); // 100 s since the first wake, 50 s since the second: still within grace
  expect(keeper.active).toEqual(['c1']);
});

test('a failing typing call is logged and does not end the loop', async () => {
  const sched = new ManualScheduler();
  let calls = 0;
  const keeper = new TypingKeeper(async () => {
    calls++;
    throw new Error('Missing Access');
  }, sched);
  keeper.startTyping('c1', async () => 'open');
  await settle();
  await sched.advance(TYPING_REFRESH_MS);
  expect(calls).toBe(2);
  expect(keeper.active).toEqual(['c1']);
});

function fakeApi() {
  const reactions: [string, string, string][] = [];
  const typed: string[] = [];
  let failReact = false;
  const api: AgentBotApi = {
    async react(c, m, e) {
      if (failReact) throw new Error('Unknown Message');
      reactions.push([c, m, e]);
    },
    async typing(c) {
      typed.push(c);
    },
  };
  return { api, reactions, typed, failReactions: () => (failReact = true) };
}

test('presence reacts with the ack emoji, ignores a failed reaction, and stops typing when the agent posts', async () => {
  const { api, reactions, typed, failReactions } = fakeApi();
  const sched = new ManualScheduler();
  const presence = new AgentPresence(api, new TypingKeeper((c) => api.typing(c), sched));
  presence.ack('c1', 'm1');
  await settle();
  expect(reactions).toEqual([['c1', 'm1', ACK_EMOJI]]);
  failReactions();
  presence.ack('c1', 'm2');
  await settle();
  expect(reactions).toHaveLength(1);

  presence.startTyping('c1', async () => 'open');
  await settle();
  expect(typed).toEqual(['c1']);
  presence.agentPosted('c1');
  await sched.advance(TYPING_REFRESH_MS * 3);
  expect(typed).toEqual(['c1']);
});

function tokenFor(botId: string): string {
  return `${Buffer.from(botId).toString('base64')}.AbCdEf.secretsecretsecret`;
}

test('botIdFromToken reads the bot id out of the token', () => {
  expect(botIdFromToken(tokenFor('123456789012345678'))).toBe('123456789012345678');
  expect(botIdFromToken('not-a-token')).toBeUndefined();
});

test('the agent token comes from ATLAS_AGENT_TOKEN first, then the config file for the same guild', () => {
  const bot = '123456789012345678';
  const file = JSON.stringify({ token: tokenFor(bot), guildId: 'g1' });
  const read = (p: string) => (p === '/home/x/.backchannel/config.json' ? file : undefined);

  const fromEnv = loadAgentToken({ ATLAS_AGENT_TOKEN: tokenFor(bot) }, 'g1', bot, () => undefined, '/home/x');
  expect(fromEnv).toEqual({ token: tokenFor(bot), source: 'ATLAS_AGENT_TOKEN' });

  const fromFile = loadAgentToken({}, 'g1', bot, read, '/home/x');
  expect(fromFile).toEqual({ token: tokenFor(bot), source: '/home/x/.backchannel/config.json' });

  const custom = loadAgentToken({ BACKCHANNEL_CONFIG: '/etc/bc.json' }, 'g1', bot, (p) => (p === '/etc/bc.json' ? file : undefined), '/home/x');
  expect(custom.token).toBe(tokenFor(bot));
});

test('the agent token is refused for another guild, another bot, or a missing or broken file', () => {
  const bot = '123456789012345678';
  const file = (extra: object) => JSON.stringify({ token: tokenFor(bot), guildId: 'g1', ...extra });
  const home = '/home/x';
  const path = `${home}/.backchannel/config.json`;

  expect(loadAgentToken({}, 'g2', bot, () => file({}), home).token).toBeUndefined();
  expect(loadAgentToken({}, 'g1', '999999999999999999', () => file({}), home).token).toBeUndefined();
  expect(loadAgentToken({ ATLAS_AGENT_TOKEN: tokenFor('999999999999999999') }, 'g1', bot, () => undefined, home).token).toBeUndefined();
  expect(loadAgentToken({}, 'g1', bot, () => undefined, home)).toEqual({ why: expect.stringContaining(path) });
  expect(loadAgentToken({}, 'g1', bot, () => '{nope', home).token).toBeUndefined();
  expect(loadAgentToken({}, 'g1', bot, () => JSON.stringify({ guildId: 'g1' }), home).token).toBeUndefined();
});
