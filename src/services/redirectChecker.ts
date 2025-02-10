import { Client, TextChannel } from "discord.js";
import { ProxyAgent, fetch } from "undici";
import { readConfig } from "../config";

export async function reportSite(site: string, client: Client, redirect: string) {
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

  // send a message in the discord server with a link to the popup
  reports.push(sendMessageToDiscord(client, channelId, site, redirect));

  // wait for all the reports to finish
  await Promise.allSettled(reports);
}

async function sendMessageToDiscord(
    client: Client<boolean>,
    channelId: string,
    site: string,
    redirect: string,
) {
    const channel = client.channels.cache.get(channelId) as TextChannel;
    if (channel) {
        await channel.send(`Found new popup with url ${site} from ${redirect}`);
        console.log("Message sent to the channel");
    } else {
        console.error("Channel not found");
    }
}