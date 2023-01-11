import {
  ChatInputCommandInteraction,
  RESTPostAPIChatInputApplicationCommandsJSONBody,
} from "discord.js";
import { addCommand } from "./add";
import { statusCommand } from "./status";

export type CommandDefinition = {
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
  command: RESTPostAPIChatInputApplicationCommandsJSONBody;
};

export const commands: CommandDefinition[] = [
  addCommand,
  statusCommand,
  // todo: removeCommand
];
