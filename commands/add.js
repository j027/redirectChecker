const { SlashCommandBuilder } = require('discord.js');
const fs = require('node:fs');
module.exports = {
	data: new SlashCommandBuilder()
	.setName("add")
	.setDescription("Adds redirect to list of redirects")
	.addStringOption(option =>
		option
			.setName("url")
			.setDescription("The url that redirects to a popup")
			.setRequired(true)),
	async execute(interaction) {
		
		fs.readFile("redirects.txt", "utf8", (err, data) => {
			if (err) {
				console.error(err)
				interaction.reply("Error reading file");
				return;
			}

			let urlList = data.split("\n")
			urlList = urlList.filter(item => item != "")
			let url = interaction.options.getString("url")
			let urlAlreadyThere = urlList.includes(url)

			const isValidUrl = url => {
				try {
					return Boolean(new URL(url))
				}
				catch(e) {
					return false;
				}
			}

			if (!isValidUrl(url)) {
				interaction.reply(`The url "${url}" is an invalid url, please make sure it's formatted correctly`);
			}

			else if (!urlAlreadyThere) {
				urlList.push(url)
				let dataToWrite = urlList.join("\n")
				fs.writeFile("redirects.txt", dataToWrite, err => {
					if (err) {
						console.error(err)
					}
				})
				interaction.reply(`The url "${url}" was added to the list`);
			}

			else {
				interaction.reply(`This url "${url}" already exists in the list`);
			}

		})
	}
}