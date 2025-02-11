import { Client, TextChannel } from "discord.js";
import { ProxyAgent, fetch } from "undici";
import { readConfig } from "../config";
import { RedirectType } from "../redirectType";
import { userAgentService } from "./userAgentService";

export async function reportSite(
  site: string,
  client: Client,
  redirect: string,
) {
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

async function handleRedirect(
  redirectUrl: string,
  regex: RegExp,
  redirectType: RedirectType,
): Promise<[string | null, boolean]> {
  let location: string | null  = null;

  switch (redirectType) {
    case RedirectType.HTTP:
      location = await httpRedirect(redirectUrl);
      break;
    default:
      console.warn(`Redirect type ${redirectType} is supported yet`);
      throw new Error("Redirect type is supported");
  }

  return [location, location != null ? regex.test(location) : false];
}

async function httpRedirect(
  redirectUrl: string,
): Promise<string | null> {
  const { proxy } = await readConfig();
  const proxyAgent = new ProxyAgent(proxy);

  // fail hard if the user agent is not available - this ensures this is properly fixed
  const userAgent = await userAgentService.getUserAgent();
  if (userAgent == null) {
      throw new Error("Failed to get user agent");
  }

  // check redirect through proxy
  const response = await fetch(redirectUrl, {
    dispatcher: proxyAgent,
    redirect: "manual",
    headers: {
      "User-Agent": userAgent,
    },
  });

  return response.headers.get("location");
}
