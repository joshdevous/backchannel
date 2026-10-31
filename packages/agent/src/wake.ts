/** Why a message is worth this agent's attention. Shared by `inbox` and push mode so both agree. */
export type WakeReason = 'mention' | 'reply' | 'started_post' | 'claimed_post';

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

export function wakeReason(input: WakeInput, meId: string, claimedPosts: readonly string[]): WakeReason | null {
  if (input.authorId === meId) return null;
  if (input.mentionIds.includes(meId)) return 'mention';
  if (input.replyToAuthorId === meId) return 'reply';
  if (input.threadOwnerId === meId) return 'started_post';
  if (claimedPosts.includes(input.channelId)) return 'claimed_post';
  return null;
}
