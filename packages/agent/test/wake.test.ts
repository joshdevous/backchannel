import { expect, test } from 'bun:test';
import { wakeReason } from '../src/wake.ts';

const base = { authorId: 'peer', channelId: 'chan', mentionIds: [] as string[] };

test('mention, reply, started post, claimed post – in that priority', () => {
  expect(wakeReason({ ...base, mentionIds: ['me'], replyToAuthorId: 'me' }, 'me', [])).toBe('mention');
  expect(wakeReason({ ...base, replyToAuthorId: 'me', threadOwnerId: 'me' }, 'me', [])).toBe('reply');
  expect(wakeReason({ ...base, threadOwnerId: 'me' }, 'me', ['chan'])).toBe('started_post');
  expect(wakeReason(base, 'me', ['chan'])).toBe('claimed_post');
});

test('ignores own messages and unrelated chatter', () => {
  expect(wakeReason({ ...base, authorId: 'me', mentionIds: ['me'] }, 'me', [])).toBeNull();
  expect(wakeReason({ ...base, mentionIds: ['someone-else'], replyToAuthorId: 'other' }, 'me', ['other-post'])).toBeNull();
});
