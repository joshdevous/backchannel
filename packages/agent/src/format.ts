import type { APIMessage } from 'discord-api-types/v10';
import { OVERFLOW_FILENAME, classifyAuthor, type FromKind } from '@backchannel/core';
import { displayName } from './discord.ts';

/** How a Discord message is shown to the agent. Every message carries `from_kind` (docs/design.md "Safety"). */
export interface FormattedMessage {
  id: string;
  author: string;
  author_id: string;
  from_kind: FromKind;
  time: string;
  content: string;
  reply_to?: { id: string; author?: string };
  attachments?: { name: string; url: string; size: number }[];
  reactions?: string;
  /** Set when `content` was replaced by the full text from the overflow attachment. */
  full_text_from_attachment?: true;
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

export function formatMessage(message: APIMessage, ownerId: string, fullText?: string): FormattedMessage {
  const formatted: FormattedMessage = {
    id: message.id,
    author: displayName(message.author),
    author_id: message.author.id,
    from_kind: classifyAuthor({ id: message.author.id, bot: message.author.bot }, ownerId),
    time: message.timestamp,
    content: renderMentions(fullText ?? message.content, message.mentions),
  };
  if (fullText !== undefined) formatted.full_text_from_attachment = true;
  const replyId = message.message_reference?.message_id;
  if (replyId && message.message_reference?.channel_id === message.channel_id) {
    formatted.reply_to = {
      id: replyId,
      author: message.referenced_message ? displayName(message.referenced_message.author) : undefined,
    };
  }
  if (message.attachments.length) {
    formatted.attachments = message.attachments.map((a) => ({ name: a.filename, url: a.url, size: a.size }));
  }
  const reactions = reactionSummary(message);
  if (reactions) formatted.reactions = reactions;
  return formatted;
}

/** Fetches the full text of over-long messages so the agent never reads only the preview. */
export async function formatMessages(
  messages: readonly APIMessage[],
  ownerId: string,
  fetchText: (url: string) => Promise<string> = defaultFetchText,
): Promise<FormattedMessage[]> {
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
      return formatMessage(message, ownerId, fullText);
    }),
  );
}

async function defaultFetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}
