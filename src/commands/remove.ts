import { SlashCommandBuilder } from "discord.js";
import { CommandDefinition } from "./commands";
import { promises as fs } from "fs";

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
    const data = await fs.readFile("redirects.txt", { encoding: "utf-8" });

    let urlList = data.split("\n");
    urlList = urlList.filter((item) => item != "");
    let url = interaction.options.getString("url")!;
    let urlAlreadyThere = urlList.includes(url);

    if (urlAlreadyThere) {
      urlList = urlList.filter((item) => item != url);
      let dataToWrite = urlList.join("\n");
      await fs.writeFile("redirects.txt", dataToWrite);
      try {
        const db = new Level("lastRedirect", { valueEncoding: "json" });
        await db.del(url + "lastCheck")
        await db.del(url)
        await db.del(url + "lastUpdated")
        await db.del(url + "redirectPath")
        await db.close()
      }
      catch{}
      await interaction.reply(`The url ${url} was removed from the list`);
      return;
    }

    await interaction.reply("That redirect doesn't exist in the list");
  },
};
