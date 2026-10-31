import { expect, test } from 'bun:test';
import type { APIMessage } from 'discord-api-types/v10';
import { OVERFLOW_FILENAME } from '@backchannel/core';
import { formatMessages, renderMentions } from '../src/format.ts';

function message(overrides: Partial<APIMessage>): APIMessage {
  return {
    id: '1',
    channel_id: 'c',
    author: { id: 'u', username: 'sam', global_name: 'Sam', discriminator: '0', avatar: null },
    content: '',
    timestamp: '2026-10-31T00:00:00.000Z',
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
    ...overrides,
  } as APIMessage;
}

test('mentions render as names', () => {
  expect(renderMentions('hi <@42> and <@!43> and <@44>', [
    { id: '42', username: 'a', global_name: 'Alice' },
    { id: '43', username: 'bob' },
  ])).toBe('hi @Alice and @bob and <@44>');
});

test('labels authors and inlines the overflow attachment', async () => {
  const long = message({
    id: '2',
    author: { id: 'bot', username: 'helper', global_name: null, discriminator: '0', avatar: null, bot: true },
    content: 'preview…',
    attachments: [{ id: 'a', filename: OVERFLOW_FILENAME, size: 5000, url: 'https://cdn/full.md', proxy_url: '' }],
    reactions: [{ emoji: { id: null, name: '⭐' }, count: 2, me: false, count_details: { burst: 0, normal: 2 }, me_burst: false, burst_colors: [] }],
  });
  const fromOwner = message({ id: '3', author: { id: 'owner', username: 'josh', global_name: null, discriminator: '0', avatar: null } });
  const [a, b] = await formatMessages([long, fromOwner], 'owner', { fetchText: async (url) => `full text from ${url}` });
  expect(a!.from_kind).toBe('agent');
  expect(a!.content).toBe('full text from https://cdn/full.md');
  expect(a!.full_text_from_attachment).toBe(true);
  expect(a!.reactions).toBe('⭐×2');
  expect(b!.from_kind).toBe('owner');
});

test('keeps the preview when the attachment cannot be fetched', async () => {
  const long = message({ content: 'preview', attachments: [{ id: 'a', filename: OVERFLOW_FILENAME, size: 10, url: 'u', proxy_url: '' }] });
  const [m] = await formatMessages([long], 'owner', {
    fetchText: async () => {
      throw new Error('offline');
    },
  });
  expect(m!.content).toBe('preview');
  expect(m!.attachments?.[0]?.url).toBe('u');
});

const joshAuthor = { id: 'owner', username: 'josh', global_name: 'Josh', discriminator: '0', avatar: null };
const botAuthor = { id: 'me', username: 'atlas', global_name: null, discriminator: '0', avatar: null, bot: true };

test('a reply carries reply_to with the embedded referenced message', async () => {
  const greeting = message({ id: '10', author: botAuthor, content: 'hello everyone' });
  const reply = message({
    id: '11',
    type: 19,
    author: joshAuthor,
    content: 'star this message',
    message_reference: { message_id: '10', channel_id: 'c' },
    referenced_message: greeting,
  });
  const [m] = await formatMessages([reply], 'owner');
  expect(m!.reply_to).toEqual({ id: '10', author: 'atlas', author_id: 'me', from_kind: 'agent', text: 'hello everyone' });
});

test('reply_to text is cut to ~200 chars on one line', async () => {
  const long = message({ id: '10', content: `line one\n${'z'.repeat(400)}` });
  const reply = message({ id: '11', type: 19, message_reference: { message_id: '10', channel_id: 'c' }, referenced_message: long });
  const [m] = await formatMessages([reply], 'owner');
  expect(m!.reply_to!.text).toHaveLength(200);
  expect(m!.reply_to!.text.startsWith('line one z')).toBe(true);
  expect(m!.reply_to!.text.endsWith('…')).toBe(true);
});

test('a missing referenced message is found in the batch, else fetched; null means deleted', async () => {
  const original = message({ id: '10', content: 'in the batch' });
  const inBatch = message({ id: '11', type: 19, message_reference: { message_id: '10', channel_id: 'c' } });
  const fetched: string[] = [];
  const io = {
    fetchMessage: async (channelId: string, id: string) => {
      fetched.push(`${channelId}/${id}`);
      return message({ id, content: 'fetched one' });
    },
  };
  const [, a] = await formatMessages([original, inBatch], 'owner', io);
  expect(a!.reply_to!.text).toBe('in the batch');
  expect(fetched).toEqual([]);

  const elsewhere = message({ id: '12', type: 19, message_reference: { message_id: '5', channel_id: 'c' } });
  const [b] = await formatMessages([elsewhere], 'owner', io);
  expect(b!.reply_to!.text).toBe('fetched one');
  expect(fetched).toEqual(['c/5']);

  const deleted = message({ id: '13', type: 19, message_reference: { message_id: '6', channel_id: 'c' }, referenced_message: null });
  const [c] = await formatMessages([deleted], 'owner', io);
  expect(c!.reply_to).toEqual({ id: '6', text: '(message not available, maybe deleted)' });
  expect(fetched).toEqual(['c/5']);
});

test('only replies get reply_to (forwards and pins carry references too)', async () => {
  const pin = message({ id: '11', type: 6, message_reference: { message_id: '10', channel_id: 'c' } });
  const [m] = await formatMessages([pin], 'owner');
  expect(m!.reply_to).toBeUndefined();
});

test('system messages read as a system line instead of empty content', async () => {
  const join = message({ id: '20', type: 7, author: { id: 's', username: 'stephen', global_name: 'Stephen', discriminator: '0', avatar: null } });
  const [m] = await formatMessages([join], 'owner');
  expect(m!.system).toBe('Stephen joined the server');
  expect(m!.content).toBeUndefined();
});
