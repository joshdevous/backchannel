/**
 * The project classifier's model calls, made through omp with Josh's Claude login (never an API
 * key). `OmpRpcLlm` keeps one omp running in RPC mode and sends each call as a prompt in a fresh
 * session, so a call costs the model round trip only (~0.7 s) instead of omp's ~3 s start;
 * `OmpLlm` runs `omp -p` once per call and is its fallback while that process is down.
 *
 * Both load `omp/classify-trim.ts`, which replaces omp's whole request with the classifier's own
 * instruction and one user message. The two travel inside the prompt text as
 * `classify:<base64 JSON>`, the only thing omp itself is asked.
 */
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, logError } from './log.ts';
import type { Llm, LlmAnswer } from './project-classifier.ts';
import { TIMED_OUT, withTimeout } from './timeout.ts';

export const DEFAULT_OMP_BIN = '/root/projects/.atlas-deploy/node_modules/.bin/omp';
export const CLASSIFIER_MODEL = 'anthropic/claude-haiku-4-5';
const OMP_DIR = fileURLToPath(new URL('../omp/', import.meta.url));
/** Read by `omp/classify-trim.ts`; keep the two in step. */
const PROMPT_PREFIX = 'classify:';

/** How long a started omp gets to print its `ready` frame. */
const READY_TIMEOUT_MS = 30_000;
/** After the RPC omp dies or fails to start, calls go to `omp -p` for this long before it is started again. */
export const RESTART_BACKOFF_MS = 30_000;

export interface OmpLlmOptions {
  /** `OMP_BIN`. */
  bin: string;
  model?: string;
}

/** The prompt omp is given: the classifier's instruction and message, for the trim extension. */
export function classifyPrompt(system: string, user: string): string {
  return PROMPT_PREFIX + Buffer.from(JSON.stringify({ system, user })).toString('base64');
}

/** The flags both modes share: the classifier model, nothing loaded but the trim extension. */
function ompArgs(options: OmpLlmOptions): string[] {
  return [
    '--model', options.model ?? CLASSIFIER_MODEL,
    '--thinking', 'off',
    // Replaced by the extension, like everything else in the request.
    '--system-prompt', 'Classify.',
    '--no-tools', '--no-extensions', '--no-skills', '--no-rules', '--no-lsp', '--no-session', '--no-title',
    '--config', `${OMP_DIR}overlay.yml`,
    '-e', `${OMP_DIR}classify-trim.ts`,
  ];
}

/**
 * Only what omp needs to find Josh's login: none of the hub's own secrets. omp is a
 * `#!/usr/bin/env bun` script, and the service's PATH lacks bun's directory.
 */
function ompEnv(): Record<string, string> {
  return {
    HOME: process.env.HOME ?? homedir(),
    PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin'}`,
  };
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** A message object from omp's JSON events; fields checked before use. */
interface OmpMessage {
  role?: unknown;
  provider?: unknown;
  stopReason?: unknown;
  content?: unknown;
  usage?: unknown;
}

interface OmpUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

/** The text and usage of one assistant message; throws unless Anthropic served it to the end. */
export function answerFromMessage(message: OmpMessage): LlmAnswer {
  if (message.provider !== 'anthropic') throw new Error(`reply came from ${String(message.provider)}, not anthropic`);
  if (message.stopReason !== undefined && message.stopReason !== 'stop') throw new Error(`reply stopped with ${String(message.stopReason)}`);
  const text = (Array.isArray(message.content) ? message.content : [])
    .map((part: unknown) =>
      typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && 'text' in part && typeof part.text === 'string'
        ? part.text
        : '',
    )
    .join('');
  const usage: OmpUsage = typeof message.usage === 'object' && message.usage !== null ? message.usage : {};
  const count = (value: unknown) => (typeof value === 'number' ? value : 0);
  return {
    text,
    usage: { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead), cacheWrite: count(usage.cacheWrite) },
  };
}

/** The reply in `omp -p --mode json` output: the last message carrying usage. */
export function parseOmpOutput(stdout: string): LlmAnswer {
  let last: OmpMessage | undefined;
  for (const line of stdout.split('\n')) {
    const parsed = parseLine(line);
    const message = parsed?.message;
    if (typeof message === 'object' && message !== null && 'usage' in message) last = message;
  }
  if (!last) throw new Error('omp printed no reply');
  return answerFromMessage(last);
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith('{')) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** One `omp -p` run per call. */
export class OmpLlm implements Llm {
  readonly #options: OmpLlmOptions;

  constructor(options: OmpLlmOptions) {
    this.#options = options;
  }

  async ask(system: string, user: string, timeoutMs: number): Promise<LlmAnswer> {
    const proc = Bun.spawn([this.#options.bin, '-p', '--mode', 'json', ...ompArgs(this.#options), classifyPrompt(system, user)], {
      cwd: '/tmp',
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: ompEnv(),
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(`omp exited with ${code}: ${oneLine(stderr || stdout, 300)}`);
      return parseOmpOutput(stdout);
    } finally {
      clearTimeout(timer);
    }
  }
}

type Frame = Record<string, unknown>;

interface Waiter {
  match: (frame: Frame) => boolean;
  promise: Promise<Frame>;
  resolve: (frame: Frame) => void;
  reject: (err: Error) => void;
}

/**
 * One `omp --mode rpc` process: JSON commands on stdin, one JSON frame per line on stdout.
 * Only what the classifier uses: `prompt` (acknowledged by a `response`, finished by a
 * `prompt_result` with the same id, the reply arriving before it as an assistant `message_end`)
 * and `new_session`.
 */
class RpcProcess {
  readonly ready: Promise<void>;
  readonly #proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>;
  readonly #waiters = new Set<Waiter>();
  #stderr = '';
  #dead: Error | undefined;
  #ids = 0;
  #lastReply: OmpMessage | undefined;

  /** `onExit` runs when the process ends, before any call waiting on it fails. */
  constructor(options: OmpLlmOptions, onExit: (code: number) => void) {
    this.#proc = Bun.spawn([options.bin, '--mode', 'rpc', '--no-ui', ...ompArgs(options)], {
      cwd: '/tmp',
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: ompEnv(),
    });
    this.ready = this.#next((f) => f.type === 'ready', READY_TIMEOUT_MS).then(async () => {
      // Only the reply and the frames answering commands; no streaming deltas.
      await this.#command({ type: 'set_event_filter', events: ['message_end'] });
    });
    void this.#readStdout();
    void this.#readStderr();
    void this.#proc.exited.then((code) => {
      onExit(code);
      this.#fail(new Error(`omp rpc exited with ${code}${this.#stderr ? `: ${oneLine(this.#stderr, 300)}` : ''}`));
    });
  }

  get alive(): boolean {
    return this.#dead === undefined;
  }

  /** One call: the prompt's reply. The session is reset afterwards by the caller. */
  async ask(text: string): Promise<LlmAnswer> {
    this.#lastReply = undefined;
    const result = await this.#command({ type: 'prompt', message: text }, (id) => (f) => f.type === 'prompt_result' && f.id === id);
    if (result.status !== 'completed') {
      const error = typeof result.error === 'object' && result.error !== null && 'message' in result.error ? String(result.error.message) : '';
      throw new Error(`omp rpc prompt ${String(result.status)}${error ? `: ${oneLine(error, 300)}` : ''}`);
    }
    if (!this.#lastReply) throw new Error('omp rpc printed no reply');
    return answerFromMessage(this.#lastReply);
  }

  /** Drops the conversation so far: every call starts from an empty session. */
  async reset(): Promise<void> {
    await this.#command({ type: 'new_session' });
  }

  kill(): void {
    this.#proc.kill();
  }

  /**
   * Sends a command and waits for its `response`; with `finish`, then for the frame `finish`
   * picks out (by the command's id) and returns that instead.
   */
  async #command(command: Frame, finish?: (id: string) => (frame: Frame) => boolean): Promise<Frame> {
    if (this.#dead) throw this.#dead;
    const id = `c${++this.#ids}`;
    const response = this.#next((f) => f.type === 'response' && f.id === id);
    const finished = finish ? this.#next(finish(id)) : undefined;
    // Settled by the process dying when the command never gets that far.
    finished?.catch(() => undefined);
    try {
      this.#proc.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      this.#proc.stdin.flush();
    } catch (err) {
      this.kill();
      throw err;
    }
    const ack = await response;
    if (ack.success !== true) {
      // A refused command owes no later frame: stop waiting for one.
      this.#forget(finished);
      throw new Error(`omp rpc ${String(command.type)} refused: ${String(ack.error ?? 'no reason')}`);
    }
    return finished ? await finished : ack;
  }

  #forget(promise: Promise<Frame> | undefined): void {
    for (const waiter of this.#waiters) if (waiter.promise === promise) this.#waiters.delete(waiter);
  }

  #next(match: (frame: Frame) => boolean, timeoutMs?: number): Promise<Frame> {
    if (this.#dead) return Promise.reject(this.#dead);
    const { promise, resolve, reject } = Promise.withResolvers<Frame>();
    const waiter: Waiter = { match, promise, resolve, reject };
    this.#waiters.add(waiter);
    if (timeoutMs === undefined) return promise;
    const timer = setTimeout(() => {
      this.#waiters.delete(waiter);
      reject(new Error(`omp rpc not ready after ${timeoutMs / 1000}s`));
      this.kill();
    }, timeoutMs);
    return promise.finally(() => clearTimeout(timer));
  }

  #fail(err: Error): void {
    this.#dead ??= err;
    for (const waiter of this.#waiters) waiter.reject(this.#dead);
    this.#waiters.clear();
  }

  async #readStdout(): Promise<void> {
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of this.#proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const frame = parseLine(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        if (frame) this.#onFrame(frame);
      }
    }
  }

  async #readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.#proc.stderr) {
      this.#stderr = (this.#stderr + decoder.decode(chunk, { stream: true })).slice(-2000);
    }
  }

  #onFrame(frame: Frame): void {
    const message = frame.message;
    if (frame.type === 'message_end' && typeof message === 'object' && message !== null && (message as OmpMessage).role === 'assistant') {
      this.#lastReply = message;
    }
    for (const waiter of this.#waiters) {
      if (!waiter.match(frame)) continue;
      this.#waiters.delete(waiter);
      waiter.resolve(frame);
    }
  }
}

export interface OmpRpcLlmOptions extends OmpLlmOptions {
  /** Used while the RPC process is down. */
  fallback: Llm;
  now?: () => number;
}

/**
 * One long-lived `omp --mode rpc` for every call, one call at a time, each in a fresh session.
 * Started by `start()` (so the first call finds it warm). A call that times out replaces it at
 * once; when it dies it is restarted `RESTART_BACKOFF_MS` later, and until then, or when it is
 * not ready by a call's deadline, calls go to `fallback`.
 */
export class OmpRpcLlm implements Llm {
  readonly #options: OmpRpcLlmOptions;
  readonly #now: () => number;
  #process: RpcProcess | undefined;
  #restartTimer: Timer | undefined;
  /** The previous call and its session reset: calls run one after another. */
  #tail: Promise<unknown> = Promise.resolve();
  #stopped = false;

  constructor(options: OmpRpcLlmOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /** Starts the process now rather than on the first call. */
  start(): void {
    this.#spawn();
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#restartTimer);
    this.#process?.kill();
    this.#process = undefined;
  }

  ask(system: string, user: string, timeoutMs: number): Promise<LlmAnswer> {
    const deadline = this.#now() + timeoutMs;
    const call = this.#tail.then(() => this.#ask(system, user, deadline));
    // The next call waits for this one's session reset too, never for its failure.
    this.#tail = call.then(
      () => this.#reset(),
      () => undefined,
    );
    return call;
  }

  async #ask(system: string, user: string, deadline: number): Promise<LlmAnswer> {
    const proc = this.#process?.alive ? this.#process : this.#restartTimer ? undefined : this.#spawn();
    const left = () => Math.max(0, deadline - this.#now());
    if (!proc) return this.#options.fallback.ask(system, user, left());
    try {
      const ready = await withTimeout(proc.ready, left());
      if (ready === TIMED_OUT) throw new Error('omp rpc still starting');
    } catch (err) {
      logError('classifier: omp rpc not ready, asking omp -p instead', err);
      return this.#options.fallback.ask(system, user, left());
    }
    const answer = await withTimeout(proc.ask(classifyPrompt(system, user)), left());
    if (answer === TIMED_OUT) {
      // Its turn may still be running, which would refuse the next prompt: start a fresh one.
      this.#replace(proc, 'gave no answer in time');
      throw new Error('omp rpc gave no answer in time');
    }
    return answer;
  }

  async #reset(): Promise<void> {
    const proc = this.#process;
    if (!proc?.alive) return;
    try {
      await proc.reset();
    } catch (err) {
      logError('classifier: omp rpc session reset failed', err);
      this.#replace(proc, 'could not reset its session');
    }
  }

  /** Kills `proc` and starts its successor now, without the crash backoff. */
  #replace(proc: RpcProcess, why: string): void {
    if (this.#process !== proc) return;
    log(`classifier: omp rpc ${why}; replacing it`);
    this.#process = undefined;
    proc.kill();
    this.#spawn();
  }

  #spawn(): RpcProcess | undefined {
    if (this.#stopped) return undefined;
    clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    let proc: RpcProcess;
    try {
      proc = new RpcProcess(this.#options, (code) => {
        if (this.#process !== proc || this.#stopped) return;
        this.#process = undefined;
        log(`classifier: omp rpc exited with ${code}; using omp -p, restarting in ${RESTART_BACKOFF_MS / 1000}s`);
        this.#scheduleRestart();
      });
    } catch (err) {
      logError('classifier: could not start omp rpc', err);
      this.#scheduleRestart();
      return undefined;
    }
    this.#process = proc;
    const started = this.#now();
    proc.ready.then(
      () => log(`classifier: omp rpc ready in ${this.#now() - started}ms`),
      () => undefined,
    );
    return proc;
  }

  #scheduleRestart(): void {
    if (this.#stopped) return;
    this.#restartTimer = setTimeout(() => this.#spawn(), RESTART_BACKOFF_MS);
    this.#restartTimer.unref();
  }
}
