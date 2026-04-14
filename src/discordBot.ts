import { Events } from "discord.js";
import { setTimeout } from "timers/promises";
import { chromium } from "patchright";
import { readConfig } from "./config.js";
import { commands } from "./commands/commands.js";
import { closePool } from "./dbPool.js";
import { discordClient } from "./discordClient.js";
import {
  startRedirectChecker,
  stopRedirectChecker,
  startTakedownMonitor,
  stopTakedownMonitor,
  startAdHunter,
  stopAdHunter,
  startRedirectPruner,
  stopRedirectPruner,
  startEventLogPruner,
  stopEventLogPruner,
  startUrlscanHunter,
  stopUrlscanHunter,
  startHashListSync,
  stopHashListSync
} from "./services/schedulerService.js";
import { browserReportService } from "./services/browserReportService.js";
import { browserRedirectService} from "./services/browserRedirectService.js";
import { aiClassifierService } from "./services/aiClassifierService.js";
import { hunterService } from "./services/hunterService.js";
import { initializeGoogleWebRiskClient } from "./services/reportService.js";
import { initSafeBrowsingV5 } from "./services/safeBrowsingV5Service.js";
import { getLatestChromeVersion } from "./services/chromeUserAgentService.js";

/**
 * Compares bundled Chromium version against latest stable Chrome.
 * Logs a warning if they differ by more than 1 major version.
 */
async function checkChromiumVersionDrift(): Promise<void> {
  try {
    const browser = await chromium.launch({ headless: true });
    const bundledVersion = browser.version();
    await browser.close();

    const bundledMajor = parseInt(bundledVersion.split('.')[0]);
    const stableMajor = await getLatestChromeVersion();
    const drift = stableMajor - bundledMajor;

    if (drift > 1) {
      console.warn(`⚠️  CHROMIUM VERSION DRIFT: bundled Chromium ${bundledMajor}, stable Chrome ${stableMajor} (${drift} versions behind). Update patchright to avoid bot detection.`);
    } else {
      console.log(`Chromium version check OK: bundled ${bundledMajor}, stable ${stableMajor}`);
    }
  } catch (error) {
    console.error("Failed to check Chromium version drift:", error);
  }
}

async function initializeServices() {
  await aiClassifierService.init();
  await browserReportService.init();
  await browserRedirectService.init();
  await hunterService.init();
  await initializeGoogleWebRiskClient();
  await initSafeBrowsingV5();
  
  startRedirectChecker();
  startTakedownMonitor();
  startAdHunter();
  startRedirectPruner();
  startEventLogPruner();
  startHashListSync();

  // Start URLScan hunter if enabled in config
  const config = await readConfig();
  if (config.urlscanHunterEnabled) {
    startUrlscanHunter();
  }
}

async function shutdownServices() {
  stopAdHunter();
  stopUrlscanHunter();
  stopRedirectChecker();
  stopTakedownMonitor();
  stopRedirectPruner();
  stopEventLogPruner();
  stopHashListSync();

  console.log("Waiting for operations to cancel...");
  await setTimeout(5000); // wait for 5 seconds to allow operations to cancel
  // if you don't wait long enough, the bot will take a super long time to shut down

  const closes = [];
  closes.push(aiClassifierService.close());
  closes.push(browserReportService.close());
  closes.push(browserRedirectService.close());
  closes.push(hunterService.close());
  closes.push(closePool());

  await Promise.all(closes);
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
  await checkChromiumVersionDrift();

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

let isShuttingDown = false;

async function gracefulShutdown() {
  if (isTestMode || isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  
  console.log("Shutting down gracefully...");
  await shutdownServices();
  await discordClient.destroy();
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);

void main();
