import { CommandDefinition } from "./commands";
import { SlashCommandBuilder } from "discord.js";
import { Level } from "level";
import { promises as fs } from "fs";

export const statusCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Displays all redirects and their current status")
    .toJSON(),

  async execute(interaction) {
    await interaction.reply("status be sent as a separate message soon");
    const data = await fs.readFile("redirects.txt", { encoding: "utf-8" });

    let urlList = data.split("\n");
    urlList = urlList.filter((item) => item != "");

    for (const redirectURL of urlList) {
      const db = await new Level("lastRedirect", { valueEncoding: "json" });
      let lastPopupRedirect
      try {
        lastPopupRedirect = await db.get(redirectURL);
      }
      catch {}
      let redirectPath
      try {
        redirectPath = await db.get(redirectURL + "redirectPath");
        redirectPath = JSON.parse(redirectPath).join(" => ");
      } catch {}
      let lastUpdatedFormatted
      try {
        lastUpdatedFormatted = await db.get(redirectURL + "lastUpdated");
        lastUpdatedFormatted = `<t:${lastUpdatedFormatted}:f>`;
      } catch {}
      let lastCheck
      try {
        lastCheck = await db.get(redirectURL + "lastCheck");
      } catch {}
      let discordWebhook =
        "https://discord.com/api/webhooks/1063132741392158902/9YwK9LCgUfSgTKNHeyYhesaVxnaNop0fU-T3jPll10PwFbIh_qY-soLEoIrhkwtFjiEh";
      let replyString = `
      Redirect URL: ${redirectURL}
      Last Popup Redirect: ${lastPopupRedirect}
      Popup Redirect last changed at: ${lastUpdatedFormatted}
      Redirect Path: ${redirectPath}
      Last Redirect: ${lastCheck}
      --------------------------------------------------------`;
      await db.close();
      let response = await fetch(discordWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: replyString,
        }),
      });
    }
  },
};
