/**
 * Who wrote a message, from the reading agent's point of view. Only `owner` messages may be
 * treated as instructions; see docs/design.md "Safety".
 */
export type FromKind = 'owner' | 'human' | 'agent';

export interface AuthorInfo {
  id: string;
  /** Discord's `author.bot` flag. */
  bot?: boolean;
  /** Role ids of the author's guild member, when known. */
  roleIds?: readonly string[];
}

/**
 * The owner is checked first so a misconfigured owner id pointing at a bot still reads as the
 * owner (the config says so). Agents are bots or members of the `Agent` role.
 */
export function classifyAuthor(author: AuthorInfo, ownerId: string | undefined, agentRoleId?: string): FromKind {
  if (ownerId && author.id === ownerId) return 'owner';
  if (author.bot) return 'agent';
  if (agentRoleId && author.roleIds?.includes(agentRoleId)) return 'agent';
  return 'human';
}
