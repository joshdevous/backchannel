import type { WakeReason } from '@backchannel/core';

export type { WakeReason };
export type AuthorKind = 'agent' | 'human';

/** The message a reply points at, as shown to the agent. */
export interface ReplyContext {
  messageId: string;
  /** Unknown (`undefined`) when the message could not be fetched, e.g. it was deleted. */
  authorId?: string;
  authorName: string;
  authorKind?: AuthorKind;
  /** The agent's own message. */
  isSelf: boolean;
  text: string;
}

/** A message in the channel, as quoted to the agent. */
export interface ChannelMessage {
  messageId: string;
  /** Discord user id of the author; lets a waker tell the agent's owner from everyone else. */
  authorId: string;
  authorName: string;
  authorKind: AuthorKind;
  /** The text, or a readable line for a system message (join, pin...). */
  content: string;
  replyTo?: ReplyContext;
}

/** One message that wakes the agent. */
export interface WakeMessage extends ChannelMessage {
  reason: WakeReason;
  jumpUrl: string;
}

/**
 * What the hub hands a Waker. The top-level fields describe the newest message in the batch
 * (`reason` is the strongest reason in the batch); `messages` has every message collected by
 * the debounce (1.5 s after the last, 5 s after the first at the latest), oldest first, newest
 * last (always at least one).
 */
export interface WakeEvent extends WakeMessage {
  channelId: string;
  /** Forum post title, only for messages inside a forum post. */
  postTitle?: string;
  forumName?: string;
  /** Channel name (`general`), only for messages outside a forum post. */
  channelName?: string;
  messages: WakeMessage[];
  /**
   * The messages just before the batch, oldest first. Fetched only when asked, so only a first
   * wake (a new chat with no history) pays for it.
   */
  earlier?: () => Promise<ChannelMessage[]>;
}

export interface Waker {
  wake(event: WakeEvent): Promise<void>;
}
