import { Client, Events, GatewayIntentBits } from "discord.js";
import puppeteer from "puppeteer-extra";
import proxyChain from "proxy-chain";
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
    const oldProxyUrl =
      "http://terriblename:C1qV9OqPHtNyaAqH_country-UnitedStates@proxy.packetstream.io:31112";
    const newProxyUrl = await proxyChain.anonymizeProxy({
      port: 8000,
      url: oldProxyUrl,
    });
    puppeteer.use(StealthPlugin());
    const browser = await puppeteer.launch({
      headless: false,
      executablePath: executablePath(),
      args: [`--proxy-server=${newProxyUrl}`],
    });
    const data = await fs.readFile("redirects.txt", { encoding: "utf-8" });

    let urlList = data.split("\n");
    urlList = urlList.filter((item) => item != "");

    for (let i = 0; i < urlList.length; i++) {
      let redirectURL = urlList[i];

      const page = await browser.newPage();
      page.setDefaultNavigationTimeout(0); // disable navigation timeout
      // keep track of redirect path
      const redirects = [];
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
          ["image", "font", "stylesheet", "media"].includes(req.resourceType())
        ) {
          req.abort();
        } else {
          req.continue();
        }
      });
      await page.goto(redirectURL);
      await page.waitForNavigation({ waitUntil: ["networkidle0"] });

      let pageTitle = await page.title();
      if (pageTitle.toLowerCase().includes("security center")) {
        console.log("Popup detected");
        let currentURL = page.url();
        // TODO: fix this so it only reports on first occurrence - the state needs to be stored
        // it also needs to store when it last changed so the status command can display that info
        await reportSite(currentURL);
      }
      await page.close();
    }
    await browser.close();
    await proxyChain.closeAnonymizedProxy(newProxyUrl, true);
    await sleep(60000);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function reportSite(site: string) {
  // report to netcraft, google safebrowsing, crdflabs and urlscan

  let response = await fetch(
    "https://safebrowsing.google.com/safebrowsing/clientreport/crx-report",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify([site]),
    }
  );
  console.log("Safebrowsing response" + (await response.text()));

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
  const discordWebhook =
    "https://discord.com/api/webhooks/858323588910022706/2G21Sqpssz1AJDGKPGHruAAYnhCRCiRwl_ivWpKDnLB5rOqARKXYqd4m_2Wr3DF3_QhZ";
  response = await fetch(discordWebhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: site,
    }),
  });
  console.log("discord webhook response" + (await response.text()));
}

main();
loadRedirect();
