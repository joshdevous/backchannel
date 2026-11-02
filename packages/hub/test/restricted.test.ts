import { expect, test } from 'bun:test';
import type { AgentMcpServer } from '@atlas/shared-types';
import { WAKE_MARKER, firstBrief, followUp } from '../src/atlas-brief.ts';
import { parseIdList } from '../src/config.ts';
import { allowedMcpServers } from '../src/mcp-filter.ts';
import { withoutRestricted } from '../src/restrict.ts';
import type { WakeEvent, WakeMessage } from '../src/waker.ts';

function msg(id: string, over: Partial<WakeMessage> = {}): WakeMessage {
  return {
    reason: 'ambient',
    messageId: id,
    authorId: 'peer-1',
    authorName: 'Sam',
    authorKind: 'human',
    content: `hello ${id}`,
    jumpUrl: `https://discord.com/channels/g/c/${id}`,
    ...over,
  };
}
function event(messages: WakeMessage[], over: Partial<WakeEvent> = {}): WakeEvent {
  return { ...messages[messages.length - 1]!, channelId: 'c', messages, ...over };
}

test('a batch with only restricted messages is dropped; a mixed one loses just those', () => {
  expect(withoutRestricted(event([msg('1', { content: 'look at the UKSBS repo' })]))).toBeUndefined();
  const kept = withoutRestricted(event([msg('1'), msg('2', { content: 'DIGI-12345 is broken' })]));
  expect(kept?.messages.map((m) => m.messageId)).toEqual(['1']);
  expect(kept?.messageId).toBe('1');
});

test('a dropped ping cannot leave its reason behind', () => {
  const kept = withoutRestricted(event([msg('1'), msg('2', { reason: 'mention', content: 'uksbs please' })], { reason: 'mention' }));
  expect(kept?.reason).toBe('ambient');
});

test('a reply to restricted text is dropped with it, and a place named for UKSBS drops the lot', () => {
  const reply = { messageId: 'x', authorName: 'Sam', isSelf: false, text: 'about uksbs' };
  expect(withoutRestricted(event([msg('1', { replyTo: reply })]))).toBeUndefined();
  expect(withoutRestricted(event([msg('1')], { postTitle: 'UKSBS thing' }))).toBeUndefined();
});

test('an untouched batch is returned as is', () => {
  const clean = event([msg('1')]);
  expect(withoutRestricted(clean)).toBe(clean);
});

const stdio = (name: string): AgentMcpServer => ({ name, command: 'x', args: [], env: [] });
const http = (name: string, url: string): AgentMcpServer => ({ type: 'http', name, url, headers: [] });

test('a woken chat gets no Atlassian and no UKSBS MCP server, and keeps the rest', () => {
  const servers = [
    stdio('backchannel'),
    http('atlassian', 'https://mcp.atlassian.com/v1/mcp/authv2'),
    http('github-uksbs', 'https://api.githubcopilot.com/mcp/'),
    http('github-joshdevous', 'https://api.githubcopilot.com/mcp/'),
    stdio('atlas'),
  ];
  expect(allowedMcpServers(servers).map((s) => s.name)).toEqual(['backchannel', 'github-joshdevous', 'atlas']);
  expect(allowedMcpServers(servers, ['atlas']).map((s) => s.name)).toEqual(['backchannel', 'github-joshdevous']);
});

const ctx = { ownerId: 'owner-1', trustedIds: ['676926873669992459'], guildId: 'g' };

test('a trusted person is named as such by id, the owner and peers as before', () => {
  const brief = firstBrief(
    event([
      msg('1', { authorId: '676926873669992459', authorName: 'Stephen' }),
      msg('2', { authorId: 'impostor', authorName: 'Stephen' }),
      msg('3', { authorId: '676926873669992459', authorName: 'SteveClaude', authorKind: 'agent' }),
    ]),
    ctx,
  );
  expect(brief).toContain('"Stephen" – a person Josh trusts with his own authority (message 1');
  expect(brief).toContain('"Stephen" – another person, a peer (message 2');
  expect(brief).toContain('"SteveClaude" – another agent, a peer (message 3');
  expect(brief).toContain('676926873669992459');
  expect(brief).toContain('UKSBS (Josh\'s employer) is off limits');
});

test('every brief starts with the marker the fidelity guard switches on', () => {
  expect(firstBrief(event([msg('1')]), ctx).startsWith(WAKE_MARKER)).toBe(true);
  expect(followUp(event([msg('1')]), ctx).startsWith(WAKE_MARKER)).toBe(true);
});

test('trusted ids must be Discord ids', () => {
  expect(parseIdList('676926873669992459,', 'X')).toEqual(['676926873669992459']);
  expect(() => parseIdList('stephen', 'X')).toThrow(/not a Discord user id/);
});
