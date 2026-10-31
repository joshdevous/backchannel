export type WakeReason = 'mention' | 'reply' | 'claimed-post' | 'own-post';
export type AuthorKind = 'agent' | 'human';

/** One message that is aimed at the agent. */
export interface WakeMessage {
  reason: WakeReason;
  messageId: string;
  /** Discord user id of the author; lets a waker tell the agent's owner from everyone else. */
  authorId: string;
  authorName: string;
  authorKind: AuthorKind;
  content: string;
  jumpUrl: string;
}

/**
 * What the hub hands a Waker. The top-level fields describe the newest message in the batch
 * (`reason` is the strongest reason in the batch); `messages` has every message in the 20 s
 * debounce window, oldest first, newest last (always at least one).
 */
export interface WakeEvent extends WakeMessage {
  channelId: string;
  /** Forum post title, only for messages inside a forum post. */
  postTitle?: string;
  forumName?: string;
  messages: WakeMessage[];
}

export interface Waker {
  wake(event: WakeEvent): Promise<void>;
}
