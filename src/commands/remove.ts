import { SlashCommandBuilder } from "discord.js";
import { CommandDefinition } from "./commands";

const fs = require("node:fs");
export const removeCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Removes redirect from list of redirects")
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("The url that redirects to a popup")
        .setRequired(true)
    )
    .toJSON(),
  async execute(interaction) {
    await interaction.reply("Not implemented");
  },
};
