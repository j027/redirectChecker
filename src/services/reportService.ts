import { readConfig } from "../config";
import { fetch } from "undici";
import { queueCrdfLabsReport } from "./crdfLabsQueue";
import { discordClient } from "../discordBot";
import { TextChannel } from "discord.js";
import { userAgentService } from "./userAgentService";

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

async function reportToNetcraft(site: string) {
  const { netcraftReportEmail, netcraftSourceExtension } = await readConfig();
  const androidUserAgent =
    "Dalvik/2.1.0 (Linux; U; Android 9; SM-G960N Build/PQ3A.190705.06121522)";

  await fetch("https://report.netcraft.com/api/v3/report/urls", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": androidUserAgent,
    },
    body: JSON.stringify({
      email: netcraftReportEmail,
      source: netcraftSourceExtension,
      urls: [{ url: site }],
    }),
  });
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

export async function reportToCrdfLabs(site: string) {
  const { crdfLabsApiKey } = await readConfig();
  await fetch("https://threatcenter.crdf.fr/api/v0/submit_url.json", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: crdfLabsApiKey,
      method: "submit_url",
      urls: [site],
    }),
  });
}

export async function reportSite(site: string, redirect: string) {
  // report to netcraft, google safe browsing, and urlscan.io
  const reports = [];
  reports.push(reportToGoogleSafeBrowsing(site));
  reports.push(reportToNetcraft(site));
  reports.push(reportToUrlscan(site));
  reports.push(queueCrdfLabsReport(site));

  // send a message in the discord server with a link to the popup
  reports.push(sendMessageToDiscord(site, redirect));

  // wait for all the reports to finish
  await Promise.allSettled(reports);
}

async function sendMessageToDiscord(site: string, redirect: string) {
  const { channelId } = await readConfig();
  const channel = discordClient.channels.cache.get(channelId) as TextChannel;
  if (channel) {
    await channel.send(`Found new popup with url ${site} from ${redirect}`);
    console.log("Message sent to the channel");
  } else {
    console.error("Channel not found");
  }
}
