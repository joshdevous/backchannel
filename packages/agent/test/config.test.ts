import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, missingFields, parseTrustedIds, requireConfig } from '../src/config.ts';

const dir = mkdtempSync(join(tmpdir(), 'backchannel-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('env vars override file fields; empty env values do not', () => {
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ token: 'file-token', guildId: '1', ownerId: '2', agentName: 'file' }));
  const config = loadConfig({ BACKCHANNEL_CONFIG: path, BACKCHANNEL_AGENT_NAME: 'env', BACKCHANNEL_TOKEN: '' });
  expect(config).toEqual({ token: 'file-token', guildId: '1', ownerId: '2', agentName: 'env' });
});

test('a missing file is not an error, just missing fields', () => {
  const config = loadConfig({ BACKCHANNEL_CONFIG: join(dir, 'nope.json'), BACKCHANNEL_GUILD_ID: '9' });
  expect(missingFields(config)).toEqual(['token', 'ownerId', 'agentName']);
});

test('listen comes from BACKCHANNEL_LISTEN or the file, defaults to all, rejects junk', () => {
  const path = join(dir, 'listen.json');
  writeFileSync(path, JSON.stringify({ token: 't', guildId: '1', ownerId: '2', agentName: 'a', listen: 'mentions' }));
  expect(loadConfig({ BACKCHANNEL_CONFIG: path }).listen).toBe('mentions');
  expect(loadConfig({ BACKCHANNEL_CONFIG: path, BACKCHANNEL_LISTEN: 'all' }).listen).toBe('all');
  expect(requireConfig(loadConfig({ BACKCHANNEL_CONFIG: join(dir, 'nope.json'), BACKCHANNEL_TOKEN: 't', BACKCHANNEL_GUILD_ID: '1', BACKCHANNEL_OWNER_ID: '2', BACKCHANNEL_AGENT_NAME: 'a' })).listen).toBe('all');
  expect(() => loadConfig({ BACKCHANNEL_CONFIG: path, BACKCHANNEL_LISTEN: 'loud' })).toThrow('BACKCHANNEL_LISTEN must be one of all, mentions');
});

test('trusted ids parse from a list or a comma string and refuse anything that is not an id', () => {
  expect(parseTrustedIds('676926873669992459, 676926873669992459,259780560707256321', 'x')).toEqual(['676926873669992459', '259780560707256321']);
  expect(parseTrustedIds(['676926873669992459'], 'x')).toEqual(['676926873669992459']);
  expect(parseTrustedIds(undefined, 'x')).toEqual([]);
  expect(() => parseTrustedIds('stephen', 'x')).toThrow(/not a Discord user id/);
  expect(() => parseTrustedIds({}, 'x')).toThrow(/list of Discord user ids/);
});
