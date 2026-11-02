/**
 * Wakes Josh's agent (an Atlas chat) for Backchannel messages it should hear. Every chat is filed
 * in one of Josh's Atlas projects, chosen by the project classifier:
 * - a forum post (or thread in a forum) has one chat, whose project is classified once, when it
 *   is opened; the post keeps that chat afterwards;
 * - a plain channel like #general is classified every batch and has one chat per project it
 *   talks about, keyed by (channel, project).
 * A chat is opened on the first wake for its key and messaged after.
 */
import { isDirect } from '@backchannel/core';
import { firstBrief, followUp, type BriefContext, type ChatScope } from './atlas-brief.ts';
import type { AtlasChats } from './atlas-device.ts';
import { chatCwd, type AtlasProject } from './atlas-projects.ts';
import { UNFILED, type AtlasChat, type AtlasStore } from './atlas-store.ts';
import { log, logError } from './log.ts';
import type { TurnState, TypingStarter } from './presence.ts';
import type { Classification, ProjectRouting } from './project-classifier.ts';
import { visibleMessages, withoutRestricted } from './restrict.ts';
import { TIMED_OUT, withTimeout } from './timeout.ts';
import type { ChannelMessage, WakeEvent, Waker } from './waker.ts';

export interface AtlasWakerOptions extends BriefContext {
  store: AtlasStore;
  chats: AtlasChats;
  /** Picks each batch's project and files the chats this opens. */
  projects: ProjectRouting;
  /** Working directory of a chat whose project has no checkout on disk here (`ATLAS_WAKE_CWD`). */
  cwd: string;
  /** Whether a checkout directory exists; tests replace it. */
  dirExists?: (path: string) => boolean;
  /** Shows "typing…" as the agent's bot while its Atlas turn is open. Optional. */
  presence?: TypingStarter;
  now?: () => number;
  newRequestId?: () => string;
}

/** At most one spawn per chat key in this window (per post, or per channel and project). */
export const SPAWN_INTERVAL_MS = 10 * 60_000;
/** At most `MAX_WAKES_PER_HOUR` spawns and deliveries, across all channels, per sliding hour. */
export const MAX_WAKES_PER_HOUR = 120;
const HOUR_MS = 60 * 60_000;
/**
 * How long one wake waits for a spawn before moving on. The spawn itself keeps going and still
 * maps the chat key if it lands; until it settles, later wakes for that key are dropped rather
 * than opening a second chat.
 */
export const SPAWN_WAIT_MS = 3 * 60_000;
/**
 * A spawn still pending after this is treated as stuck and no longer blocks a new one. Well
 * past every timeout inside a spawn, and past the machine's 15 min reaping of a run nobody
 * handshook.
 */
export const SPAWN_STUCK_MS = 30 * 60_000;

/** How long a wake waits for the earlier messages before going on without them. */
const EARLIER_WAIT_MS = 10_000;

export type WakeDecision =
  | { kind: 'deliver' }
  | { kind: 'spawn' }
  | { kind: 'drop'; why: string };

/**
 * The limits, as a pure decision over the store, for the chat key (`channelId`, `projectId`).
 * `projectId` undefined is a forum post's key: the channel with whatever project it was filed
 * in. Exported for tests.
 */
export function decideWake(store: AtlasStore, channelId: string, projectId: string | undefined, now: number): WakeDecision {
  if (hourlyLimitReached(store, now)) {
    return { kind: 'drop', why: `hourly limit of ${MAX_WAKES_PER_HOUR} wakes reached` };
  }
  if (store.chat(channelId, projectId)) return { kind: 'deliver' };
  if (store.hasPendingSpawn(channelId, projectId, now - SPAWN_STUCK_MS)) {
    return { kind: 'drop', why: 'a spawn for this chat has not settled' };
  }
  const last = store.lastSpawnAt(channelId, projectId);
  if (last !== undefined && now - last < SPAWN_INTERVAL_MS) {
    return { kind: 'drop', why: `spawned ${Math.round((now - last) / 1000)}s ago, limit is one per ${SPAWN_INTERVAL_MS / 60_000} min` };
  }
  return { kind: 'spawn' };
}

function hourlyLimitReached(store: AtlasStore, now: number): boolean {
  return store.wakesSince(now - HOUR_MS) >= MAX_WAKES_PER_HOUR;
}

/** The project a new chat is opened for. */
interface Route {
  /** `UNFILED` when the project list was unavailable. */
  projectId: string;
  projectName: string;
  project: AtlasProject | undefined;
  scope: ChatScope;
}

export class AtlasWaker implements Waker {
  readonly #options: AtlasWakerOptions;
  readonly #now: () => number;
  readonly #newRequestId: () => string;
  /**
   * One wake at a time per chat key (a post, or a channel and project), so a second wake for a
   * key sees the first one's chat. Held through a spawn and until a message is sent, never
   * through classifying or waiting for the chat to accept it.
   */
  readonly #chains = new Map<string, Promise<void>>();

  constructor(options: AtlasWakerOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#newRequestId = options.newRequestId ?? (() => crypto.randomUUID());
    const abandoned = options.store.abandonPendingSpawns();
    if (abandoned > 0) log(`atlas wake: marked ${abandoned} spawn(s) from a previous run as failed`);
  }

  /** Settles once the batch is sent to a chat (or dropped); the chat's acceptance is logged later. */
  async wake(raw: WakeEvent): Promise<void> {
    const { store } = this.#options;
    // First of all, before any classifier or chat sees it: UKSBS never goes through Backchannel.
    const event = withoutRestricted(raw);
    if (!event) {
      log(`atlas wake dropped channel=${raw.channelId} messages=${raw.messages.length}: restricted`);
      return;
    }
    store.pruneWakes(this.#now() - 24 * HOUR_MS);
    let tag = `channel=${event.channelId} messages=${event.messages.length}`;
    // Before classifying: a batch that is dropped anyway costs no model call.
    if (hourlyLimitReached(store, this.#now())) {
      log(`atlas wake dropped ${tag}: hourly limit of ${MAX_WAKES_PER_HOUR} wakes reached`);
      return;
    }
    let earlierFetch: Promise<ChannelMessage[]> | undefined;
    const earlier = () => (earlierFetch ??= this.#earlier(event));

    // Classified at once, outside any lock: a batch never waits for another one's spawn or
    // delivery to be routed. A forum post keeps the chat (and project) it was first opened with,
    // so it is classified only when it has no chat yet and nothing is opening one. A plain
    // channel is classified every batch, with the project its previous batch went to as a hint,
    // and has one chat per project.
    const post = event.postTitle !== undefined;
    let classification: Classification | undefined;
    if (!post) {
      classification = await this.#options.projects.classify({
        channelName: event.channelName,
        messages: event.messages,
        earlier: await earlier(),
        hint: store.lastProject(event.channelId),
      });
      store.setLastProject(event.channelId, classification.name, this.#now());
      tag += classificationTag(classification);
    } else if (decideWake(store, event.channelId, undefined, this.#now()).kind === 'spawn') {
      classification = await this.#classifyPost(event, earlier);
      tag += classificationTag(classification);
    }
    const projectId = post ? undefined : (classification!.project?.id ?? UNFILED);
    const key = post ? event.channelId : `${event.channelId}/${projectId}`;
    await this.#locked(key, () => this.#route(event, tag, classification, projectId, earlier));
  }

  stop(): void {
    this.#options.chats.stop();
  }

  /** Runs `work` after every earlier `work` for `key` has finished. */
  #locked(key: string, work: () => Promise<void>): Promise<void> {
    const next = (this.#chains.get(key) ?? Promise.resolve()).then(work);
    this.#chains.set(key, next);
    void next.finally(() => {
      if (this.#chains.get(key) === next) this.#chains.delete(key);
    });
    return next;
  }

  #classifyPost(event: WakeEvent, earlier: () => Promise<ChannelMessage[]>): Promise<Classification> {
    return earlier().then((messages) =>
      this.#options.projects.classify({
        forumName: event.forumName,
        postTitle: event.postTitle,
        messages: event.messages,
        earlier: messages,
      }),
    );
  }

  /**
   * Under the chat key's lock: message its chat, open one, or drop the batch. `projectId`
   * undefined is a forum post, whose `classification` is unset when it was not needed.
   */
  async #route(
    event: WakeEvent,
    tag: string,
    classification: Classification | undefined,
    projectId: string | undefined,
    earlier: () => Promise<ChannelMessage[]>,
  ): Promise<void> {
    const { store } = this.#options;
    const post = projectId === undefined;
    const decision = decideWake(store, event.channelId, projectId, this.#now());
    if (decision.kind === 'drop') {
      log(`atlas wake dropped ${tag}: ${decision.why}`);
      return;
    }

    // Asked directly and about to act: show it at once, before the spawn or delivery takes its
    // time. An overheard (ambient) batch may well get no answer, so it shows nothing.
    if (isDirect(event.reason)) {
      this.#options.presence?.startTyping(event.channelId, () => this.#turnState(event.channelId, projectId));
    }

    try {
      if (decision.kind === 'deliver') {
        const chat = store.chat(event.channelId, projectId)!;
        store.recordWake(event.channelId, 'deliver', this.#now());
        const project = post ? ` project="${chat.projectName}"` : '';
        const { accepted } = await this.#options.chats.deliver(
          chat,
          followUp(event, this.#options, { projectName: chat.projectName, split: !post }),
        );
        log(`atlas wake sent ${tag}${project} session=${chat.acpSessionId}`);
        void accepted.then(
          (outcome) => log(`atlas wake ${outcome} session=${chat.acpSessionId}`),
          (err) => logError(`atlas wake refused ${tag}${project} session=${chat.acpSessionId}`, err),
        );
        return;
      }

      if (!classification) {
        // A post that gained a chat or a pending spawn while this wake was outside the lock, and
        // lost it again: rare enough to classify here.
        classification = await this.#classifyPost(event, earlier);
        tag += classificationTag(classification);
      }
      const route: Route = {
        projectId: classification.project?.id ?? UNFILED,
        projectName: classification.project?.name ?? '',
        project: classification.project,
        scope: { projectName: classification.project?.name ?? '', split: !post },
      };
      const requestId = this.#newRequestId();
      const now = this.#now();
      store.beginSpawn(requestId, event.channelId, route.projectId, now);
      store.recordWake(event.channelId, 'spawn', now);
      log(`atlas wake spawning ${tag} request=${requestId}`);
      const result = await withTimeout(this.#spawn(requestId, event, route, earlier), SPAWN_WAIT_MS);
      if (result === TIMED_OUT) log(`atlas wake still spawning after ${SPAWN_WAIT_MS / 1000}s request=${requestId}`);
    } catch (err) {
      logError(`atlas wake failed ${tag}`, err);
    }
  }

  /** Whether this chat key's chat has a turn open right now, from the relay's session list. */
  async #turnState(channelId: string, projectId: string | undefined): Promise<TurnState> {
    const chat = this.#options.store.chat(channelId, projectId);
    if (!chat) return 'unknown';
    const run = await this.#options.chats.liveRun(chat.machineId, chat.acpSessionId);
    return run?.turnOpen === true ? 'open' : 'closed';
  }

  /** The messages before the batch, for the classifier and a new chat's first brief. Best effort: none on failure. */
  async #earlier(event: WakeEvent): Promise<ChannelMessage[]> {
    if (!event.earlier) return [];
    try {
      const result = await withTimeout(event.earlier(), EARLIER_WAIT_MS);
      if (result !== TIMED_OUT) return visibleMessages(result);
      log(`atlas wake: earlier messages not fetched within ${EARLIER_WAIT_MS / 1000}s channel=${event.channelId}`);
    } catch (err) {
      logError(`atlas wake: could not fetch earlier messages channel=${event.channelId}`, err);
    }
    return [];
  }

  /**
   * One spawn attempt, settled in the store under its own request id whenever it finishes.
   * Resolves once the first prompt is sent; filing and the prompt's acceptance are logged later.
   */
  async #spawn(requestId: string, event: WakeEvent, route: Route, earlier: () => Promise<ChannelMessage[]>): Promise<void> {
    const { store, chats } = this.#options;
    const cwd = chatCwd(route.project, this.#options.cwd, this.#options.dirExists);
    let chat: AtlasChat;
    try {
      chat = {
        channelId: event.channelId,
        projectId: route.projectId,
        projectName: route.projectName,
        ...(await chats.spawn(cwd, requestId)),
      };
    } catch (err) {
      store.failSpawn(requestId, err instanceof Error ? err.message : String(err));
      logError(`atlas wake spawn failed channel=${event.channelId} request=${requestId}`, err);
      return;
    }
    if (!store.finishSpawn(requestId, chat, this.#now())) {
      log(
        `atlas wake: spawn request=${requestId} opened session=${chat.acpSessionId} but the chat key is already mapped; not prompting it`,
      );
      return;
    }
    // Mapped before the prompt goes out: whatever happens to the prompt, the next wake for
    // this key messages this chat instead of opening another. Filed alongside the prompt; a
    // failed filing leaves the chat where Atlas put it (by cwd) and is never retried by a spawn.
    void this.#file(chat);
    const where = `channel=${event.channelId} project="${chat.projectName}" cwd=${chat.cwd} request=${requestId} session=${chat.acpSessionId}`;
    try {
      const { accepted } = await chats.deliver(chat, firstBrief(event, this.#options, await earlier(), route.scope));
      log(`atlas wake spawned+sent ${where}`);
      void accepted.then(
        (outcome) => log(`atlas wake first prompt ${outcome} session=${chat.acpSessionId}`),
        (err) => logError(`atlas wake first prompt refused ${where}`, err),
      );
    } catch (err) {
      logError(`atlas wake first prompt failed ${where}`, err);
    }
  }

  async #file(chat: AtlasChat): Promise<void> {
    if (chat.projectId === UNFILED) return;
    try {
      await this.#options.projects.file(chat.projectId, chat.acpSessionId);
      log(`atlas chat filed session=${chat.acpSessionId} project="${chat.projectName}"`);
    } catch (err) {
      logError(`atlas chat filing failed session=${chat.acpSessionId} project="${chat.projectName}"`, err);
    }
  }
}

function classificationTag(c: Classification): string {
  return ` project="${c.name}" classify=${c.ms}ms${c.fallback !== undefined ? ` (default: ${c.fallback})` : ''}`;
}
