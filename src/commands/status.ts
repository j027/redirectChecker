import { CommandDefinition } from "./commands";
import { SlashCommandBuilder } from "discord.js";

export const statusCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Displays all redirects and their current status")
    .toJSON(),

  async execute(interaction) {
    await interaction.reply("Not implemented");
  },
};
