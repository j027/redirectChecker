import { Client, Events, GatewayIntentBits } from "discord.js";
import { Level } from "level";
import puppeteer from "puppeteer-extra";

const proxyChain = require("proxy-chain");
import { readConfig } from "./config";
import { commands } from "./commands/commands";
import { promises as fs } from "fs";
// the import below isn't unused but it gets marked at that for some reason
import { RequestInfo, RequestInit } from "node-fetch";
import { executablePath } from "puppeteer";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const { token } = await readConfig();

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

async function loadRedirect() {
  while (true) {
    const data = await fs.readFile("redirects.txt", { encoding: "utf-8" });

    let urlList = data.split("\n");
    urlList = urlList.filter((item) => item != "");
    if (urlList.length > 0) {
      const oldProxyUrl =
        "http://terriblename:C1qV9OqPHtNyaAqH_country-UnitedStates@proxy.packetstream.io:31112";
      const newProxyUrl = await proxyChain.anonymizeProxy({
        port: 8000,
        url: oldProxyUrl,
      });
      puppeteer.use(StealthPlugin());
      const browser = await puppeteer.launch({
        headless: true,
        executablePath: executablePath(),
        args: [`--proxy-server=${newProxyUrl}`],
      });
      for (const redirectURL of urlList) {

        const page = await browser.newPage();
        page.setDefaultNavigationTimeout(0); // disable navigation timeout
        // keep track of redirect path
        const redirects: string[] = [];
        const client = await page.target().createCDPSession();
        await client.send("Network.enable");
        client.on("Network.requestWillBeSent", (e) => {
          if (e.type !== "Document") {
            return;
          }
          redirects.push(e.documentURL);
        });

        // block unnecessary things from loading
        await page.setRequestInterception(true);
        page.on("request", (req) => {
          if (
            ["image", "font", "stylesheet", "media"].includes(
              req.resourceType()
            )
          ) {
            req.abort();
          } else {
            req.continue();
          }
        });
        try {
          await page.goto(redirectURL);
        }
        catch {}
        await page.waitForTimeout(10000);

        let pageTitle = await page.title();
        let currentURL = page.url();
        const db = new Level("lastRedirect", { valueEncoding: "json" });
        if (pageTitle.toLowerCase().includes("security")) {
          let lastURL = "";
          try {
            lastURL = await db.get(redirectURL);
          } catch {}
          if (lastURL != currentURL) {
            await reportSite(currentURL, redirects);
            await db.put(redirectURL, currentURL);
            await db.put(
              redirectURL + "redirectPath",
              JSON.stringify(redirects)
            );
            await db.put(
              redirectURL + "lastUpdated",
              Math.round(Date.now() / 1000).toString()
            );
          }
        }
        await db.put(redirectURL + "lastCheck", currentURL)
        await db.close();
        await page.close();
      }
      await browser.close();
      await proxyChain.closeAnonymizedProxy(newProxyUrl, true);

    } else {
      console.log("redirect list is empty, will check again in a minute");
    }
    await sleep(60000);
  }
}

function sleep(ms: number) {
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

  response = await fetch(
    "https://threatcenter.crdf.fr/api/v0/submit_url.json",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: "b810419e3a3376ecfc37a60706101493",
        method: "submit_url",
        urls: [site],
      }),
    }
  );
  console.log("crdf labs response " + (await response.text()));

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
loadRedirect();
