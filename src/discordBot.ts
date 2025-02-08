import { Client, Events, GatewayIntentBits, TextChannel } from "discord.js";

import { readConfig } from "./config";
import { commands } from "./commands/commands";

async function main() {

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const { token, proxy, channelId} = await readConfig();

  // Log in to Discord with your client's token
  await client.login(token);

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.find(
      (it) => it.command.name === interaction.commandName
    );

    if (!command) {
      console.error(
        `No command matching ${interaction.commandName} was found.`
      );
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: false,
      });
    }
  });
}


function timeout(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function reportSite(site: string, client: Client, channelId: string, redirect: string) {
  // report to netcraft, google safebrowsing, crdflabs and urlscan

  let response = await fetch(
    "https://safebrowsing.google.com/safebrowsing/clientreport/crx-report",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([site]),
    }
  );
  console.log("Safebrowsing response " + response.status.toString());

  response = await fetch("https://report.netcraft.com/api/v3/report/urls", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "josephcharles1234@gmail.com",
      source: "vsvgnMlBCnFTHVKRkbbghaW4I52cyjx5",
      urls: [{ url: site }],
    }),
  });
  console.log("netcraft response" + (await response.text()));

  response = await fetch("https://urlscan.io/api/v1/scan/", {
    method: "POST",
    headers: {
      "API-Key": "c893c2ce-be83-432e-830b-cfc217ddb381",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: site,
      visibility: "public",
    }),
  });
  console.log("urlscan response " + (await response.text()));

  // send a message in the discord server with a link to the popup
  const channel = client.channels.cache.get(channelId) as TextChannel;
  if (channel) {
    await channel.send(`Found new popup with url ${site} from ${redirect}`);
    console.log("Message sent to the channel");
  } else {
    console.error("Channel not found");
  }
}

main();
