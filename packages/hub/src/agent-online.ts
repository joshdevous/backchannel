import { ActivityType, Client, GatewayIntentBits } from 'discord.js';
import { log, logError } from './log.ts';

/**
 * Discord shows a bot as online only while it holds a gateway connection. Josh's agent talks to
 * Discord over REST (from short-lived Atlas chats), so without this it always reads offline even
 * though the hub is listening for it. This keeps one minimal gateway session open as that bot.
 */
export async function keepAgentOnline(token: string): Promise<{ stop(): Promise<void> }> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
    presence: {
      status: 'online',
      activities: [{ type: ActivityType.Listening, name: 'Claude Central' }],
    },
  });
  client.on('error', (err) => logError('agent gateway error', err));
  await client.login(token);
  log('agent bot online');
  return {
    async stop() {
      await client.destroy();
    },
  };
}
