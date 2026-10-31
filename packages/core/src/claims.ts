import { CLAIM_MARKER, RELEASE_MARKER } from './constants.ts';

/**
 * Claim bookkeeping (docs/design.md "Claims"). Markers are ordinary messages whose first line
 * starts with CLAIM_MARKER or RELEASE_MARKER. The earliest claim marker after the latest
 * release marker wins; Discord snowflakes give the order.
 */

export interface MarkerMessage {
  id: string;
  authorId: string;
  authorName: string;
  content: string;
}

export interface ClaimHolder {
  authorId: string;
  authorName: string;
  /** Id of the winning claim marker message. */
  markerId: string;
}

export interface ClaimState {
  holder: ClaimHolder | null;
  /** Claim markers posted after the latest release, oldest first (winner included). */
  markers: MarkerMessage[];
}

function firstLine(content: string): string {
  const newline = content.indexOf('\n');
  return newline === -1 ? content : content.slice(0, newline);
}

export function isClaimMarker(content: string): boolean {
  return firstLine(content).startsWith(CLAIM_MARKER);
}

export function isReleaseMarker(content: string): boolean {
  return firstLine(content).startsWith(RELEASE_MARKER);
}

export function claimMarkerText(agentName: string, note?: string): string {
  return note ? `${CLAIM_MARKER} ${agentName}\n${note}` : `${CLAIM_MARKER} ${agentName}`;
}

export function releaseMarkerText(agentName: string, status: string, note?: string): string {
  const line = `${RELEASE_MARKER} ${agentName} – now ${status}`;
  return note ? `${line}\n${note}` : line;
}

/** Snowflakes are 64-bit, so compare as BigInt rather than as numbers or strings. */
export function compareSnowflakes(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/**
 * Resolve who holds a post from its messages, in any order. Only messages written by bots
 * should be passed in, so a human typing the marker text by hand cannot claim on an agent's
 * behalf; the caller decides that.
 */
export function resolveClaim(messages: readonly MarkerMessage[]): ClaimState {
  const sorted = [...messages].sort((a, b) => compareSnowflakes(a.id, b.id));
  let markers: MarkerMessage[] = [];
  for (const message of sorted) {
    if (isReleaseMarker(message.content)) markers = [];
    else if (isClaimMarker(message.content)) markers.push(message);
  }
  const first = markers[0];
  return {
    holder: first ? { authorId: first.authorId, authorName: first.authorName, markerId: first.id } : null,
    markers,
  };
}
