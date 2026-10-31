/**
 * The hub as an Atlas device: the same relay socket and ACP client the Atlas web app uses
 * (`@atlas/acp-client`, imported from the deployed Atlas tree – see tsconfig `paths`), with
 * the two things that package leaves to its host: where the credential comes from, and what
 * to do about a chat this device did not open.
 *
 * Credential: Atlas's agent Cloudflare Access service token mints a device token at
 * `POST /api/relay-token`. The relay treats a token minted that way as the server's own agent,
 * so it may use a plain (unsealed) socket while the sealed transport is mandatory for Josh's
 * devices; the Access policy only admits that token from this box.
 */
import {
  AcpClient,
  promptLostTransport,
  promptRefusedAsBusy,
  type AcpSessionHandle,
  type AttachSeq,
  type RelayEndpoint,
} from '@atlas/acp-client';
import {
  isControlFrame,
  type ApprovalMode,
  type ControlMessage,
  type MachineId,
  type MachineInfo,
  type SessionInfo,
} from '@atlas/shared-types';
import type { ChatTarget } from './atlas-store.ts';
import { log, logError } from './log.ts';
import { TIMED_OUT, withTimeout } from './timeout.ts';

export interface AtlasDeviceOptions {
  /** Atlas web origin, e.g. `https://atlas.example.com`. */
  atlasUrl: string;
  accessClientId: string;
  accessClientSecret: string;
  /** Fixed and recognisable, so the relay audit log and Atlas show who this is. */
  deviceId: string;
  machineId: string;
  /** Passed on spawn and resume; absent means omp's own default. */
  approval?: ApprovalMode;
  fetch?: typeof fetch;
  /** How long a wake waits for the relay socket before giving up. */
  readyTimeoutMs?: number;
}

/** The chats a target channel can be tied to – what the waker needs from Atlas. */
export interface AtlasChats {
  /** Opens a new chat in `cwd`. Resolves once the conversation exists; prompts nothing. */
  spawn(cwd: string, requestId: string): Promise<ChatTarget>;
  /** Hands `text` to an existing chat: steer into a live turn, else prompt (resuming if closed). */
  deliver(chat: ChatTarget, text: string): Promise<DeliveryOutcome>;
  /** The live run holding this conversation, from the relay's session list; `undefined` when none. */
  liveRun(machineId: MachineId, acpSessionId: string): Promise<SessionInfo | undefined>;
  stop(): void;
}

export type DeliveryOutcome = 'steered' | 'prompted' | 'unconfirmed';

/** Re-mint the device token when less than this is left of its 12 h life. */
export const TOKEN_REFRESH_MARGIN_MS = 60 * 60_000;
const READY_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 10_000;
const STEER_RESULT_TIMEOUT_MS = 10_000;
/** A prompt not refused within this is taken as accepted; the turn then runs on without us. */
const PROMPT_ACCEPT_MS = 15_000;
/** How long a spawn that timed out is watched for, so its late run can be closed. */
const LATE_SPAWN_WATCH_MS = 15 * 60_000;

interface MintedToken {
  endpoint: RelayEndpoint;
  expiresAt: number;
}

export class AtlasDevice implements AtlasChats {
  readonly #options: AtlasDeviceOptions;
  readonly #fetch: typeof fetch;
  readonly #client: AcpClient;
  #token: MintedToken | undefined;
  /** Chats this device spawned and has not prompted yet, by conversation id. */
  readonly #fresh = new Map<string, AcpSessionHandle>();
  /** The relay request id of the last `session_spawn_request` sent, read by `spawn`. */
  #lastSpawnRequestId: string | undefined;

  constructor(options: AtlasDeviceOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#client = new AcpClient(
      {
        deviceId: options.deviceId,
        platform: 'backchannel-hub',
        getEndpoint: () => this.#endpoint(),
        seqMarks: (runId) => this.#seqMarks(runId),
      },
      {
        // The hub never renders a chat or answers for Josh; his own devices do.
        onSessionUpdate: () => {},
        onPermissionRequest: () => {},
        onElicitationRequest: () => {},
      },
    );
    // `spawnSession` mints the relay request id itself and does not return it. It is needed
    // when the spawn times out: the machine may still open the run afterwards, and that late
    // `session_opened` carries this id, so `spawn` can close the run rather than leave it.
    const connection = this.#client.connection;
    const sendControl = connection.sendControl.bind(connection);
    connection.sendControl = (payload: ControlMessage, machineId?: MachineId) => {
      if (payload.type === 'session_spawn_request') this.#lastSpawnRequestId = payload.requestId;
      sendControl(payload, machineId);
    };
    connection.onStatusChange((status) => log(`atlas relay ${status}`));
  }

  /** Opens the relay socket; it reconnects with backoff on its own after that. */
  start(): void {
    this.#client.connection.connect();
  }

  stop(): void {
    this.#client.dispose();
  }

  /** Waits for the socket; re-arms it if a refused credential left it disconnected. */
  async ready(): Promise<void> {
    const connection = this.#client.connection;
    if (connection.status === 'connected') return;
    if (connection.status === 'disconnected') connection.connect();
    const timeoutMs = this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    if (!(await connection.whenConnected(timeoutMs))) {
      throw new Error(`not connected to the Atlas relay after ${timeoutMs / 1000}s`);
    }
  }

  async machine(): Promise<MachineInfo> {
    await this.ready();
    const { machines } = await this.#client.connection.requestMachineList();
    const machine = machines.find((m) => m.machineId === this.#options.machineId);
    if (!machine) throw new Error(`Atlas machine ${this.#options.machineId} is not registered`);
    if (machine.status === 'offline') throw new Error(`Atlas machine ${machine.machineId} is offline`);
    return machine;
  }

  async spawn(cwd: string, requestId: string): Promise<ChatTarget> {
    const machine = await this.machine();
    this.#lastSpawnRequestId = undefined;
    const spawning = this.#client.spawnSession(
      machine.machineId,
      cwd,
      undefined,
      this.#options.approval,
      machine.mcpServers ?? [],
    );
    // `spawnSession` sends synchronously before its first await, so this is its request.
    const relayRequestId = this.#lastSpawnRequestId;
    let handle: AcpSessionHandle;
    try {
      handle = await spawning;
    } catch (err) {
      if (relayRequestId !== undefined) this.#closeLateRun(machine.machineId, relayRequestId, requestId);
      throw err;
    }
    this.#fresh.set(handle.acpSessionId, handle);
    log(`atlas chat opened request=${requestId} session=${handle.acpSessionId} run=${handle.envelopeSessionId}`);
    return { acpSessionId: handle.acpSessionId, machineId: handle.machineId, cwd: handle.cwd };
  }

  async deliver(chat: ChatTarget, text: string): Promise<DeliveryOutcome> {
    await this.ready();
    const fresh = this.#fresh.get(chat.acpSessionId);
    if (fresh) {
      this.#fresh.delete(chat.acpSessionId);
      return this.#prompt(fresh, text);
    }
    const run = await this.liveRun(chat.machineId, chat.acpSessionId);
    if (run?.turnOpen === true) {
      const steered = await this.#steer(run, text);
      if (steered !== 'no-turn') return steered;
      // The turn ended between the list and the steer; a prompt starts the next one.
    }
    // Never a second resume of a run that is already open: attach to it instead. If another
    // device opens it between the list and the resume, the relay answers `session_already_open`
    // and `resumeSession` attaches to that run.
    const handle = run
      ? await this.#client.attachSession(run)
      : await this.#client.resumeSession(
          chat.machineId,
          chat.acpSessionId,
          chat.cwd,
          undefined,
          this.#options.approval,
          (await this.machine()).mcpServers ?? [],
        );
    return this.#prompt(handle, text);
  }

  /** The live run holding this conversation, from the relay's session list. */
  async liveRun(machineId: MachineId, acpSessionId: string): Promise<SessionInfo | undefined> {
    const connection = this.#client.connection;
    const { promise, resolve, reject } = Promise.withResolvers<SessionInfo | undefined>();
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for the Atlas session list'));
    }, LIST_TIMEOUT_MS);
    const unsubscribe = connection.onFrame((frame) => {
      if (!isControlFrame(frame) || frame.payload.type !== 'session_list') return;
      if (frame.payload.machineId !== machineId) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(frame.payload.sessions.find((s) => s.acpSessionId === acpSessionId));
    });
    try {
      connection.sendControl({ type: 'session_list_request', machineId }, machineId);
    } catch (err) {
      clearTimeout(timer);
      unsubscribe();
      reject(err);
    }
    return promise;
  }

  /**
   * Sends one prompt and waits briefly for a refusal. omp answers a prompt only when its turn
   * ends, so after `PROMPT_ACCEPT_MS` without a refusal the turn is taken as running and this
   * device lets go of the session: Josh's own devices watch it, the hub does not need to.
   */
  async #prompt(handle: AcpSessionHandle, text: string): Promise<DeliveryOutcome> {
    const settled = this.#client.prompt(handle.envelopeSessionId, text).then(
      () => undefined,
      (err: unknown) => err ?? new Error('prompt rejected'),
    );
    const early = await withTimeout(settled, PROMPT_ACCEPT_MS);
    this.#client.closeSession(handle.envelopeSessionId);
    if (early === undefined || early === TIMED_OUT) return 'prompted';
    if (promptRefusedAsBusy(early)) {
      // A turn started between the list and the prompt; queue into it instead.
      const steered = await this.#steer({ sessionId: handle.envelopeSessionId, machineId: handle.machineId }, text);
      if (steered === 'no-turn') throw new Error('chat was busy, then idle, before the message could land');
      return steered;
    }
    // Lost transport says nothing about whether omp read the prompt; re-sending could run it twice.
    if (promptLostTransport(early)) return 'unconfirmed';
    throw early;
  }

  /** Queues `text` into the run's live turn; `no-turn` means it ended before the steer arrived. */
  async #steer(
    run: Pick<SessionInfo, 'sessionId' | 'machineId'>,
    text: string,
  ): Promise<'steered' | 'unconfirmed' | 'no-turn'> {
    const connection = this.#client.connection;
    const ts = Date.now();
    const { promise, resolve } = Promise.withResolvers<Extract<ControlMessage, { type: 'session_steer_result' }> | undefined>();
    const timer = setTimeout(() => {
      unsubscribe();
      resolve(undefined);
    }, STEER_RESULT_TIMEOUT_MS);
    const unsubscribe = connection.onFrame((frame) => {
      if (!isControlFrame(frame) || frame.payload.type !== 'session_steer_result') return;
      if (frame.payload.sessionId !== run.sessionId || frame.payload.ts !== ts) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(frame.payload);
    });
    try {
      connection.sendControl({ type: 'session_steer', sessionId: run.sessionId, text, ts }, run.machineId);
    } catch (err) {
      clearTimeout(timer);
      unsubscribe();
      throw err;
    }
    const result = await promise;
    if (result === undefined) return 'unconfirmed';
    if (result.accepted) return 'steered';
    if (result.reason === 'no-turn') return 'no-turn';
    throw new Error(`steer refused: ${result.reason ?? 'no reason given'}`);
  }

  /** Closes the run a timed-out spawn opens late, so it never becomes a second, empty chat. */
  #closeLateRun(machineId: MachineId, relayRequestId: string, requestId: string): void {
    const connection = this.#client.connection;
    const timer = setTimeout(() => unsubscribe(), LATE_SPAWN_WATCH_MS);
    const unsubscribe = connection.onFrame((frame) => {
      if (!isControlFrame(frame) || frame.payload.type !== 'session_opened') return;
      if (frame.payload.requestId !== relayRequestId) return;
      clearTimeout(timer);
      unsubscribe();
      try {
        connection.sendControl({ type: 'session_close_request', sessionId: frame.payload.session.sessionId }, machineId);
        log(`atlas closed late run=${frame.payload.session.sessionId} of failed spawn request=${requestId}`);
      } catch (err) {
        logError(`atlas could not close late run of spawn request=${requestId}`, err);
      }
    });
  }

  /**
   * The relay endpoint for this connection attempt, re-minted when the cached token is near
   * expiry. Throws on a failure that may pass (network, 5xx) so the connection retries with
   * backoff; resolves `undefined` when Access refuses the credential, which no retry fixes –
   * `ready()` re-arms the socket on the next wake instead.
   */
  async #endpoint(): Promise<RelayEndpoint | undefined> {
    if (this.#token && this.#token.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) return this.#token.endpoint;
    const res = await this.#fetch(new URL('/api/relay-token', this.#options.atlasUrl), {
      method: 'POST',
      redirect: 'manual',
      headers: { ...this.#accessHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: this.#options.deviceId }),
      signal: AbortSignal.timeout(10_000),
    });
    // Access answers a refused service token with a redirect to its login page.
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      logError('atlas relay token refused', new Error(`HTTP ${res.status}`));
      return undefined;
    }
    if (!res.ok) throw new Error(`relay token: HTTP ${res.status}`);
    const minted = parseMintedToken(await res.json());
    if (!minted) throw new Error('relay token: unexpected response shape');
    this.#token = minted;
    log(`atlas relay token minted for ${this.#options.deviceId}, valid until ${new Date(minted.expiresAt).toISOString()}`);
    return minted.endpoint;
  }

  /**
   * How far a run's history already reaches in D1, so a prompt sent after attaching is numbered
   * past it and lands in Josh's transcript (Atlas defect D15). Zero marks on failure: the prompt
   * still reaches the agent, it may only be missing from stored history.
   */
  async #seqMarks(runId: string): Promise<AttachSeq> {
    try {
      const res = await this.#fetch(new URL(`/api/sessions/${encodeURIComponent(runId)}/seq`, this.#options.atlasUrl), {
        headers: this.#accessHeaders(),
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as Partial<AttachSeq>;
      if (typeof body.outSeq !== 'number' || typeof body.inSeq !== 'number') throw new Error('unexpected shape');
      return { outSeq: body.outSeq, inSeq: body.inSeq };
    } catch (err) {
      logError(`atlas seq marks for run=${runId} unavailable`, err);
      return { outSeq: 0, inSeq: 0 };
    }
  }

  #accessHeaders(): Record<string, string> {
    return {
      'CF-Access-Client-Id': this.#options.accessClientId,
      'CF-Access-Client-Secret': this.#options.accessClientSecret,
    };
  }
}

export function parseMintedToken(body: unknown): MintedToken | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const { token, relayUrl, expiresAt } = body as Record<string, unknown>;
  if (typeof token !== 'string' || token === '') return undefined;
  if (typeof relayUrl !== 'string' || relayUrl === '') return undefined;
  if (typeof expiresAt !== 'number') return undefined;
  return { endpoint: { url: relayUrl, credential: token }, expiresAt };
}
