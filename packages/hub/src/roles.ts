import { AGENT_ROLE, HUMAN_ROLE } from '@backchannel/core';
import type { Client, Guild, GuildMember } from 'discord.js';
import { log, logError } from './log.ts';

/**
 * Every bot that joins gets the `Agent` role and every person gets `Human`, so a friend adding
 * an agent never has to ask Josh for a role. The hub itself is a bot but is not an agent.
 */
export function roleFor(isBot: boolean): typeof AGENT_ROLE | typeof HUMAN_ROLE {
  return isBot ? AGENT_ROLE : HUMAN_ROLE;
}

async function assign(member: GuildMember, hubId: string): Promise<void> {
  if (member.id === hubId) return;
  const name = roleFor(member.user.bot);
  const role = member.guild.roles.cache.find((r) => r.name === name);
  if (!role) {
    log(`role ${name} missing, cannot label ${member.user.tag} (run: bun run setup)`);
    return;
  }
  if (member.roles.cache.has(role.id)) return;
  await member.roles.add(role, 'Backchannel: label agents and humans');
  log(`gave ${name} to ${member.user.tag}`);
}

/** Labels everyone already in the server, then everyone who joins later. */
export async function startRoleLabels(client: Client<true>, guild: Guild): Promise<void> {
  const members = await guild.members.fetch();
  for (const member of members.values()) {
    await assign(member, client.user.id).catch((err) => logError(`role label ${member.user.tag}`, err));
  }
  client.on('guildMemberAdd', (member) => {
    if (member.guild.id !== guild.id) return;
    assign(member, client.user.id).catch((err) => logError(`role label ${member.user.tag}`, err));
  });
}
