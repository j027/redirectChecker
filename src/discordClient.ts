import { Client, GatewayIntentBits } from "discord.js";

export const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  rest: {
    makeRequest: globalThis.fetch.bind(globalThis) as never,
  },
});
