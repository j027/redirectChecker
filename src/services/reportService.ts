import { readConfig } from "../config";
import { fetch, ProxyAgent } from "undici";
import { discordClient } from "../discordBot";
import { TextChannel } from "discord.js";
import { userAgentService } from "./userAgentService";
import { enqueueReport } from "./batchReportService";

async function reportToGoogleSafeBrowsing(site: string) {
  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
    throw new Error("Failed to get user agent");
  }

  await fetch(
    "https://safebrowsing.google.com/safebrowsing/clientreport/crx-report",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": userAgent },
      body: JSON.stringify([site]),
    },
  );
}

async function reportToUrlscan(site: string) {
  const { urlscanApiKey } = await readConfig();
  await fetch("https://urlscan.io/api/v1/scan/", {
    method: "POST",
    headers: {
      "API-Key": urlscanApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      url: site,
      visibility: "public",
    }),
  });
}

export async function reportSite(site: string, redirect: string) {
  // report to google safe browsing and urlscan.io
  const reports = [];
  reports.push(reportToGoogleSafeBrowsing(site));
  reports.push(reportToUrlscan(site));

  // send a message in the discord server with a link to the popup
  reports.push(sendMessageToDiscord(site, redirect));

  // netcraft and crdf labs go into a queue that is reported hourly
  enqueueReport(site);

  // wait for all the reports to finish
  await Promise.allSettled(reports);
}

async function sendMessageToDiscord(site: string, redirect: string) {
  const { channelId } = await readConfig();
  const channel = discordClient.channels.cache.get(channelId) as TextChannel;
  if (channel) {
    await channel.send(`Found ${site} from ${redirect}`);
  } else {
    console.error("Channel not found");
  }
}
