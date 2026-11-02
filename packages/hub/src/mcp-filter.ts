import { isRestricted } from '@backchannel/core';
import type { AgentMcpServer } from '@atlas/shared-types';

/**
 * MCP servers a Backchannel-woken chat may never have, whatever the machine offers it. omp's ACP
 * mode loads MCP only from the servers the device passes on `session/new` / `session/resume`
 * (`enableMCP: false`, omp main.ts), so leaving a server out here is a hard boundary, not a
 * request. Atlassian is Josh's UKSBS Jira and Confluence; anything else naming UKSBS (a GitHub
 * server signed in as that account) matches the shared restricted list.
 */
const ALWAYS_BLOCKED = ['atlassian'];

function describes(server: AgentMcpServer): string {
  return 'url' in server ? `${server.name} ${server.url}` : `${server.name} ${server.command} ${server.args.join(' ')}`;
}

/** True when `server` must not reach a woken chat. `blocked` adds names from `ATLAS_WAKE_BLOCK_MCP`. */
export function isBlockedMcp(server: AgentMcpServer, blocked: readonly string[] = []): boolean {
  const text = describes(server);
  const lower = text.toLowerCase();
  return isRestricted(text) || [...ALWAYS_BLOCKED, ...blocked].some((term) => lower.includes(term.toLowerCase()));
}

export function allowedMcpServers(servers: readonly AgentMcpServer[], blocked: readonly string[] = []): AgentMcpServer[] {
  return servers.filter((server) => !isBlockedMcp(server, blocked));
}
