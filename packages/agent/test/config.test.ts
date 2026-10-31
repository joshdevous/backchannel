import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, missingFields } from '../src/config.ts';

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
