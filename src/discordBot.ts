import { Client, Events, GatewayIntentBits, TextChannel } from "discord.js";
import { ProxyAgent, fetch } from "undici";

import { readConfig } from "./config";
import { commands } from "./commands/commands";

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const { token } = await readConfig();

  // Log in to Discord with your client's token
  await client.login(token);

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.find(
      (it) => it.command.name === interaction.commandName,
    );

    if (!command) {
      console.error(
        `No command matching ${interaction.commandName} was found.`,
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

async function reportSite(site: string, client: Client, redirect: string) {
  const {
    channelId,
    netcraftReportEmail,
    urlscanApiKey,
    netcraftReportSource,
    proxy,
  } = await readConfig();

  // report to netcraft, google safe browsing, and urlscan.io
  const proxyAgent = new ProxyAgent(proxy);
  const reports = [];
  reports.push(
    fetch(
      "https://safebrowsing.google.com/safebrowsing/clientreport/crx-report",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([site]),
        dispatcher: proxyAgent,
      },
    ),
  );
  reports.push(
    fetch("https://report.netcraft.com/api/v3/report/urls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: netcraftReportEmail,
        source: netcraftReportSource,
        urls: [{ url: site }],
      }),
      dispatcher: proxyAgent,
    }),
  );
  reports.push(
    fetch("https://urlscan.io/api/v1/scan/", {
      method: "POST",
      headers: {
        "API-Key": urlscanApiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: site,
        visibility: "public",
      }),
    }),
  );

  // send all reports in parallel
  await Promise.allSettled(reports);

  // send a message in the discord server with a link to the popup
  const channel = client.channels.cache.get(channelId) as TextChannel;
  if (channel) {
    await channel.send(`Found new popup with url ${site} from ${redirect}`);
    console.log("Message sent to the channel");
  } else {
    console.error("Channel not found");
  }
}

void main();
