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
  const [a, b] = await formatMessages([long, fromOwner], 'owner', async (url) => `full text from ${url}`);
  expect(a!.from_kind).toBe('agent');
  expect(a!.content).toBe('full text from https://cdn/full.md');
  expect(a!.full_text_from_attachment).toBe(true);
  expect(a!.reactions).toBe('⭐×2');
  expect(b!.from_kind).toBe('owner');
});

test('keeps the preview when the attachment cannot be fetched', async () => {
  const long = message({ content: 'preview', attachments: [{ id: 'a', filename: OVERFLOW_FILENAME, size: 10, url: 'u', proxy_url: '' }] });
  const [m] = await formatMessages([long], 'owner', async () => {
    throw new Error('offline');
  });
  expect(m!.content).toBe('preview');
  expect(m!.attachments?.[0]?.url).toBe('u');
});
