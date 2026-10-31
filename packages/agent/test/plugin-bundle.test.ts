import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bundle, pluginDependencies, pluginDir } from '../src/build-plugin.ts';

// The plugin ships a prebuilt bundle; forgetting `bun run build:plugin` would ship stale code.
test('plugin bundle and dependencies match the agent source', async () => {
  const fresh = await bundle();
  for (const [name, code] of Object.entries(fresh)) {
    expect(readFileSync(join(pluginDir, name), 'utf8'), `plugin/${name} is stale: run bun run --cwd packages/agent build:plugin`).toBe(code);
  }
  const pkg = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'));
  expect(pkg.dependencies).toEqual(pluginDependencies());
}, 30_000);
