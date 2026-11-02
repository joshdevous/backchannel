/**
 * Who wrote a message, from the reading agent's point of view. Only `owner` and `trusted` messages
 * may be treated as instructions; `trusted` is a person the owner gave their own authority to by
 * Discord user id (`trustedIds`). See docs/design.md "Safety".
 */
export type FromKind = 'owner' | 'trusted' | 'human' | 'agent';

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
export function classifyAuthor(
  author: AuthorInfo,
  ownerId: string | undefined,
  agentRoleId?: string,
  trustedIds: readonly string[] = [],
): FromKind {
  if (ownerId && author.id === ownerId) return 'owner';
  // Bots never inherit authority, even if a bot's id is listed by mistake.
  if (!author.bot && author.id !== '' && trustedIds.includes(author.id)) return 'trusted';
  if (author.bot) return 'agent';
  if (agentRoleId && author.roleIds?.includes(agentRoleId)) return 'agent';
  return 'human';
}
