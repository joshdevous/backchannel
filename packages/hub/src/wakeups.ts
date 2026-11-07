import {
  AGENT_ROLE,
  STAR_EMOJI,
  baseName,
  decideWakeReason,
  isAmbient,
  isClaimMarker,
  isDirect,
  isReleaseMarker,
  MESSAGE_TYPE_REPLY,
  resolveClaim,
  shortText,
  strongestReason,
  systemText,
  type AmbientInput,
  type DirectReason,
  type ListenMode,
} from '@backchannel/core';
import { ChannelType, type Client, type Message, type ThreadChannel } from 'discord.js';
import { log, logError } from './log.ts';
import type { AuthorKind, ChannelMessage, ReplyContext, WakeEvent, WakeMessage, WakeReason, Waker } from './waker.ts';
import type { WakePresence } from './presence.ts';

/** A batch is sent this long after the last message in its channel... */
export const WAKE_QUIET_MS = 1_500;
/** ...but never later than this after the first, so a chatty post cannot postpone it forever. */
export const WAKE_MAX_MS = 5_000;

export interface WakeInput {
  authorId: string;
  mentionedUserIds: readonly string[];
  /** Author of the message this one replies to, if known. */
  repliedToAuthorId?: string | null;
  /** Only set for messages inside a forum post. */
  post?: { starterAuthorId: string | null; claimantId: string | null };
  /** What listen mode `all` needs to know (`isAmbient` in core). */
  ambient: AmbientInput;
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

/** Whether a message is aimed at `targetId` (mention, reply, its post). */
export function directReason(input: WakeInput, targetId: string): DirectReason | null {
  // A reply to the target usually also pings it, so check replies first.
  if (input.repliedToAuthorId === targetId) return 'reply';
  if (input.mentionedUserIds.includes(targetId)) return 'mention';
  if (input.post?.claimantId === targetId) return 'claimed_post';
  if (input.post?.starterAuthorId === targetId) return 'started_post';
  return null;
}

/**
 * Whether and why a message wakes `targetId` under listen mode `listen`. Pure; ignores the
 * target's and the hub's own messages. Direct triggers wake in both modes (bots included);
 * in mode `all` ordinary human conversation wakes too, as `ambient`.
 */
export function wakeReason(input: WakeInput, targetId: string, hubId: string, listen: ListenMode): WakeReason | null {
  if (input.authorId === targetId || input.authorId === hubId) return null;
  return decideWakeReason(directReason(input, targetId), isAmbient(input.ambient), listen);
}

export interface StarInput {
  /** Who added the star. */
  starrerId: string;
  /** Who wrote the starred message. */
  authorId: string;
  /** Whether `targetId` has already starred it: nothing left for it to look at. */
  starredByTarget: boolean;
  /** Where the starred message sits; `fromBot` is ignored (an agent's message can be funny too). */
  ambient: AmbientInput;
}

/**
 * Whether a new star on a message wakes `targetId` as `star`. Only in listen mode `all`, like
 * ordinary overheard conversation. Never for the target's own star or the hub's, never for the
 * hub's own messages (the starboard), never for system notices or messages in #starboard.
 */
export function starWakeReason(input: StarInput, targetId: string, hubId: string, listen: ListenMode): WakeReason | null {
  if (listen !== 'all') return null;
  if (input.starrerId === targetId || input.starrerId === hubId || input.authorId === hubId) return null;
  if (input.starredByTarget) return null;
  return isAmbient({ ...input.ambient, fromBot: false }) ? 'star' : null;
}

export function isMarker(content: string): boolean {
  return isClaimMarker(content) || isReleaseMarker(content);
}

/** Where a batch was posted, beyond its channel id. */
export type WakeMeta = Pick<WakeEvent, 'postTitle' | 'forumName' | 'channelName'>;

/** Folds the messages collected for one channel into the single event handed to the Waker. */
export function mergeWakeMessages(
  channelId: string,
  meta: WakeMeta,
  messages: readonly WakeMessage[],
): WakeEvent {
  const newest = messages[messages.length - 1];
  if (!newest) throw new Error('mergeWakeMessages needs at least one message');
  const reason = strongestReason(messages.map((m) => m.reason));
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

function agentRoleIdOf(message: Message<true>): string | undefined {
  return message.guild.roles.cache.find((r) => r.name === AGENT_ROLE)?.id;
}

function nameOf(message: Message): string {
  return message.member?.displayName ?? message.author.displayName;
}

/** What the agent is shown as a message's text: the content, or a line for a system notice. */
function shownContent(message: Message): string {
  return systemText(message.type, nameOf(message), message.content) ?? message.content;
}

/** The message a reply points at; fetched when the gateway did not embed it. Undefined for non-replies. */
async function replyContext(message: Message<true>, targetId: string, agentRoleId: string | undefined): Promise<ReplyContext | undefined> {
  const id = message.reference?.messageId;
  if (message.type !== MESSAGE_TYPE_REPLY || !id) return undefined;
  const ref = await message.fetchReference().catch(() => null);
  if (!ref) return { messageId: id, authorName: 'someone', isSelf: false, text: '(message not available, maybe deleted)' };
  return {
    messageId: ref.id,
    authorId: ref.author.id,
    authorName: nameOf(ref),
    authorKind: authorKind(ref, agentRoleId),
    isSelf: ref.author.id === targetId,
    text: shortText(shownContent(ref)),
  };
}

/** Earlier messages kept short: the agent gets the gist, and `read` has the rest. */
const EARLIER_TEXT_MAX = 300;
/** How many messages before a first wake are quoted as context. */
export const EARLIER_MESSAGES = 10;

async function fetchEarlier(client: Client<true>, channelId: string, beforeId: string, targetId: string): Promise<ChannelMessage[]> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !('guild' in channel)) return [];
  const fetched = await channel.messages.fetch({ before: beforeId, limit: EARLIER_MESSAGES });
  const messages = [...fetched.values()].filter((m): m is Message<true> => m.inGuild()).reverse();
  const agentRoleId = messages[0] ? agentRoleIdOf(messages[0]) : undefined;
  return Promise.all(
    messages.map(async (m) => ({
      messageId: m.id,
      authorId: m.author.id,
      authorName: nameOf(m),
      authorKind: authorKind(m, agentRoleId),
      content: shortText(shownContent(m), EARLIER_TEXT_MAX),
      replyTo: await replyContext(m, targetId, agentRoleId),
    })),
  );
}

export interface WakeDetector {
  /** Sends every still-pending batch now. Used at shutdown. */
  flush(): Promise<void>;
}

/**
 * Hooks MessageCreate/MessageDelete and forwards debounced wake events to `waker`. `presence`
 * (optional) reacts to each directly triggering message at once and hears when the agent speaks.
 */
export function startWakeDetection(
  client: Client<true>,
  targetId: string,
  waker: Waker,
  listen: ListenMode,
  presence?: WakePresence,
): WakeDetector {
  const claimants = new ClaimantCache();
  const meta = new Map<string, WakeMeta>();
  const hubId = client.user.id;

  const debouncer = new Debouncer<WakeMessage>(WAKE_QUIET_MS, WAKE_MAX_MS, async (channelId, messages) => {
    const event: WakeEvent = {
      ...mergeWakeMessages(channelId, meta.get(channelId) ?? {}, messages),
      earlier: () => fetchEarlier(client, channelId, messages[0]!.messageId, targetId),
    };
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

      const agentRoleId = agentRoleIdOf(message);
      const kind = authorKind(message, agentRoleId);
      const replyTo = await replyContext(message, targetId, agentRoleId);
      const input: WakeInput = {
        authorId: message.author.id,
        mentionedUserIds: [...message.mentions.users.keys()],
        repliedToAuthorId: replyTo?.authorId ?? message.mentions.repliedUser?.id ?? null,
        post: thread ? { starterAuthorId: thread.ownerId, claimantId: null } : undefined,
        ambient: {
          fromBot: kind === 'agent',
          type: message.type,
          where: thread ? 'forum_post' : channel.type === ChannelType.GuildText ? 'text' : 'other',
          channelName: baseName(channel.name),
        },
      };
      if (thread && input.post && needsClaimantLookup(input, targetId)) {
        input.post.claimantId = await claimants.get(thread);
      }

      const reason = wakeReason(input, targetId, hubId, listen);
      if (!reason) return;

      const entry: WakeMessage = {
        reason,
        messageId: message.id,
        authorId: message.author.id,
        authorName: nameOf(message),
        authorKind: kind,
        content: shownContent(message),
        jumpUrl: message.url,
        replyTo,
      };
      meta.set(
        message.channelId,
        thread ? { postTitle: thread.name, forumName: thread.parent?.name } : { channelName: channel.name },
      );
      // 👀 only when someone actually asked; an overheard message may well get no answer.
      if (isDirect(reason)) presence?.ack(message.channelId, message.id);
      debouncer.add(message.channelId, entry);
      log(`wake queued channel=${message.channelId} message=${message.id} reason=${reason}`);
    } catch (err) {
      logError('wake detection failed', err);
    }
  });

  // A new star on a message: tell the agent, so it can look at the message and what surrounds it.
  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (reaction.emoji.name !== STAR_EMOJI) return;
      if (user.id === targetId || user.id === hubId) return;
      const full = reaction.partial ? await reaction.fetch() : reaction;
      const message = full.message.partial ? await full.message.fetch() : full.message;
      if (!message.inGuild()) return;

      const channel = message.channel;
      const thread = channel.isThread() && channel.parent?.type === ChannelType.GuildForum ? channel : null;
      const starrers = await full.users.fetch({ limit: 100 });
      const reason = starWakeReason(
        {
          starrerId: user.id,
          authorId: message.author.id,
          starredByTarget: starrers.has(targetId),
          ambient: {
            fromBot: false,
            type: message.type,
            where: thread ? 'forum_post' : channel.type === ChannelType.GuildText ? 'text' : 'other',
            channelName: baseName(channel.name),
          },
        },
        targetId,
        hubId,
        listen,
      );
      if (!reason) return;

      const agentRoleId = agentRoleIdOf(message);
      const starrer = message.guild.members.cache.get(user.id)?.displayName ?? (user.partial ? await user.fetch() : user).displayName;
      const entry: WakeMessage = {
        reason,
        messageId: message.id,
        authorId: message.author.id,
        authorName: nameOf(message),
        authorKind: authorKind(message, agentRoleId),
        content: shownContent(message),
        jumpUrl: message.url,
        replyTo: await replyContext(message, targetId, agentRoleId),
        star: { byId: user.id, byName: starrer, count: full.count ?? starrers.size },
      };
      meta.set(
        message.channelId,
        thread ? { postTitle: thread.name, forumName: thread.parent?.name } : { channelName: channel.name },
      );
      debouncer.add(message.channelId, entry);
      log(`wake queued channel=${message.channelId} message=${message.id} reason=${reason} by=${user.id}`);
    } catch (err) {
      logError('star wake detection failed', err);
    }
  });

  return { flush: () => debouncer.flushAll() };
}
