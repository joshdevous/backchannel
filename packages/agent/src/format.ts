import type { APIMessage } from 'discord-api-types/v10';
import { MESSAGE_TYPE_REPLY, OVERFLOW_FILENAME, classifyAuthor, shortText, systemText, type FromKind } from '@backchannel/core';
import { displayName } from './discord.ts';

/** How a Discord message is shown to the agent. Every message carries `from_kind` (docs/design.md "Safety"). */
export interface FormattedMessage {
  id: string;
  author: string;
  author_id: string;
  from_kind: FromKind;
  time: string;
  /** What they wrote. Absent for system messages, which carry `system` instead. */
  content?: string;
  /** A Discord system notice (join, pin, thread created...), e.g. "Sam joined the server". */
  system?: string;
  /** The message this one replies to: what "this", "that one" or "above" in it usually means. */
  reply_to?: ReplyTo;
  attachments?: { name: string; url: string; size: number }[];
  reactions?: string;
  /** Set when `content` was replaced by the full text from the overflow attachment. */
  full_text_from_attachment?: true;
}

export interface ReplyTo {
  id: string;
  author?: string;
  author_id?: string;
  from_kind?: FromKind;
  /** Up to ~200 chars, on one line. */
  text: string;
}

/** Overflow attachments at most this big are fetched and shown inline. */
export const INLINE_ATTACHMENT_MAX = 100 * 1024;

/** `<@123>` -> `@name` using the message's own mention list, so the agent reads names, not ids. */
export function renderMentions(content: string, mentions: readonly { id: string; username: string; global_name?: string | null }[]): string {
  return content.replace(/<@!?(\d+)>/g, (whole, id: string) => {
    const user = mentions.find((m) => m.id === id);
    return user ? `@${displayName(user)}` : whole;
  });
}

export function reactionSummary(message: Pick<APIMessage, 'reactions'>): string | undefined {
  if (!message.reactions?.length) return undefined;
  return message.reactions.map((r) => `${r.emoji.id ? `:${r.emoji.name}:` : r.emoji.name}×${r.count}`).join(' ');
}

export function overflowAttachment(message: Pick<APIMessage, 'attachments'>) {
  return message.attachments.find((a) => a.filename === OVERFLOW_FILENAME && a.size <= INLINE_ATTACHMENT_MAX);
}

/** The replied-to message as shown to the agent; `null` means it was deleted or could not be fetched. */
export function replyTo(id: string, referenced: APIMessage | null, ownerId: string): ReplyTo {
  if (!referenced) return { id, text: '(message not available, maybe deleted)' };
  const author = displayName(referenced.author);
  const system = systemText(referenced.type, author, referenced.content);
  return {
    id,
    author,
    author_id: referenced.author.id,
    from_kind: classifyAuthor({ id: referenced.author.id, bot: referenced.author.bot }, ownerId),
    text: shortText(system ?? renderMentions(referenced.content, referenced.mentions)),
  };
}

/** The id a reply points at, or undefined for anything else (forwards and pins carry references too). */
export function replyTargetId(message: Pick<APIMessage, 'type' | 'message_reference'>): string | undefined {
  return message.type === MESSAGE_TYPE_REPLY ? message.message_reference?.message_id : undefined;
}

/**
 * `referenced`: the replied-to message when the caller looked it up (`null`: gone); else the
 * one Discord embedded in `referenced_message` is used.
 */
export function formatMessage(message: APIMessage, ownerId: string, fullText?: string, referenced?: APIMessage | null): FormattedMessage {
  const author = displayName(message.author);
  const formatted: FormattedMessage = {
    id: message.id,
    author,
    author_id: message.author.id,
    from_kind: classifyAuthor({ id: message.author.id, bot: message.author.bot }, ownerId),
    time: message.timestamp,
  };
  const system = systemText(message.type, author, message.content);
  if (system !== undefined) formatted.system = system;
  else formatted.content = renderMentions(fullText ?? message.content, message.mentions);
  if (fullText !== undefined && system === undefined) formatted.full_text_from_attachment = true;
  const replyId = replyTargetId(message);
  if (replyId) formatted.reply_to = replyTo(replyId, referenced !== undefined ? referenced : (message.referenced_message ?? null), ownerId);
  if (message.attachments.length) {
    formatted.attachments = message.attachments.map((a) => ({ name: a.filename, url: a.url, size: a.size }));
  }
  const reactions = reactionSummary(message);
  if (reactions) formatted.reactions = reactions;
  return formatted;
}

export interface FormatIo {
  /** Downloads an overflow attachment. */
  fetchText?: (url: string) => Promise<string>;
  /** Looks up a replied-to message Discord did not embed. */
  fetchMessage?: (channelId: string, messageId: string) => Promise<APIMessage>;
}

/**
 * Fetches the full text of over-long messages so the agent never reads only the preview, and
 * the replied-to message of replies Discord did not embed (`referenced_message` absent).
 */
export async function formatMessages(messages: readonly APIMessage[], ownerId: string, io: FormatIo = {}): Promise<FormattedMessage[]> {
  const fetchText = io.fetchText ?? defaultFetchText;
  const byId = new Map(messages.map((m) => [m.id, m]));
  return Promise.all(
    messages.map(async (message) => {
      const overflow = overflowAttachment(message);
      let fullText: string | undefined;
      if (overflow) {
        try {
          fullText = await fetchText(overflow.url);
        } catch {
          // The preview and attachment url are still returned; the agent can live without the inline copy.
        }
      }
      let referenced: APIMessage | null | undefined;
      const replyId = replyTargetId(message);
      // `null` from Discord means deleted; only a missing field is worth a lookup.
      if (replyId && message.referenced_message === undefined) {
        referenced = byId.get(replyId) ?? null;
        if (!referenced && io.fetchMessage) {
          referenced = await io.fetchMessage(message.message_reference?.channel_id ?? message.channel_id, replyId).catch(() => null);
        }
      }
      return formatMessage(message, ownerId, fullText, referenced);
    }),
  );
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
