import {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { addCommand } from "./add.js";
import { statusCommand } from "./status.js";
import { removeCommand } from "./remove.js";
import { takedownStatusCommand } from "./takedownStatus.js";
import { reportCommand } from "./report.js";
import { hunterLogsCommand } from "./hunterLogs.js";
import { adsCommand } from "./ads.js";
import { redirectLogsCommand } from "./redirectLogs.js";
import { scamStatsDailyCommand } from "./scamStatsDaily.js";
import { scamStatsMonthlyCommand } from "./scamStatsMonthly.js";
import { urlscanStatsCommand } from "./urlscanStats.js";

export type CommandDefinition = {
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  command: RESTPostAPIChatInputApplicationCommandsJSONBody;
};

export const commands: CommandDefinition[] = [
  addCommand,
  statusCommand,
  removeCommand,
  takedownStatusCommand,
  reportCommand,
  hunterLogsCommand,
  adsCommand,
  redirectLogsCommand,
  scamStatsDailyCommand,
  scamStatsMonthlyCommand,
  urlscanStatsCommand
];
