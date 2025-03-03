import { readConfig } from "../config.js";
import { fetch, ProxyAgent } from "undici";
import { discordClient } from "../discordBot.js";
import { TextChannel } from "discord.js";
import { userAgentService } from "./userAgentService.js";
import { enqueueReport } from "./batchReportService.js";
import { browserReportService } from "./browserReportService.js";

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

interface NetcraftApiResponse {
  message: string;
  uuid: string;
}

async function reportToNetcraft(site: string) {
  const { netcraftReportEmail } = await readConfig();

  const response = await fetch("https://report.netcraft.com/api/v3/report/urls", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: netcraftReportEmail,
      urls: [{ url: site, country: "US" }],
    }),
  }).then(r => r.json()) as NetcraftApiResponse;

  console.info(`Netcraft report message: ${response?.message} uuid: ${response?.uuid}`);
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

interface VirusTotalResponse {
  data: {
    id: string;
    type: string;
  };
}

async function reportToVirusTotal(site: string) {
  const { virusTotalApiKey } = await readConfig();
  const response = await fetch("https://www.virustotal.com/api/v3/urls", {
    method: "POST",
    headers: {
      "x-apikey": virusTotalApiKey
    },
    body: new URLSearchParams({
      url: site
    })
  }).then(r => r.json()) as VirusTotalResponse;

  console.info(`VirusTotal report id: ${response?.data?.id}`);
}

export async function reportSite(site: string, redirect: string) {
  // report to google safe browsing, netcraft, virustotal, and microsoft smartscreen
  const reports = [];
  reports.push(reportToNetcraft(site));
  reports.push(reportToGoogleSafeBrowsing(site));
  reports.push(reportToVirusTotal(site));
  reports.push(browserReportService.reportToSmartScreen(site));

  // send a message in the discord server with a link to the popup
  reports.push(sendMessageToDiscord(site, redirect));

  // crdf labs reports go into a queue that is reported every minute
  enqueueReport(site);

  // wait for all the reports to finish
  await Promise.allSettled(reports);

  // report to urlscan last, to ensure that my netcraft report credits more often
  // otherwise the popup scanner scraping urlscan sometimes reports before I can and gets the credit
  await reportToUrlscan(site);
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
