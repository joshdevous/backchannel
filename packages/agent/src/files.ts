import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import type { RawFile } from '@discordjs/rest';
import { deniedPathReason, restrictedReason, scanForSecrets } from '@backchannel/core';

/** Discord's default upload cap for servers without boosts. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 10;

export class RefusedError extends Error {}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

/** Text if it has no NUL bytes and decodes as UTF-8. Good enough to decide whether to secret-scan. */
export function decodeText(data: Uint8Array): string | null {
  if (data.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return null;
  }
}

/**
 * Extra path prefixes this machine never shares, on top of the built-in denylist:
 * `BACKCHANNEL_DENY_PATHS=/root/.config/,/srv/secrets/` (comma separated, `~` expanded).
 */
export function extraDeniedPrefixes(raw = process.env.BACKCHANNEL_DENY_PATHS ?? ''): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => resolve(expandHome(p)) + (p.endsWith('/') ? '/' : ''));
}

/**
 * Loads a file the agent wants to upload. Refuses denylisted paths (checked on both the path
 * given and where symlinks lead), Backchannel's own config/state, oversize files, and text files
 * that contain a secret.
 */
export function loadUpload(
  path: string,
  protectedPaths: readonly string[] = [],
  deniedPrefixes: readonly string[] = extraDeniedPrefixes(),
): RawFile {
  const given = resolve(expandHome(path));
  let real: string;
  try {
    real = realpathSync(given);
  } catch {
    throw new RefusedError(`File not found: ${path}`);
  }
  for (const candidate of [given, real]) {
    const reason = deniedPathReason(candidate);
    if (reason) throw new RefusedError(`Refused: ${path} matches the share denylist (${reason}).`);
    const prefix = deniedPrefixes.find((p) => candidate.startsWith(p));
    if (prefix) throw new RefusedError(`Refused: ${path} is under ${prefix}, which this machine never shares.`);
  }
  for (const protectedPath of protectedPaths) {
    if (real === resolve(protectedPath)) throw new RefusedError(`Refused: ${path} is Backchannel's own config or state.`);
  }
  const stats = statSync(real);
  if (!stats.isFile()) throw new RefusedError(`Not a regular file: ${path}`);
  if (stats.size > MAX_UPLOAD_BYTES) throw new RefusedError(`${path} is ${stats.size} bytes; Discord's upload limit is ${MAX_UPLOAD_BYTES}.`);

  const data = readFileSync(real);
  const text = decodeText(data);
  if (text !== null) {
    const hit = scanForSecrets(text);
    if (hit) throw new RefusedError(`Refused: ${path} looks like it contains a ${hit}. Nothing was posted.`);
    const restricted = restrictedReason(text);
    if (restricted) throw new RefusedError(`Refused: ${path} refers to ${restricted}, which never goes through Backchannel. Nothing was posted.`);
  }
  return { name: basename(given), data };
}
