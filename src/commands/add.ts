import { SlashCommandBuilder } from "discord.js";
import { promises as fs } from "fs";
import { CommandDefinition } from "./commands";

export const addCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("add")
    .setDescription("Adds redirect to list of redirects")
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("The url that redirects to a popup")
        .setRequired(true)
    )
    .toJSON(),
  async execute(interaction) {
    const data = await fs.readFile("redirects.txt", { encoding: "utf-8" });

    let urlList = data.split("\n");
    urlList = urlList.filter((item) => item != "");
    let url = interaction.options.getString("url")!;
    let urlAlreadyThere = urlList.includes(url);

    if (!isValidUrl(url)) {
      await interaction.reply(
        `The url "${url}" is an invalid url, please make sure it's formatted correctly`
      );
      return;
    }

    if (urlAlreadyThere) {
      await interaction.reply(`This url "${url}" already exists in the list`);
      return;
    }

    urlList.push(url);
    let dataToWrite = urlList.join("\n");
    await fs.writeFile("redirects.txt", dataToWrite);
    await interaction.reply(`The url "${url}" was added to the list`);
  },
};

function isValidUrl(url: string) {
  try {
    return Boolean(new URL(url));
  } catch (e) {
    return false;
  }
}
