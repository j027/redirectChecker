import { Client, Events, GatewayIntentBits } from "discord.js";

import { readConfig } from "./config.js";
import { commands } from "./commands/commands.js";
import { closePool } from "./dbPool.js";
import {
  startRedirectChecker,
  stopRedirectChecker,
  startBatchReportProcessor,
  stopBatchReportProcessor,
  startTakedownMonitor,
  stopTakedownMonitor,
} from "./services/schedulerService.js";
import { browserReportService } from "./services/browserReportService.js";
import { browserRedirectService} from "./services/browserRedirectService.js";

export const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

async function main() {
  console.log("Starting browsers");
  const { token } = await readConfig();
  await browserReportService.init();
  await browserRedirectService.init();

  // Log in to Discord with your client's token
  console.log("Logging into discord");
  await discordClient.login(token);
  startTakedownMonitor();
  startRedirectChecker();
  startBatchReportProcessor();

  console.log("Logged in and ready to go");

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

async function gracefulShutdown() {
  console.log("Shutting down gracefully...");
  stopRedirectChecker();
  stopTakedownMonitor();
  await Promise.allSettled([
    stopBatchReportProcessor(),
    browserReportService.close(),
    browserRedirectService.close(),
    closePool(),
    discordClient.destroy()
  ]);
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

void main();
