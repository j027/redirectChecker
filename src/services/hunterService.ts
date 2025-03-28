import { chromium, Browser } from "patchright";
import {
  blockGoogleAnalytics,
  parseProxy,
  spoofWindowsChrome,
} from "../utils/playwrightUtilities.js";
import crypto from "crypto";

export class HunterService {
  private browser: Browser | null = null;

  async init(headless = false) {
    try {
      // Launch our own browser instance
      this.browser = await chromium.launch({
        headless: headless,
        executablePath: "/snap/bin/chromium",
        chromiumSandbox: true,
      });
    } catch (error) {
      console.error("Error initializing scam hunter:", error);
      throw error;
    }
  }

  async huntSearchAds() {
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - redirect handling failed"
      );
      return null;
    }

    const context = await this.browser.newContext({
      proxy: await parseProxy(true),
      viewport: null,
    });

    // not spoofing chrome on windows because that breaks ad load
    const page = await context.newPage();
    const searchUrl = this.generateSearchUrl();

    try {
      await page.goto(searchUrl);

      // Wait for at least one ad frame to appear - max 30 seconds
      await page.waitForFunction(
        () => {
          return Array.from(document.querySelectorAll("iframe")).some(
            (iframe) =>
              iframe.src && iframe.src.includes("syndicatedsearch.goog")
          );
        },
        { timeout: 30000 }
      );

      // ads are in iframes, so need to grab all of them to be able to see the ads inside
      const adFrames = page
        .frames()
        .filter((frame) => frame.url().includes("syndicatedsearch.goog"));

      const adContainers = [];
      for (const frame of adFrames) {
        const ads = await frame
          .locator(`//span[text()="Sponsored"]/parent::*/parent::*`)
          .all();
        adContainers.push(...ads);
      }

      console.log(`Found ${adContainers.length} search ads`);

      const adProcessRequests = [];

      for (const adContainer of adContainers) {
        const adLink = await adContainer
          .getByRole("link")
          .first()
          .getAttribute("href");
        const adText = await adContainer.innerText();
        console.log(`${adText} - ${adLink}`);
      }

      return true;
    } catch (error) {
      console.log(`Error while hunting for scams in search ads: ${error}`);
      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }

  private generateSearchUrl() {
    const searchWebsites = [
      "https://www.chaseafterinfo.com/web?q=",
      "https://www.wefindalot.com/web?q=",
      "https://www.lookupsmart.com/web?q=",
      "https://www.find-info.co/serp?q=",
      "https://www.bestoftoday.co/web?q=",
    ];

    const searchTerms = [
      "my account login online",
      "login",
      "Free Recipes - Cooking Recipes - Dinner Ideas For Tonight",
      "account online",
      "how to check your account online",
      "online to account",
      "Online-Account-Login",
      "my account login",
      "www facebook com login",
      "amazon prime",
    ];

    const randomSearchWebsite =
      searchWebsites[crypto.randomInt(searchWebsites.length)];
    const randomSearchTerm =
      searchTerms[crypto.randomInt(searchWebsites.length)];

    // Encode the search term to make it URL-safe
    const encodedSearchTerm = encodeURIComponent(randomSearchTerm);

    // Combine the search website and encoded search term
    return `${randomSearchWebsite}${encodedSearchTerm}`;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
