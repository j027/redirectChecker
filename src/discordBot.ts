import { Client, Events, GatewayIntentBits } from "discord.js";

import { readConfig } from "./config";
import { commands } from "./commands/commands";
import { promises as fs } from "fs";

async function main() {
  loadRedirect();

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const { token, proxy } = await readConfig();

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

async function trackRedirects(page: Page) {
  const redirects: string[] = [];
  const client = await page.target().createCDPSession();

  await client.send("Network.enable");
  client.on("Network.requestWillBeSent", (e) => {
    if (e.type !== "Document") {
      return;
    }
    redirects.push(e.documentURL);
  });

  return redirects;
}

async function acceptDialogs(page: Page) {
  await page.on("dialog", async (dialog) => {
    try {
      await dialog.accept();
    } catch (e) {}
  });
}

async function blockWebsites(page: Page) {
  const blockedSites = ["amazon.com", "facebook.com", "surfshark.com"];

  page.on("request", (request) => {
    const { action } = request.interceptResolutionState();
    if (action === InterceptResolutionAction.AlreadyHandled) return;

    if (blockedSites.some((domain) => request.url().includes(domain))) {
      request.abort("failed", DEFAULT_INTERCEPT_RESOLUTION_PRIORITY);
    } else {
      request.continue(
        request.continueRequestOverrides(),
        DEFAULT_INTERCEPT_RESOLUTION_PRIORITY
      );
    }
  });
}

async function checkAllRedirects() {
  if ((await getRedirects()).length <= 0) {
    console.log("redirect list is empty, will check again in a minute");
    return;
  }

  const oldProxyUrl =
    "http://terriblename:C1qV9OqPHtNyaAqH_country-UnitedStates@proxy.packetstream.io:31112";

  const newProxyUrl = await proxyChain.anonymizeProxy({
    port: 8000,
    url: oldProxyUrl,
  });

  puppeteer
    .use(
      adblockerPlugin({
        blockTrackersAndAnnoyances: true,
        interceptResolutionPriority: DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
      })
    )
    .use(stealthPlugin())
    .use(
      blockResourcesPlugin({
        blockedTypes: new Set(["image", "stylesheet", "font", "media"]),
        interceptResolutionPriority: DEFAULT_INTERCEPT_RESOLUTION_PRIORITY,
      })
    );
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: executablePath(),
    args: [`--proxy-server=${newProxyUrl}`],
  });

  try {
    for (const redirectURL of await getRedirects()) {
      const page = await browser.newPage();
      try {
        console.log("Checking url " + redirectURL);
        await checkRedirectsForPage(page, redirectURL);
      } catch (e) {
        console.error(e);
      } finally {
        //await page.close();
      }
    }
  } finally {
    console.log("Closing browser")
    await browser.close();
    await proxyChain.closeAnonymizedProxy(newProxyUrl, true);
  }
}

async function checkRedirectsForPage(page: Page, redirectURL: string) {
  page.setDefaultNavigationTimeout(0);
  const redirects = await trackRedirects(page);
  await blockWebsites(page);
  await acceptDialogs(page);

  await page.goto(redirectURL).catch((): any => null);
  await timeout(10000);

  let finalURL = page.url();
  const db = new Level("lastRedirect", { valueEncoding: "json" });
  try {
    if (await checkPage(page)) {
      let previousFinalURL = await db.get(redirectURL).catch((): any => null);

      const hasChanged = previousFinalURL != finalURL;
      if (hasChanged) {
        await reportSite(finalURL, redirects);
      }
      else {
        console.log("Already reported, so skipping the report")
      }

      await db.batch([
        {
          type: "put",
          key: redirectURL,
          value: finalURL,
        },
        {
          type: "put",
          key: redirectURL + "redirectPath",
          value: JSON.stringify(redirects),
        },
        {
          type: "put",
          key: redirectURL + "lastUpdated",
          value: Math.round(Date.now() / 1000).toString(),
        },
      ]);
    }

    await db.put(redirectURL + "lastCheck", finalURL);
  } finally {
    await db.close();
  }
}

async function getRedirects(): Promise<string[]> {
  const data = await fs.readFile("redirects.txt", { encoding: "utf-8" });
  let urlList = data.split("\n");
  urlList = urlList.filter((item) => item != "");
  return urlList;
}

async function checkPage(page: Page): Promise<boolean> {
  const pageTitle = await page.title();
  if (pageTitle.toLowerCase().includes("security")) {
    return true;
  }
  return (
    (await page.$("#poptxt")) != null || (await page.$("#alert-modal")) != null
  );
}

async function loadRedirect() {
  while (true) {
    await checkAllRedirects();
    await timeout(180000);
  }
}

function timeout(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function reportSite(site: string, redirectPath: string[]) {
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
  // using webhook since it's easier, maybe will change out for something else later
  const redirectPathReadable = redirectPath.join(" => ");
  const discordWebhook =
    "https://discord.com/api/webhooks/858323588910022706/2G21Sqpssz1AJDGKPGHruAAYnhCRCiRwl_ivWpKDnLB5rOqARKXYqd4m_2Wr3DF3_QhZ";
  response = await fetch(discordWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `${site} \n Redirect Path: ${redirectPathReadable}`,
    }),
  });
  console.log("discord webhook response " + response.status.toString());
}

main();
