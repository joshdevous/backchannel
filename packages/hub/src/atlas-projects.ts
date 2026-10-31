/**
 * Josh's Atlas projects, as the waker needs them: the catalogue the classifier picks from
 * (`GET /api/projects`), where a project's chats run on this machine, and filing a chat into a
 * project (`POST /api/projects/<id>/chats`). Both endpoints take Atlas's agent Access service
 * token, the same one the relay token is minted with.
 */
import { statSync } from 'node:fs';
import { log, logError } from './log.ts';

export interface AtlasProject {
  id: string;
  name: string;
  /** Name of the parent project, when nested. */
  parentName?: string;
  /** Empty when unset in Atlas. */
  description: string;
  /** Checkout paths on this hub's Atlas machine, in Atlas's order. */
  checkouts: string[];
}

/** What the waker needs from the catalogue. */
export interface ProjectCatalogue {
  /** The current projects; a stale list when a refresh fails, and throws only when there was never one. */
  projects(): Promise<readonly AtlasProject[]>;
  /** Files an Atlas conversation into a project. Throws on failure. */
  file(projectId: string, conversationId: string): Promise<void>;
}

export interface AtlasProjectsOptions {
  atlasUrl: string;
  accessClientId: string;
  accessClientSecret: string;
  /** Only checkouts on this machine count. */
  machineId: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** How long a fetched catalogue is used before it is fetched again. */
export const CATALOGUE_TTL_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The project list from `GET /api/projects`. Entries without an id or name are skipped; the
 * parent is resolved to its name; only `machineId`'s checkouts are kept.
 */
export function parseProjects(body: unknown, machineId: string): AtlasProject[] {
  const list = typeof body === 'object' && body !== null && 'projects' in body ? body.projects : undefined;
  if (!Array.isArray(list)) throw new Error('projects: unexpected response shape');
  // Every field is still `unknown` here and checked below before use, as in `parseMintedToken`.
  const entries = list.filter((p): p is RawProject => typeof p === 'object' && p !== null);
  const rows: { id: string; name: string; entry: RawProject }[] = [];
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || entry.id === '' || typeof entry.name !== 'string') continue;
    const name = entry.name.trim();
    if (name !== '') rows.push({ id: entry.id, name, entry });
  }
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return rows.map(({ id, name, entry }) => {
    const parentName = typeof entry.parentId === 'string' ? names.get(entry.parentId) : undefined;
    const checkouts: string[] = [];
    for (const c of Array.isArray(entry.checkouts) ? entry.checkouts : []) {
      if (typeof c !== 'object' || c === null || !('machineId' in c) || !('path' in c)) continue;
      if (c.machineId === machineId && typeof c.path === 'string' && c.path !== '') checkouts.push(c.path);
    }
    return {
      id,
      name,
      ...(parentName !== undefined ? { parentName } : {}),
      description: typeof entry.description === 'string' ? entry.description.trim() : '',
      checkouts,
    };
  });
}

/** One entry of `GET /api/projects` as received: nothing about it is trusted yet. */
interface RawProject {
  id?: unknown;
  name?: unknown;
  parentId?: unknown;
  description?: unknown;
  checkouts?: unknown;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Where a chat for `project` opens: its first checkout that exists on disk, else `fallback`. */
export function chatCwd(
  project: Pick<AtlasProject, 'checkouts'> | undefined,
  fallback: string,
  exists: (path: string) => boolean = isDirectory,
): string {
  return project?.checkouts.find((path) => exists(path)) ?? fallback;
}

export class AtlasProjects implements ProjectCatalogue {
  readonly #options: AtlasProjectsOptions;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  #cache: { projects: AtlasProject[]; fetchedAt: number } | undefined;
  #stale = false;
  #inflight: Promise<readonly AtlasProject[]> | undefined;

  constructor(options: AtlasProjectsOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  projects(): Promise<readonly AtlasProject[]> {
    const cache = this.#cache;
    if (cache && !this.#stale && this.#now() - cache.fetchedAt < CATALOGUE_TTL_MS) return Promise.resolve(cache.projects);
    this.#inflight ??= this.#refresh().finally(() => (this.#inflight = undefined));
    return this.#inflight;
  }

  async file(projectId: string, conversationId: string): Promise<void> {
    const res = await this.#fetch(new URL(`/api/projects/${encodeURIComponent(projectId)}/chats`, this.#options.atlasUrl), {
      method: 'POST',
      redirect: 'manual',
      headers: { ...this.#accessHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 404) {
      // The project is gone (or renamed into a new one): the next lookup fetches the list again.
      this.#stale = true;
      throw new Error(`project ${projectId} not found (HTTP 404); catalogue will be refetched`);
    }
    if (!res.ok) throw new Error(`filing: HTTP ${res.status}`);
  }

  async #refresh(): Promise<readonly AtlasProject[]> {
    try {
      const res = await this.#fetch(new URL('/api/projects', this.#options.atlasUrl), {
        redirect: 'manual',
        headers: this.#accessHeaders(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const projects = parseProjects(await res.json(), this.#options.machineId);
      if (!this.#cache) log(`atlas projects: ${projects.length} loaded`);
      this.#cache = { projects, fetchedAt: this.#now() };
      this.#stale = false;
      return projects;
    } catch (err) {
      if (!this.#cache) throw err;
      logError(`atlas projects: refresh failed, using the list from ${new Date(this.#cache.fetchedAt).toISOString()}`, err);
      return this.#cache.projects;
    }
  }

  #accessHeaders(): Record<string, string> {
    return {
      'CF-Access-Client-Id': this.#options.accessClientId,
      'CF-Access-Client-Secret': this.#options.accessClientSecret,
    };
  }
}
