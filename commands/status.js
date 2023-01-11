const { SlashCommandBuilder } = require("discord.js");
const fs = require("node:fs");
module.exports = {
  data: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Displays all redirects and their current status"),

  async execute(interaction) {
    interaction.reply("Not implemented");
  },
};
