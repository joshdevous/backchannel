import { expect, test } from 'bun:test';
import { ChannelType } from 'discord-api-types/v10';
import { statusOf, withStatus, type Channel } from '../src/discord.ts';

const forum: Channel = {
  id: 'f',
  type: ChannelType.GuildForum,
  available_tags: [
    { id: 't-open', name: 'Open' },
    { id: 't-claimed', name: 'Claimed' },
    { id: 't-done', name: 'Done' },
    { id: 't-bug', name: 'bug' },
  ],
};

test('status comes from the applied status tag', () => {
  expect(statusOf({ id: 'p', type: ChannelType.PublicThread, applied_tags: ['t-bug', 't-claimed'] }, forum)).toBe('Claimed');
  expect(statusOf({ id: 'p', type: ChannelType.PublicThread, applied_tags: ['t-bug'] }, forum)).toBeNull();
});

test('changing status swaps only the status tag', () => {
  const post: Channel = { id: 'p', type: ChannelType.PublicThread, applied_tags: ['t-bug', 't-open'] };
  expect(withStatus(post, forum, 'Done')).toEqual(['t-bug', 't-done']);
});

test('a forum missing the tag gives a readable error', () => {
  const post: Channel = { id: 'p', type: ChannelType.PublicThread, applied_tags: [] };
  expect(() => withStatus(post, forum, 'Blocked')).toThrow(/no "Blocked" tag/);
});
