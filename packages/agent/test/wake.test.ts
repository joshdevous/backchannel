import { expect, test } from 'bun:test';
import type { AmbientInput } from '@backchannel/core';
import { directReason, pushReason } from '../src/wake.ts';

const base = { authorId: 'peer', channelId: 'chan', mentionIds: [] as string[] };

test('mention, reply, started post, claimed post – in that priority', () => {
  expect(directReason({ ...base, mentionIds: ['me'], replyToAuthorId: 'me' }, 'me', [])).toBe('mention');
  expect(directReason({ ...base, replyToAuthorId: 'me', threadOwnerId: 'me' }, 'me', [])).toBe('reply');
  expect(directReason({ ...base, threadOwnerId: 'me' }, 'me', ['chan'])).toBe('started_post');
  expect(directReason(base, 'me', ['chan'])).toBe('claimed_post');
});

test('ignores own messages and unrelated chatter', () => {
  expect(directReason({ ...base, authorId: 'me', mentionIds: ['me'] }, 'me', [])).toBeNull();
  expect(directReason({ ...base, mentionIds: ['someone-else'], replyToAuthorId: 'other' }, 'me', ['other-post'])).toBeNull();
});

const talk: AmbientInput = { fromBot: false, type: 0, where: 'text', channelName: 'general' };

test('push: people talking are ambient in mode all, ignored in mode mentions', () => {
  expect(pushReason({ ...base, ambient: talk }, 'me', [], 'all')).toBe('ambient');
  expect(pushReason({ ...base, ambient: talk }, 'me', [], 'mentions')).toBeNull();
  expect(pushReason({ ...base, mentionIds: ['me'], ambient: talk }, 'me', [], 'mentions')).toBe('mention');
});

test('push: other bots only wake it directly; system notices and #starboard never ambient', () => {
  const bot = { ...talk, fromBot: true };
  expect(pushReason({ ...base, ambient: bot }, 'me', [], 'all')).toBeNull();
  expect(pushReason({ ...base, replyToAuthorId: 'me', ambient: bot }, 'me', [], 'all')).toBe('reply');
  expect(pushReason({ ...base, ambient: { ...talk, type: 7 } }, 'me', [], 'all')).toBeNull();
  expect(pushReason({ ...base, ambient: { ...talk, channelName: 'starboard' } }, 'me', [], 'all')).toBeNull();
  expect(pushReason({ ...base, authorId: 'me', ambient: talk }, 'me', [], 'all')).toBeNull();
});
