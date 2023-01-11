const { SlashCommandBuilder } = require('discord.js');
const fs = require('node:fs');
module.exports = {
	data: new SlashCommandBuilder()
	.setName("remove")
	.setDescription("Removes redirect from list of redirects")
	.addStringOption(option =>
		option.setName("url")
			.setDescription("The url that redirects to a popup")
			.setRequired(true)),
	async execute(interaction) {
		interaction.reply("Not implemented");
	}
}