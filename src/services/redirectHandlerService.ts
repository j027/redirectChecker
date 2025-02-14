import { TextChannel } from "discord.js";
import { discordClient } from "../discordBot";
import { ProxyAgent, fetch } from "undici";
import { readConfig } from "../config";
import { RedirectType } from "../redirectType";
import { userAgentService } from "./userAgentService";
import { queueCrdfLabsReport } from "./crdfLabsQueue";

async function reportToGoogleSafeBrowsing(site: string) {
  const { proxy } = await readConfig();
  const proxyAgent = new ProxyAgent(proxy);

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
      dispatcher: proxyAgent,
    },
  );
}

async function reportToNetcraft(site: string) {
  const { netcraftReportEmail, proxy } = await readConfig();
  const proxyAgent = new ProxyAgent(proxy);

  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
    throw new Error("Failed to get user agent");
  }

  await fetch("https://report.netcraft.com/api/v3/report/urls", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": userAgent },
    body: JSON.stringify({
      email: netcraftReportEmail,
      reason:
        "This is a suspected tech support scam popup." +
          "This was found by automatically checking redirects that go to tech support scam popups, so there may be potential errors",
      urls: [{ url: site, country: "US" }],
    }),
    dispatcher: proxyAgent,
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

export async function handleRedirect(
  redirectUrl: string,
  regex: RegExp,
  redirectType: RedirectType,
): Promise<[string | null, boolean]> {
  let location: string | null = null;

  switch (redirectType) {
    case RedirectType.HTTP:
      location = await httpRedirect(redirectUrl);
      break;
    case RedirectType.BrowserFingerprintPost:
      location = await browserFingerprintPost(redirectUrl);
      break;
    default:
      console.warn(`Redirect type ${redirectType} is supported yet`);
      throw new Error("Redirect type is supported");
  }

  return [location, location != null ? regex.test(location) : false];
}

async function httpRedirect(redirectUrl: string): Promise<string | null> {
  const { proxy } = await readConfig();
  const proxyAgent = new ProxyAgent(proxy);

  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
    throw new Error("Failed to get user agent");
  }

  // check redirect through proxy
  const response = await fetch(redirectUrl, {
    method: "POST",
    dispatcher: proxyAgent,
    redirect: "manual",
    headers: {
      "User-Agent": userAgent,
    },
  });

  return response.headers.get("location");
}

async function browserFingerprintPost(redirectUrl: string) : Promise <string | null> {
  const { proxy, browserFingerprintForRedirect } = await readConfig();
  const proxyAgent = new ProxyAgent(proxy);

  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
    throw new Error("Failed to get user agent");
  }

  // add the magical fingerprint that allows the redirect to work
  const data = new URLSearchParams();
  data.append("data", JSON.stringify(browserFingerprintForRedirect));

  const response = await fetch(redirectUrl, {
    dispatcher: proxyAgent,
    redirect: "manual",
    headers: {
      "User-Agent": userAgent,
    },
    body: data
  })

  return response.headers.get("location");
}
