import { isRestricted, strongestReason } from '@backchannel/core';
import type { ChannelMessage, WakeEvent } from './waker.ts';

/**
 * UKSBS never reaches Josh's agent through Backchannel (restricted.ts in core is the list). A
 * message that names it is dropped before it can wake or brief a chat, so the agent never reads it
 * and nothing about it is classified. Applies to everyone, Josh included.
 */
export function isVisible(message: ChannelMessage): boolean {
  if (isRestricted(message.content) || isRestricted(message.authorName)) return false;
  // A reply quotes the message it answers; a reply to restricted text is restricted too.
  if (message.replyTo && (isRestricted(message.replyTo.text) || isRestricted(message.replyTo.authorName))) return false;
  return true;
}

export function visibleMessages<T extends ChannelMessage>(messages: readonly T[]): T[] {
  return messages.filter(isVisible);
}

/**
 * The batch without restricted messages, or `undefined` when nothing is left (or the place itself
 * is named after UKSBS). The top-level fields follow the newest message that is left, and the
 * reason is the strongest among those, so a dropped ping cannot leave "mentioned you" behind.
 */
export function withoutRestricted(event: WakeEvent): WakeEvent | undefined {
  if ([event.postTitle, event.forumName, event.channelName].some((name) => name !== undefined && isRestricted(name))) {
    return undefined;
  }
  const messages = visibleMessages(event.messages);
  const newest = messages.at(-1);
  if (!newest) return undefined;
  if (messages.length === event.messages.length) return event;
  return {
    ...event,
    ...newest,
    reason: strongestReason(messages.map((message) => message.reason)),
    messages,
  };
}
