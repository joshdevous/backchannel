/**
 * Visible signs that Josh's agent (an Atlas chat) has heard a message and is working on it, shown
 * as the agent's own bot: a 👀 reaction on the message that woke it, and "<bot> is typing…" in
 * the channel while its Atlas turn is open. The decisions are pure; Discord I/O is two thin calls.
 */
import { ACK_EMOJI } from '@backchannel/core';
import { REST, Routes } from 'discord.js';
import { log, logError } from './log.ts';
import type { Scheduler } from './wakeups.ts';

/** Discord shows "typing…" for about 10 s per call; refresh a little before it lapses. */
export const TYPING_REFRESH_MS = 8_000;
/** Typing never outlives this, whatever the turn does. */
export const TYPING_MAX_MS = 10 * 60_000;
/** Typing without ever seeing an open turn (spawn or resume that never produced one) stops after this. */
export const TYPING_NO_TURN_GRACE_MS = 60_000;

export type TurnState = 'open' | 'closed' | 'unknown';

export interface TypingRun {
  startedAt: number;
  /** An open turn has been observed since `startedAt`. */
  turnSeen: boolean;
}

export interface TypingStep {
  keep: boolean;
  turnSeen: boolean;
}

/**
 * Whether a typing indicator carries on, given what the probe just saw. Stops once the turn has
 * closed after being seen open, after `TYPING_MAX_MS`, or when no turn ever showed up within
 * `TYPING_NO_TURN_GRACE_MS`. An unknown state (probe failed, chat still spawning) changes nothing.
 */
export function nextTypingStep(run: TypingRun, turn: TurnState, now: number): TypingStep {
  const elapsed = now - run.startedAt;
  const turnSeen = run.turnSeen || turn === 'open';
  if (elapsed >= TYPING_MAX_MS) return { keep: false, turnSeen };
  if (turn === 'closed' && turnSeen) return { keep: false, turnSeen };
  if (!turnSeen && elapsed >= TYPING_NO_TURN_GRACE_MS) return { keep: false, turnSeen };
  return { keep: true, turnSeen };
}

/** What the hub's wake detection tells presence. */
export interface WakePresence {
  /** A message that will wake the agent was just seen. */
  ack(channelId: string, messageId: string): void;
  /** The agent's own bot posted in this channel. */
  agentPosted(channelId: string): void;
}

/** What the waker tells presence. `probe` reports whether the agent's Atlas turn is open. */
export interface TypingStarter {
  startTyping(channelId: string, probe: () => Promise<TurnState>): void;
}

/** The two Discord calls presence makes, as the agent's own bot. */
export interface AgentBotApi {
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  typing(channelId: string): Promise<void>;
}

export function createAgentBotApi(token: string): AgentBotApi {
  const rest = new REST({ version: '10' }).setToken(token);
  return {
    async react(channelId, messageId, emoji) {
      await rest.put(Routes.channelMessageOwnReaction(channelId, messageId, encodeURIComponent(emoji)));
    },
    async typing(channelId) {
      await rest.post(Routes.channelTyping(channelId));
    },
  };
}

interface KeeperRun extends TypingRun {
  probe: () => Promise<TurnState>;
  handle?: unknown;
}

const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** One typing loop per channel: types at once, then every `TYPING_REFRESH_MS` while `nextTypingStep` keeps it. */
export class TypingKeeper implements TypingStarter {
  readonly #runs = new Map<string, KeeperRun>();

  constructor(
    private readonly send: (channelId: string) => Promise<void>,
    private readonly scheduler: Scheduler = realScheduler,
  ) {}

  startTyping(channelId: string, probe: () => Promise<TurnState>): void {
    const existing = this.#runs.get(channelId);
    if (existing) {
      // Another wake for a channel already typing: same loop, fresh clock and probe.
      existing.startedAt = this.scheduler.now();
      existing.probe = probe;
      return;
    }
    const run: KeeperRun = { startedAt: this.scheduler.now(), turnSeen: false, probe };
    this.#runs.set(channelId, run);
    void this.#beat(channelId, run, true);
  }

  stop(channelId: string): void {
    const run = this.#runs.get(channelId);
    if (!run) return;
    this.#runs.delete(channelId);
    if (run.handle !== undefined) this.scheduler.clear(run.handle);
  }

  stopAll(): void {
    for (const channelId of [...this.#runs.keys()]) this.stop(channelId);
  }

  /** Channels currently typing in. */
  get active(): string[] {
    return [...this.#runs.keys()];
  }

  async #beat(channelId: string, run: KeeperRun, first: boolean): Promise<void> {
    run.handle = undefined;
    if (!first) {
      const turn = await run.probe().catch((err: unknown): TurnState => {
        logError(`typing probe channel=${channelId}`, err);
        return 'unknown';
      });
      if (this.#runs.get(channelId) !== run) return; // stopped while probing
      const step = nextTypingStep(run, turn, this.scheduler.now());
      run.turnSeen = step.turnSeen;
      if (!step.keep) {
        this.#runs.delete(channelId);
        return;
      }
    }
    try {
      await this.send(channelId);
    } catch (err) {
      logError(`typing failed channel=${channelId}`, err);
    }
    if (this.#runs.get(channelId) !== run) return;
    run.handle = this.scheduler.set(() => void this.#beat(channelId, run, false), TYPING_REFRESH_MS);
  }
}

/** Presence as Josh's agent bot: reactions and typing, every failure logged and ignored. */
export class AgentPresence implements WakePresence, TypingStarter {
  readonly #keeper: TypingKeeper;

  constructor(private readonly api: AgentBotApi, keeper?: TypingKeeper) {
    this.#keeper = keeper ?? new TypingKeeper((channelId) => api.typing(channelId));
  }

  ack(channelId: string, messageId: string): void {
    this.api.react(channelId, messageId, ACK_EMOJI).then(
      () => log(`ack ${ACK_EMOJI} channel=${channelId} message=${messageId}`),
      (err: unknown) => logError(`ack reaction failed channel=${channelId} message=${messageId}`, err),
    );
  }

  agentPosted(channelId: string): void {
    this.#keeper.stop(channelId);
  }

  startTyping(channelId: string, probe: () => Promise<TurnState>): void {
    this.#keeper.startTyping(channelId, probe);
  }

  stop(): void {
    this.#keeper.stopAll();
  }
}
