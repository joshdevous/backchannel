import { STARBOARD_CHANNEL } from './constants.ts';

/**
 * What wakes an agent, shared by the hub (Josh's Atlas agent) and push mode (Claude Code) so
 * both apply the same rules. See docs/design.md "Wake-ups".
 */

/** Messages aimed at the agent: it was mentioned, replied to, or it started / claimed the post. */
export type DirectReason = 'mention' | 'reply' | 'started_post' | 'claimed_post';
/**
 * `ambient`: ordinary conversation the agent overhears in listen mode `all`. `star`: someone
 * starred a message, which the agent may want to look at (with what surrounds it) in case it
 * missed something funny.
 */
export type WakeReason = DirectReason | 'ambient' | 'star';

/** `all`: hear ordinary human conversation too. `mentions`: only direct triggers. */
export type ListenMode = 'all' | 'mentions';
export const LISTEN_MODES: readonly ListenMode[] = ['all', 'mentions'];
export const DEFAULT_LISTEN: ListenMode = 'all';

/** Higher wins when one batch holds messages with different reasons. Direct always beats ambient. */
const REASON_STRENGTH: Record<WakeReason, number> = {
  mention: 5,
  reply: 4,
  claimed_post: 3,
  started_post: 2,
  ambient: 1,
  star: 0,
};

export function isDirect(reason: WakeReason): reason is DirectReason {
  return reason !== 'ambient' && reason !== 'star';
}

/** The strongest reason present. `reasons` must not be empty. */
export function strongestReason(reasons: readonly WakeReason[]): WakeReason {
  return reasons.reduce((best, r) => (REASON_STRENGTH[r] > REASON_STRENGTH[best] ? r : best));
}

/** Parses a listen setting; empty means the default. Throws a readable error naming `source`. */
export function parseListenMode(value: string | undefined, source: string): ListenMode {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed) return DEFAULT_LISTEN;
  if ((LISTEN_MODES as readonly string[]).includes(trimmed)) return trimmed as ListenMode;
  throw new Error(`${source} must be one of ${LISTEN_MODES.join(', ')} (got "${value}")`);
}

/** Discord message types that are someone talking; everything else is a system notice. */
export const MESSAGE_TYPE_DEFAULT = 0;
export const MESSAGE_TYPE_REPLY = 19;
const SPOKEN_TYPES = new Set([MESSAGE_TYPE_DEFAULT, MESSAGE_TYPE_REPLY]);
/** Slash-command and context-menu responses: an app speaking, with real content. */
const APP_TYPES = new Set([20, 23]);

export interface AmbientInput {
  /** A bot, a webhook, or a member of the Agent role. */
  fromBot: boolean;
  /** Discord message type. */
  type: number;
  /** `text`: a guild text channel. `forum_post`: a thread in a forum. `other`: anything else. */
  where: 'text' | 'forum_post' | 'other';
  /** Base name of the channel (`starboard`, not `⭐・starboard`). */
  channelName: string;
}

/**
 * Whether a message counts as ordinary conversation an agent may overhear: a person (never a
 * bot, so two listening agents cannot keep waking each other) talking in a text channel or forum
 * post, outside #starboard, and not a system notice (join, pin, thread created...).
 */
export function isAmbient(input: AmbientInput): boolean {
  return (
    !input.fromBot &&
    SPOKEN_TYPES.has(input.type) &&
    input.where !== 'other' &&
    input.channelName.toLowerCase() !== STARBOARD_CHANNEL
  );
}

/** Folds a direct reason (or none) and ambient eligibility into the wake reason under `mode`. */
export function decideWakeReason(direct: DirectReason | null, ambient: boolean, mode: ListenMode): WakeReason | null {
  if (direct) return direct;
  return mode === 'all' && ambient ? 'ambient' : null;
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
 * hub's own messages (the starboard), never for system notices or messages in #starboard. Push
 * mode has no hub to know: it passes `hubId` undefined and #starboard is excluded by name.
 */
export function starWakeReason(input: StarInput, targetId: string, hubId: string | undefined, listen: ListenMode): WakeReason | null {
  if (listen !== 'all') return null;
  if (input.starrerId === targetId || input.starrerId === hubId || input.authorId === hubId) return null;
  if (input.starredByTarget) return null;
  return isAmbient({ ...input.ambient, fromBot: false }) ? 'star' : null;
}

/** What an agent is told about an overheard (ambient) wake: usually, do nothing. */
export const AMBIENT_NOTE =
  'Nobody asked you directly. Reply only if you have something genuinely useful to add, you were part of this conversation, or it is clearly meant for you; otherwise do nothing and do not post.';

/** What an agent is told when a message was starred: look at it, and say nothing unless there is something to add. */
export const STAR_NOTE =
  'Nobody asked you anything. Use `read` on the channel to see the starred message and the ones around it. If it is a funny or playful one you missed or were not part of, star it too if you like it. Post only if you have something genuinely worth adding; otherwise do nothing.';

/** Longest quoted text of a replied-to message. */
export const REPLY_TEXT_MAX = 200;

/** One line, at most `max` chars: newlines folded so quoted text cannot pose as a new line. */
export function shortText(text: string, max = REPLY_TEXT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** `(replying to Sam's message 123: "...")`; `author` "you" reads as "your message". */
export function replyLine(reply: { id: string; author: string; text: string }): string {
  const whose = reply.author === 'you' ? 'your' : `${reply.author}'s`;
  return `(replying to ${whose} message ${reply.id}: ${JSON.stringify(shortText(reply.text))})`;
}

/**
 * A readable line for a Discord system message (join, pin, boost...), or undefined for a
 * message someone actually wrote. `content` is the raw content (a thread name, a new channel name).
 */
export function systemText(type: number, author: string, content: string): string | undefined {
  if (SPOKEN_TYPES.has(type) || APP_TYPES.has(type)) return undefined;
  switch (type) {
    case 7:
      return `${author} joined the server`;
    case 6:
      return `${author} pinned a message`;
    case 18:
      return `${author} started a thread${content ? `: ${content}` : ''}`;
    case 4:
      return `${author} renamed the channel${content ? ` to ${content}` : ''}`;
    case 8:
    case 9:
    case 10:
    case 11:
      return `${author} boosted the server`;
    case 12:
      return `${author} followed a channel into this one`;
    case 21:
      return 'thread starter message (the post\'s first message)';
    case 46:
      return 'a poll ended';
    default:
      return `system message from ${author} (Discord message type ${type})`;
  }
}
