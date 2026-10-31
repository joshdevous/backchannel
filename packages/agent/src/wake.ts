import { decideWakeReason, isAmbient, type AmbientInput, type DirectReason, type ListenMode, type WakeReason } from '@backchannel/core';

export type { DirectReason, WakeReason };

export interface WakeInput {
  authorId: string;
  channelId: string;
  /** User ids mentioned directly (not @everyone / role mentions). */
  mentionIds: readonly string[];
  /** Author of the message this one replies to, if any. */
  replyToAuthorId?: string;
  /** Owner (starter) of the thread the message is in, if it is in a thread. */
  threadOwnerId?: string;
}

/** Whether a message is aimed at this agent. Shared by `inbox` and push mode so both agree. */
export function directReason(input: WakeInput, meId: string, claimedPosts: readonly string[]): DirectReason | null {
  if (input.authorId === meId) return null;
  if (input.mentionIds.includes(meId)) return 'mention';
  if (input.replyToAuthorId === meId) return 'reply';
  if (input.threadOwnerId === meId) return 'started_post';
  if (claimedPosts.includes(input.channelId)) return 'claimed_post';
  return null;
}

/**
 * Whether and why push mode wakes the agent: direct triggers in both listen modes (bots
 * included), and in mode `all` also ordinary human conversation (`ambient`).
 */
export function pushReason(
  input: WakeInput & { ambient: AmbientInput },
  meId: string,
  claimedPosts: readonly string[],
  listen: ListenMode,
): WakeReason | null {
  if (input.authorId === meId) return null;
  return decideWakeReason(directReason(input, meId, claimedPosts), isAmbient(input.ambient), listen);
}
