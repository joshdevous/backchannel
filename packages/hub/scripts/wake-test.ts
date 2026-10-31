/**
 * Drives the hub's Atlas device by hand, through the same code the waker uses.
 *
 *   bun --env-file=/root/.config/atlas-agent-access packages/hub/scripts/wake-test.ts probe
 *     Opens the device socket, prints the machine list, closes. Touches no chat.
 *   ... wake-test.ts spawn [--cwd <dir>] [--text <prompt>]
 *     Opens ONE new Atlas chat on the wake machine and sends it one prompt; prints its session id.
 *   ... wake-test.ts message <acpSessionId> [--cwd <dir>] [--text <prompt>]
 *     Delivers one message to an existing chat exactly as a wake would: steer if its turn is
 *     live, else prompt (attaching to an open run, resuming a closed one). `--cwd` must be the
 *     chat's own working directory when it has to be resumed.
 *
 * Reads the same env as the hub (`ATLAS_WAKE_*`, `ATLAS_URL`, `CF_ACCESS_CLIENT_*`). The spawn and
 * message modes act on Josh's real Atlas: the chat shows up in his list.
 */
import { parseArgs } from 'node:util';
import { AtlasDevice } from '../src/atlas-device.ts';
import { loadAtlasWakeConfig } from '../src/config.ts';

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { cwd: { type: 'string' }, text: { type: 'string' } },
  allowPositionals: true,
});
const [mode, sessionId] = positionals;
// The owner id only shapes a brief, which this script does not build.
const config = loadAtlasWakeConfig({ BACKCHANNEL_OWNER_ID: 'unused', ...process.env });
const cwd = values.cwd ?? config.cwd;
const text =
  values.text ??
  'This is a Backchannel wake test sent by the hub (device backchannel-hub). Reply with one short line saying you received it, and do nothing else.';

const device = new AtlasDevice(config);
device.start();
let exitCode = 0;
try {
  if (mode === 'probe') {
    const machine = await device.machine();
    console.log(
      `connected as ${config.deviceId}; ${machine.machineId} is ${machine.status}, ` +
        `${machine.activeSessions} active session(s), MCP servers: ${(machine.mcpServers ?? []).map((s) => s.name).join(', ') || 'none'}`,
    );
  } else if (mode === 'spawn') {
    const requestId = crypto.randomUUID();
    const chat = await device.spawn(cwd, requestId);
    console.log(`spawned session ${chat.acpSessionId} on ${chat.machineId} in ${chat.cwd} (request ${requestId})`);
    console.log(`first prompt: ${await (await device.deliver(chat, text)).accepted}`);
  } else if (mode === 'message' && sessionId) {
    const outcome = await (await device.deliver({ acpSessionId: sessionId, machineId: config.machineId, cwd }, text)).accepted;
    console.log(`message to ${sessionId}: ${outcome}`);
  } else {
    console.error('usage: wake-test.ts probe | spawn [--cwd dir] [--text t] | message <acpSessionId> [--cwd dir] [--text t]');
    exitCode = 2;
  }
} catch (err) {
  console.error(`failed: ${err instanceof Error ? err.message : String(err)}`);
  exitCode = 1;
} finally {
  device.stop();
}
process.exit(exitCode);
