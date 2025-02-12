import { Client, Events, GatewayIntentBits, TextChannel } from "discord.js";

import { readConfig } from "./config";
import { commands } from "./commands/commands";
import { closePool } from "./dbPool";

export const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

async function main() {
  const { token } = await readConfig();

  // Log in to Discord with your client's token
  await discordClient.login(token);

  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.find(
      (it) => it.command.name === interaction.commandName,
    );

    if (!command) {
      console.error(
        `No command matching ${interaction.commandName} was found.`,
      );
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: false,
      });
    }
  });
}

// Graceful shutdown
async function gracefulShutdown() {
    console.log('Shutting down gracefully...');
    await closePool();
    await discordClient.destroy();
    process.exit(0);
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

void main();
