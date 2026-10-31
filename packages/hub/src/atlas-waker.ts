/**
 * Wakes Josh's agent (an Atlas chat) for Backchannel messages aimed at it: one Atlas chat per
 * Discord channel (forum post, thread or channel), opened on the first wake and messaged after.
 */
import { firstBrief, followUp, type BriefContext } from './atlas-brief.ts';
import type { AtlasChats } from './atlas-device.ts';
import type { AtlasChat, AtlasStore } from './atlas-store.ts';
import { log, logError } from './log.ts';
import { TIMED_OUT, withTimeout } from './timeout.ts';
import type { WakeEvent, Waker } from './waker.ts';

export interface AtlasWakerOptions extends BriefContext {
  store: AtlasStore;
  chats: AtlasChats;
  /** Working directory of every chat this opens. */
  cwd: string;
  now?: () => number;
  newRequestId?: () => string;
}

/** At most one spawn per channel in this window. */
export const SPAWN_INTERVAL_MS = 10 * 60_000;
/** At most `MAX_WAKES_PER_HOUR` spawns and deliveries, across all channels, per sliding hour. */
export const MAX_WAKES_PER_HOUR = 20;
const HOUR_MS = 60 * 60_000;
/**
 * How long one wake waits for a spawn before moving on. The spawn itself keeps going and still
 * maps the channel if it lands; until it settles, later wakes for that channel are dropped
 * rather than opening a second chat.
 */
export const SPAWN_WAIT_MS = 3 * 60_000;
/**
 * A spawn still pending after this is treated as stuck and no longer blocks a new one. Well
 * past every timeout inside a spawn, and past the machine's 15 min reaping of a run nobody
 * handshook.
 */
export const SPAWN_STUCK_MS = 30 * 60_000;

export type WakeDecision =
  | { kind: 'deliver' }
  | { kind: 'spawn' }
  | { kind: 'drop'; why: string };

/**
 * The limits, as a pure decision over the store. Exported for tests.
 */
export function decideWake(store: AtlasStore, channelId: string, now: number): WakeDecision {
  if (store.wakesSince(now - HOUR_MS) >= MAX_WAKES_PER_HOUR) {
    return { kind: 'drop', why: `hourly limit of ${MAX_WAKES_PER_HOUR} wakes reached` };
  }
  if (store.chat(channelId)) return { kind: 'deliver' };
  if (store.hasPendingSpawn(channelId, now - SPAWN_STUCK_MS)) {
    return { kind: 'drop', why: 'a spawn for this channel has not settled' };
  }
  const last = store.lastSpawnAt(channelId);
  if (last !== undefined && now - last < SPAWN_INTERVAL_MS) {
    return { kind: 'drop', why: `spawned ${Math.round((now - last) / 1000)}s ago, limit is one per ${SPAWN_INTERVAL_MS / 60_000} min` };
  }
  return { kind: 'spawn' };
}

export class AtlasWaker implements Waker {
  readonly #options: AtlasWakerOptions;
  readonly #now: () => number;
  readonly #newRequestId: () => string;
  /** One wake at a time per channel, so a second wake sees the first one's mapping. */
  readonly #chains = new Map<string, Promise<void>>();

  constructor(options: AtlasWakerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#newRequestId = options.newRequestId ?? (() => crypto.randomUUID());
    const abandoned = options.store.abandonPendingSpawns();
    if (abandoned > 0) log(`atlas wake: marked ${abandoned} spawn(s) from a previous run as failed`);
  }

  wake(event: WakeEvent): Promise<void> {
    const previous = this.#chains.get(event.channelId) ?? Promise.resolve();
    const next = previous.then(() => this.#wake(event));
    this.#chains.set(event.channelId, next);
    void next.finally(() => {
      if (this.#chains.get(event.channelId) === next) this.#chains.delete(event.channelId);
    });
    return next;
  }

  stop(): void {
    this.#options.chats.stop();
  }

  async #wake(event: WakeEvent): Promise<void> {
    const { store, chats } = this.#options;
    const now = this.#now();
    store.pruneWakes(now - 24 * HOUR_MS);
    const decision = decideWake(store, event.channelId, now);
    const tag = `channel=${event.channelId} messages=${event.messages.length}`;
    if (decision.kind === 'drop') {
      log(`atlas wake dropped ${tag}: ${decision.why}`);
      return;
    }

    try {
      if (decision.kind === 'deliver') {
        const chat = store.chat(event.channelId)!;
        store.recordWake(event.channelId, 'deliver', now);
        const outcome = await chats.deliver(chat, followUp(event, this.#options));
        log(`atlas wake ${outcome} ${tag} session=${chat.acpSessionId}`);
        return;
      }

      const requestId = this.#newRequestId();
      store.beginSpawn(requestId, event.channelId, now);
      store.recordWake(event.channelId, 'spawn', now);
      log(`atlas wake spawning ${tag} request=${requestId}`);
      const result = await withTimeout(this.#spawn(requestId, event), SPAWN_WAIT_MS);
      if (result === TIMED_OUT) log(`atlas wake still spawning after ${SPAWN_WAIT_MS / 1000}s request=${requestId}`);
    } catch (err) {
      logError(`atlas wake failed ${tag}`, err);
    }
  }

  /** One spawn attempt, settled in the store under its own request id whenever it finishes. */
  async #spawn(requestId: string, event: WakeEvent): Promise<void> {
    const { store, chats, cwd } = this.#options;
    let chat: AtlasChat;
    try {
      chat = { channelId: event.channelId, ...(await chats.spawn(cwd, requestId)) };
    } catch (err) {
      store.failSpawn(requestId, err instanceof Error ? err.message : String(err));
      logError(`atlas wake spawn failed channel=${event.channelId} request=${requestId}`, err);
      return;
    }
    if (!store.finishSpawn(requestId, chat, this.#now())) {
      log(
        `atlas wake: spawn request=${requestId} opened session=${chat.acpSessionId} but the channel is already mapped; not prompting it`,
      );
      return;
    }
    // Mapped before the prompt goes out: whatever happens to the prompt, the next wake for
    // this channel messages this chat instead of opening another.
    try {
      const outcome = await chats.deliver(chat, firstBrief(event, this.#options));
      log(`atlas wake spawned+${outcome} channel=${event.channelId} request=${requestId} session=${chat.acpSessionId}`);
    } catch (err) {
      logError(`atlas wake first prompt failed channel=${event.channelId} session=${chat.acpSessionId}`, err);
    }
  }
}
