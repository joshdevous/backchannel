/**
 * "<bot> is typing…" while the agent works on a message that was pushed to it. A push event
 * marks its channel as owed an answer; the first tool call that covers that channel starts the
 * indicator, posting there or going 3 minutes without any tool call stops it. The rules live in
 * `TypingTracker` (pure); `TypingLoop` only adds a timer and the Discord call.
 */

/** A push event stays unanswered for this long; after it, tools no longer start typing for it. */
export const PUSH_WINDOW_MS = 10 * 60_000;
/** Typing stops after this long without any tool call. */
export const TYPING_IDLE_MS = 3 * 60_000;
/** Discord shows "typing…" for about 10 s per call; refresh a little before it lapses. */
export const TYPING_REFRESH_MS = 8_000;

export class TypingTracker {
  /** Channels with a push event not yet answered, by when the event came. */
  readonly #pushed = new Map<string, number>();
  /** Channels typing now, by the time of the last tool call. */
  readonly #active = new Map<string, number>();

  /** A push event arrived for `channelId`. */
  pushed(channelId: string, now: number): void {
    this.#pushed.set(channelId, now);
  }

  /** The agent posted in `channelId`: it no longer owes an answer there. */
  answered(channelId: string): void {
    this.#pushed.delete(channelId);
    this.#active.delete(channelId);
  }

  /**
   * A tool call happened, optionally covering `channelIds`. Keeps typing channels alive and
   * returns those that just started typing: covered, pushed within the window, not yet typing.
   */
  activity(now: number, channelIds: readonly string[] = []): string[] {
    this.#expire(now);
    for (const channelId of this.#active.keys()) this.#active.set(channelId, now);
    const started: string[] = [];
    for (const channelId of channelIds) {
      if (this.#active.has(channelId) || !this.#pushed.has(channelId)) continue;
      this.#active.set(channelId, now);
      started.push(channelId);
    }
    return started;
  }

  /** The channels to refresh typing in right now; drops those idle for too long. */
  tick(now: number): string[] {
    this.#expire(now);
    return [...this.#active.keys()];
  }

  get hasActive(): boolean {
    return this.#active.size > 0;
  }

  #expire(now: number): void {
    for (const [channelId, at] of this.#pushed) if (now - at >= PUSH_WINDOW_MS) this.#pushed.delete(channelId);
    for (const [channelId, at] of this.#active) if (now - at >= TYPING_IDLE_MS) this.#active.delete(channelId);
  }
}

/** What tools see: report activity (optionally covering channels), and report an answer. */
export interface ChannelTyping {
  activity(channelIds?: readonly string[]): void;
  answered(channelId: string): void;
}

export interface TypingTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const realTimers: TypingTimers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    // Never keep the MCP server alive just to type.
    handle.unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export class TypingLoop implements ChannelTyping {
  readonly #tracker = new TypingTracker();
  #handle: unknown;

  /** `send` posts one typing indicator; its failures are logged and ignored. */
  constructor(
    private readonly send: (channelId: string) => Promise<void>,
    private readonly timers: TypingTimers = realTimers,
  ) {}

  pushed(channelId: string): void {
    this.#tracker.pushed(channelId, this.timers.now());
  }

  answered(channelId: string): void {
    this.#tracker.answered(channelId);
    this.#settle();
  }

  activity(channelIds: readonly string[] = []): void {
    for (const channelId of this.#tracker.activity(this.timers.now(), channelIds)) this.#type(channelId);
    this.#settle();
  }

  #tick(): void {
    this.#handle = undefined;
    for (const channelId of this.#tracker.tick(this.timers.now())) this.#type(channelId);
    this.#settle();
  }

  /** Runs the refresh timer exactly while some channel is typing. */
  #settle(): void {
    const needed = this.#tracker.hasActive;
    if (needed && this.#handle === undefined) this.#handle = this.timers.set(() => this.#tick(), TYPING_REFRESH_MS);
    else if (!needed && this.#handle !== undefined) {
      this.timers.clear(this.#handle);
      this.#handle = undefined;
    }
  }

  #type(channelId: string): void {
    // `send` may throw before returning a promise (no config yet); both ways are only logged.
    (async () => this.send(channelId))().catch((error: unknown) => {
      console.error(`[backchannel] typing indicator failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
