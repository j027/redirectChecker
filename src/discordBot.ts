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
  startAdHunter,
  stopAdHunter,
  startRedirectPruner,
  stopRedirectPruner
} from "./services/schedulerService.js";
import { browserReportService } from "./services/browserReportService.js";
import { browserRedirectService} from "./services/browserRedirectService.js";
import { aiClassifierService } from "./services/aiClassifierService.js";
import { hunterService } from "./services/hunterService.js";
import { initializeGoogleWebRiskClient } from "./services/reportService.js";

export const discordClient = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

async function initializeServices() {
  await aiClassifierService.init();
  await browserReportService.init();
  await browserRedirectService.init();
  await hunterService.init();
  await initializeGoogleWebRiskClient();
  
  startRedirectChecker();
  startBatchReportProcessor();
  startTakedownMonitor();
  startAdHunter();
  startRedirectPruner();
}

async function shutdownServices() {
  await stopBatchReportProcessor();
  await stopAdHunter();
  stopRedirectChecker();
  stopTakedownMonitor();
  stopRedirectPruner();
  await aiClassifierService.close();
  await browserReportService.close();
  await browserRedirectService.close();
  await closePool();
}

const isTestMode = process.env.NODE_ENV === 'test';

async function main() {
  // do not start up the bot in test mode
  if (isTestMode) {
    return;
  }

  console.log("Starting up...");
  const { token } = await readConfig();
  await initializeServices();

  // Log in to Discord with your client's token
  console.log("Logging into discord");
  await discordClient.login(token);

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
  if (isTestMode) {
    return;
  }
  
  console.log("Shutting down gracefully...");
  await shutdownServices();
  await discordClient.destroy();
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

void main();
