import { AGENT_ROLE, isClaimMarker, isReleaseMarker, resolveClaim } from '@backchannel/core';
import { ChannelType, type Client, type Message, type ThreadChannel } from 'discord.js';
import { log, logError } from './log.ts';
import type { AuthorKind, WakeEvent, WakeMessage, WakeReason, Waker } from './waker.ts';
import type { WakePresence } from './presence.ts';

/** A batch is sent this long after the last message in its channel... */
export const WAKE_QUIET_MS = 1_500;
/** ...but never later than this after the first, so a chatty post cannot postpone it forever. */
export const WAKE_MAX_MS = 5_000;

/** Higher wins when several messages in one batch have different reasons. */
const REASON_STRENGTH: Record<WakeReason, number> = {
  mention: 4,
  reply: 3,
  'claimed-post': 2,
  'own-post': 1,
};

export interface WakeInput {
  authorId: string;
  mentionedUserIds: readonly string[];
  /** Author of the message this one replies to, if known. */
  repliedToAuthorId?: string | null;
  /** Only set for messages inside a forum post. */
  post?: { starterAuthorId: string | null; claimantId: string | null };
}

/** True when the claimant is worth a (possibly expensive) lookup. */
export function needsClaimantLookup(input: WakeInput, targetId: string): boolean {
  return (
    input.post !== undefined &&
    input.post.starterAuthorId !== targetId &&
    !input.mentionedUserIds.includes(targetId) &&
    input.repliedToAuthorId !== targetId
  );
}

/** Decides whether a message is aimed at `targetId`. Pure; ignores the target and the hub. */
export function wakeReason(input: WakeInput, targetId: string, hubId: string): WakeReason | null {
  if (input.authorId === targetId || input.authorId === hubId) return null;
  // A reply to the target usually also pings it, so check replies first.
  if (input.repliedToAuthorId === targetId) return 'reply';
  if (input.mentionedUserIds.includes(targetId)) return 'mention';
  if (input.post?.claimantId === targetId) return 'claimed-post';
  if (input.post?.starterAuthorId === targetId) return 'own-post';
  return null;
}

export function isMarker(content: string): boolean {
  return isClaimMarker(content) || isReleaseMarker(content);
}

/** Folds the messages collected for one channel into the single event handed to the Waker. */
export function mergeWakeMessages(
  channelId: string,
  meta: { postTitle?: string; forumName?: string },
  messages: readonly WakeMessage[],
): WakeEvent {
  const newest = messages[messages.length - 1];
  if (!newest) throw new Error('mergeWakeMessages needs at least one message');
  let reason = newest.reason;
  for (const m of messages) if (REASON_STRENGTH[m.reason] > REASON_STRENGTH[reason]) reason = m.reason;
  return { ...newest, reason, channelId, ...meta, messages: [...messages] };
}

export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
  now(): number;
}

const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * How long to wait after an item arrives: `quietMs` from now, but not past `maxMs` after the
 * first item of the batch. Pure; the Debouncer reschedules with it on every item.
 */
export function debounceDelay(firstAt: number, now: number, quietMs: number, maxMs: number): number {
  return Math.max(0, Math.min(quietMs, firstAt + maxMs - now));
}

/**
 * Collects items per key and flushes them together once the key has been quiet for `quietMs`
 * (a trailing debounce), or `maxMs` after its first item at the latest.
 */
export class Debouncer<T> {
  private readonly pending = new Map<string, { items: T[]; firstAt: number; handle: unknown }>();

  constructor(
    private readonly quietMs: number,
    private readonly maxMs: number,
    private readonly onFlush: (key: string, items: T[]) => Promise<void> | void,
    private readonly scheduler: Scheduler = realScheduler,
  ) {}

  add(key: string, item: T): void {
    const now = this.scheduler.now();
    const entry = this.pending.get(key);
    if (entry) {
      entry.items.push(item);
      this.scheduler.clear(entry.handle);
      entry.handle = this.scheduler.set(() => void this.flush(key), debounceDelay(entry.firstAt, now, this.quietMs, this.maxMs));
      return;
    }
    const handle = this.scheduler.set(() => void this.flush(key), debounceDelay(now, now, this.quietMs, this.maxMs));
    this.pending.set(key, { items: [item], firstAt: now, handle });
  }

  async flush(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    this.scheduler.clear(entry.handle);
    await this.onFlush(key, entry.items);
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((k) => this.flush(k)));
  }
}

/** Per-thread claimant cache: one history fetch, then invalidated by marker traffic. */
class ClaimantCache {
  private readonly cache = new Map<string, string | null>();

  async get(thread: ThreadChannel): Promise<string | null> {
    if (this.cache.has(thread.id)) return this.cache.get(thread.id) ?? null;
    const fetched = await thread.messages.fetch({ limit: 100 });
    // Only bot-written markers count, so a human typing the marker text cannot claim for an agent.
    const claimant =
      resolveClaim(
        [...fetched.values()]
          .filter((m) => m.author.bot)
          .map((m) => ({ id: m.id, authorId: m.author.id, authorName: m.author.username, content: m.content })),
      ).holder?.authorId ?? null;
    this.cache.set(thread.id, claimant);
    return claimant;
  }

  invalidate(threadId: string): void {
    this.cache.delete(threadId);
  }
}

function authorKind(message: Message, agentRoleId: string | undefined): AuthorKind {
  if (message.author.bot) return 'agent';
  if (agentRoleId && message.member?.roles.cache.has(agentRoleId)) return 'agent';
  return 'human';
}

export interface WakeDetector {
  /** Sends every still-pending batch now. Used at shutdown. */
  flush(): Promise<void>;
}

/**
 * Hooks MessageCreate/MessageDelete and forwards debounced wake events to `waker`. `presence`
 * (optional) reacts to each triggering message at once and hears when the agent speaks.
 */
export function startWakeDetection(
  client: Client<true>,
  targetId: string,
  waker: Waker,
  presence?: WakePresence,
): WakeDetector {
  const claimants = new ClaimantCache();
  const meta = new Map<string, { postTitle?: string; forumName?: string }>();
  const hubId = client.user.id;

  const debouncer = new Debouncer<WakeMessage>(WAKE_QUIET_MS, WAKE_MAX_MS, async (channelId, messages) => {
    const event = mergeWakeMessages(channelId, meta.get(channelId) ?? {}, messages);
    meta.delete(channelId);
    try {
      await waker.wake(event);
      log(`wake sent channel=${channelId} messages=${messages.length} reason=${event.reason}`);
    } catch (err) {
      logError(`wake failed channel=${channelId}`, err);
    }
  });

  // A deleted marker (a lost claim race) can change who holds the claim.
  client.on('messageDelete', (message) => {
    claimants.invalidate(message.channelId);
  });

  client.on('messageCreate', async (message) => {
    try {
      if (!message.inGuild()) return;
      if (message.author.id === targetId) presence?.agentPosted(message.channelId);
      if (message.author.id === targetId || message.author.id === hubId) return;

      const channel = message.channel;
      const thread = channel.isThread() && channel.parent?.type === ChannelType.GuildForum ? channel : null;
      if (thread && isMarker(message.content)) claimants.invalidate(thread.id);

      let repliedToAuthorId: string | null = message.mentions.repliedUser?.id ?? null;
      if (!repliedToAuthorId && message.reference?.messageId) {
        // The gateway only embeds the referenced message sometimes.
        repliedToAuthorId = (await message.fetchReference().catch(() => null))?.author.id ?? null;
      }

      const input: WakeInput = {
        authorId: message.author.id,
        mentionedUserIds: [...message.mentions.users.keys()],
        repliedToAuthorId,
        post: thread ? { starterAuthorId: thread.ownerId, claimantId: null } : undefined,
      };
      if (thread && input.post && needsClaimantLookup(input, targetId)) {
        input.post.claimantId = await claimants.get(thread);
      }

      const reason = wakeReason(input, targetId, hubId);
      if (!reason) return;

      const agentRoleId = message.guild.roles.cache.find((r) => r.name === AGENT_ROLE)?.id;
      const entry: WakeMessage = {
        reason,
        messageId: message.id,
        authorId: message.author.id,
        authorName: message.member?.displayName ?? message.author.displayName,
        authorKind: authorKind(message, agentRoleId),
        content: message.content,
        jumpUrl: message.url,
      };
      if (thread) meta.set(thread.id, { postTitle: thread.name, forumName: thread.parent?.name });
      presence?.ack(message.channelId, message.id);
      debouncer.add(message.channelId, entry);
      log(`wake queued channel=${message.channelId} message=${message.id} reason=${reason}`);
    } catch (err) {
      logError('wake detection failed', err);
    }
  });

  return { flush: () => debouncer.flushAll() };
}
