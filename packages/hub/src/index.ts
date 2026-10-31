import type { Database } from 'bun:sqlite';
import { AtlasDevice } from './atlas-device.ts';
import { AtlasStore } from './atlas-store.ts';
import { AtlasWaker } from './atlas-waker.ts';
import { loadAtlasWakeConfig, loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { startHub } from './hub.ts';
import { log, logError } from './log.ts';

try {
  const config = loadConfig();

  // Josh's agent is an Atlas chat; the hub reaches it as an Atlas device over the relay.
  let waker: AtlasWaker | undefined;
  let wakeDb: Database | undefined;
  if (config.atlasAgentBotId) {
    const atlas = loadAtlasWakeConfig(process.env);
    const device = new AtlasDevice(atlas);
    device.start();
    wakeDb = openDb(config.dbPath);
    waker = new AtlasWaker({
      store: new AtlasStore(wakeDb),
      chats: device,
      cwd: atlas.cwd,
      ownerId: atlas.ownerId,
      guildId: config.guildId,
    });
    log(`atlas wake-ups on: device ${atlas.deviceId}, machine ${atlas.machineId}, cwd ${atlas.cwd}`);
  }

  const hub = await startHub({ config, waker });

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
        wakeDb?.close();
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
