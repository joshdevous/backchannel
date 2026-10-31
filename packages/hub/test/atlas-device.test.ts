import { afterEach, expect, test } from 'bun:test';
import type { ServerWebSocket } from 'bun';
import { AtlasDevice, parseMintedToken, TOKEN_REFRESH_MARGIN_MS } from '../src/atlas-device.ts';

/** A stand-in for the Atlas relay: answers the handful of control frames the device sends. */
function fakeRelay(sessions: object[], steer: { accepted: boolean; reason?: string }) {
  const received: { url: string; protocols: string; payload: { type: string } & Record<string, unknown> }[] = [];
  const frame = (payload: object) => JSON.stringify({ v: 1, kind: 'control', seq: 0, ts: Date.now(), machineId: 'relay', payload });
  const server = Bun.serve<{ url: string; protocols: string }>({
    port: 0,
    fetch(req, srv) {
      const ok = srv.upgrade(req, {
        headers: { 'Sec-WebSocket-Protocol': 'atlas.v1' },
        data: { url: req.url, protocols: req.headers.get('sec-websocket-protocol') ?? '' },
      });
      return ok ? undefined : new Response('no', { status: 400 });
    },
    websocket: {
      message(ws: ServerWebSocket<{ url: string; protocols: string }>, raw) {
        const { payload } = JSON.parse(String(raw));
        received.push({ ...ws.data, payload });
        if (payload.type === 'device_hello' || payload.type === 'machine_list_request') {
          ws.send(frame({ type: 'machine_list', machines: [{ machineId: 'atlas-vps', status: 'online', mcpServers: [] }] }));
        } else if (payload.type === 'session_list_request') {
          ws.send(frame({ type: 'session_list', machineId: payload.machineId, sessions }));
        } else if (payload.type === 'session_steer') {
          ws.send(frame({ type: 'session_steer_result', sessionId: payload.sessionId, ts: payload.ts, ...steer }));
        }
      },
    },
  });
  return { server, received, url: `ws://localhost:${server.port}` };
}

const servers: { stop(force?: boolean): void }[] = [];
const devices: AtlasDevice[] = [];
afterEach(() => {
  for (const device of devices.splice(0)) device.stop();
  for (const server of servers.splice(0)) server.stop(true);
});

function device(relayUrl: string, mint: () => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return mint();
  }) as typeof fetch;
  const d = new AtlasDevice({
    atlasUrl: 'https://atlas.example',
    accessClientId: 'id.access',
    accessClientSecret: 'secret',
    deviceId: 'backchannel-hub',
    machineId: 'atlas-vps',
    approval: 'write',
    fetch: fetchImpl,
    readyTimeoutMs: 1000,
  });
  devices.push(d);
  return { d, calls, relayUrl };
}

const tokenResponse = (relayUrl: string, ttl: number) => () =>
  Response.json({ token: 'tok', relayUrl, expiresAt: Date.now() + ttl });

test('mints a device token with the Access headers, connects as the fixed device and reuses the token', async () => {
  const relay = fakeRelay([], { accepted: true });
  servers.push(relay.server);
  const { d, calls } = device(relay.url, tokenResponse(relay.url, 12 * 60 * 60_000));
  await d.ready();
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe('https://atlas.example/api/relay-token');
  expect(calls[0]!.init.headers).toMatchObject({ 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'secret' });
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ deviceId: 'backchannel-hub' });
  expect((await d.machine()).machineId).toBe('atlas-vps');
  const hello = relay.received.find((r) => r.payload.type === 'device_hello')!;
  expect(hello.url).toContain('role=device');
  expect(hello.url).toContain('id=backchannel-hub');
  expect(hello.protocols).toContain('bearer.tok');

  d.stop();
  await d.ready();
  expect(calls).toHaveLength(1);
});

test('re-mints a token that is close to expiry', async () => {
  const relay = fakeRelay([], { accepted: true });
  servers.push(relay.server);
  const { d, calls } = device(relay.url, tokenResponse(relay.url, TOKEN_REFRESH_MARGIN_MS - 60_000));
  await d.ready();
  d.stop();
  await d.ready();
  expect(calls).toHaveLength(2);
});

test('a refused Access credential leaves the device disconnected instead of spinning', async () => {
  const { d, calls } = device('ws://unused', () => new Response(null, { status: 302, headers: { location: '/login' } }));
  d.start();
  // The next wake re-arms the socket; it fails the same way, quickly, and says so.
  await expect(d.ready()).rejects.toThrow('not connected');
  expect(calls.length).toBeGreaterThanOrEqual(1);
});

test('a message for a chat whose turn is live is steered into it, not prompted', async () => {
  const relay = fakeRelay(
    [{ sessionId: 'run-1', machineId: 'atlas-vps', cwd: '/root/chats', acpSessionId: 'acp-1', turnOpen: true, subscribers: [] }],
    { accepted: true },
  );
  servers.push(relay.server);
  const { d } = device(relay.url, tokenResponse(relay.url, 12 * 60 * 60_000));
  const outcome = await d.deliver({ acpSessionId: 'acp-1', machineId: 'atlas-vps', cwd: '/root/chats' }, 'new messages');
  expect(outcome).toBe('steered');
  const steer = relay.received.find((r) => r.payload.type === 'session_steer')!;
  expect(steer.payload).toMatchObject({ sessionId: 'run-1', text: 'new messages' });
  expect(relay.received.some((r) => r.payload.type === 'session_resume_request')).toBe(false);
});

test('a refused steer is reported', async () => {
  const relay = fakeRelay(
    [{ sessionId: 'run-1', machineId: 'atlas-vps', cwd: '/x', acpSessionId: 'acp-1', turnOpen: true, subscribers: [] }],
    { accepted: false, reason: 'no-socket' },
  );
  servers.push(relay.server);
  const { d } = device(relay.url, tokenResponse(relay.url, 12 * 60 * 60_000));
  await expect(d.deliver({ acpSessionId: 'acp-1', machineId: 'atlas-vps', cwd: '/x' }, 'hi')).rejects.toThrow('no-socket');
});

test('parseMintedToken accepts only the full token shape', () => {
  expect(parseMintedToken({ token: 't', relayUrl: 'wss://r', expiresAt: 5 })).toEqual({
    endpoint: { url: 'wss://r', credential: 't' },
    expiresAt: 5,
  });
  expect(parseMintedToken({ token: '', relayUrl: 'wss://r', expiresAt: 5 })).toBeUndefined();
  expect(parseMintedToken({ token: 't', expiresAt: 5 })).toBeUndefined();
  expect(parseMintedToken({ token: 't', relayUrl: 'wss://r' })).toBeUndefined();
  expect(parseMintedToken(null)).toBeUndefined();
});
