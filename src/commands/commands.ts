import {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { addCommand } from "./add.js";
import { statusCommand } from "./status.js";
import { removeCommand } from "./remove.js";
import { takedownStatusCommand } from "./takedownStatus.js";

export type CommandDefinition = {
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  command: RESTPostAPIChatInputApplicationCommandsJSONBody;
};

export const commands: CommandDefinition[] = [
  addCommand,
  statusCommand,
  removeCommand,
  takedownStatusCommand
];
