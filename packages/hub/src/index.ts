import type { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { AtlasDevice } from './atlas-device.ts';
import { AtlasProjects } from './atlas-projects.ts';
import { AtlasStore } from './atlas-store.ts';
import { AtlasWaker } from './atlas-waker.ts';
import { loadAgentToken, loadAtlasWakeConfig, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { startHub } from './hub.ts';
import { log, logError } from './log.ts';
import { keepAgentOnline } from './agent-online.ts';
import { AgentPresence, createAgentBotApi } from './presence.ts';
import { OmpLlm, ProjectRouter } from './project-classifier.ts';

try {
  const config = loadConfig();

  // Josh's agent is an Atlas chat; the hub reaches it as an Atlas device over the relay.
  let waker: AtlasWaker | undefined;
  let wakeDb: Database | undefined;
  let presence: AgentPresence | undefined;
  let agentOnline: { stop(): Promise<void> } | undefined;
  if (config.atlasAgentBotId) {
    const atlas = loadAtlasWakeConfig(process.env);
    const device = new AtlasDevice(atlas);
    device.start();
    wakeDb = openDb(config.dbPath);
    // The agent bot's own token lets the hub react and type as that bot; without it wakes
    // still work, just silently.
    const agentToken = loadAgentToken(process.env, config.guildId, config.atlasAgentBotId, readConfigFile, homedir());
    if (agentToken.token === undefined) {
      log(`agent presence off: ${agentToken.why}`);
    } else {
      presence = new AgentPresence(createAgentBotApi(agentToken.token));
      log(`agent presence on (👀 + typing as bot ${config.atlasAgentBotId}), token from ${agentToken.source}`);
      agentOnline = await keepAgentOnline(agentToken.token).catch((err) => {
        logError('agent bot could not go online', err);
        return undefined;
      });
    }
    waker = new AtlasWaker({
      store: new AtlasStore(wakeDb),
      chats: device,
      projects: new ProjectRouter({
        catalogue: new AtlasProjects(atlas),
        llm: new OmpLlm({ bin: atlas.ompBin }),
        defaultName: atlas.defaultProject,
      }),
      cwd: atlas.cwd,
      ownerId: atlas.ownerId,
      guildId: config.guildId,
      presence,
    });
    log(
      `atlas wake-ups on: device ${atlas.deviceId}, machine ${atlas.machineId}, default project ${atlas.defaultProject}, fallback cwd ${atlas.cwd}`,
    );
  }

  const hub = await startHub({ config, waker, presence });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, shutting down`);
    // `hub.stop()` flushes pending wake-ups into the waker, so the waker stops after it.
    hub
      .stop()
      .then(() => {
        waker?.stop();
        presence?.stop();
        wakeDb?.close();
        return agentOnline?.stop();
      })
      .then(
        () => process.exit(0),
        (err) => {
          logError('shutdown failed', err);
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
} catch (err) {
  logError('hub failed to start', err);
  process.exit(1);
}

function readConfigFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
