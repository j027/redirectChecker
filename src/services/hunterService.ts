import { chromium, Browser, Page, Frame } from "patchright";
import {
  blockGoogleAnalytics,
  parseProxy,
  spoofWindowsChrome,
  simulateRandomMouseMovements
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
        "Browser has not been initialized - search ad hunter failed"
      );
      return null;
    }

    const context = await this.browser.newContext({
      proxy: await parseProxy(true),
      viewport: null,
    });

    // not spoofing chrome on windows because that breaks ad load
    const page = await context.newPage();
    blockGoogleAnalytics(page);
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

      const adProcessRequests: Promise<void>[] = [];

      for (const adContainer of adContainers) {
        const adLink = await adContainer
          .getByRole("link")
          .first()
          .getAttribute("href");
        const adText = await adContainer.innerText();

        if (adLink == null) {
          console.log("Failed to get search ad link, trying the next ad");
          continue;
        }

        adProcessRequests.push(this.handleSearchAd(adLink, adText, searchUrl));
      }

      await Promise.allSettled(adProcessRequests);

      return true;
    } catch (error) {
      console.log(`Error while hunting for scams in search ads: ${error}`);
      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }

  private async handleSearchAd(adLink: string, adText: string, searchUrl: string) {
    // grab where the ad is going to, without opening the ad
    // this is because we want to avoid damaging ip quality
    let adDestination = new URL(adLink).searchParams.get("adurl");
    if (adDestination == null) {
      console.log("Failed to extract destination from search ad url");
      return;
    }

    adDestination = decodeURIComponent(adDestination);
    adDestination = this.canonicalizeSearchAdUrl(adDestination);

    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - search ad hunter failed"
      );
      return;
    }

    const context = await this.browser.newContext({
      proxy: await parseProxy(true),
      viewport: null,
    });

    const page = await context.newPage();
    spoofWindowsChrome(context, page);
    blockGoogleAnalytics(page);

    // will be used later to classify if it is a scam
    // and for storage in the database
    let screenshot : Buffer | null = null;
    let html : string | null = null;
    let redirectionPath : string[] | null = null;

    try {
      const redirectTracker = this.trackRedirectionPath(page);
      await page.goto(adDestination, {
        referer: "https://syndicatedsearch.goog/",
      });

      // randomly move mouse a bit (some redirects check for this)
      // then wait to ensure the new page loads
      await simulateRandomMouseMovements(page);
      await page.waitForTimeout(5000);

      // finally click, to ensure popup is fully activated
      await page.mouse.click(0, 0);

      screenshot = await page.screenshot();
      html = await page.content();
      redirectionPath = redirectTracker.getPath();

    } catch (error) {
      console.log(
        `There was an error when processing search ad destination ${error}`
      );
      return;
    } finally {
      page.close();
      context.close();
    }

    // TODO: classify popup with AI model, save info to database, and send discord message
  }

  private canonicalizeSearchAdUrl(adUrlRaw: string): string {
    // strip out parameters that are in the decoded url
    // that aren't actually there if you followed the redirect
    const url = new URL(adUrlRaw);
    const stripParams = [
      "q",
      "nb",
      "nm",
      "nx",
      "ny",
      "is",
      "_agid",
      "gad_source",
      "rid",
      "gclid",
    ];

    stripParams.forEach((param) => url.searchParams.delete(param));

    return url.toString();
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
    const randomSearchTerm = searchTerms[crypto.randomInt(searchTerms.length)];

    // Encode the search term to make it URL-safe
    const encodedSearchTerm = encodeURIComponent(randomSearchTerm);

    // Combine the search website and encoded search term
    return `${randomSearchWebsite}${encodedSearchTerm}`;
  }

  private trackRedirectionPath(page: Page) {
    const redirectionPath: Set<string> = new Set();

    const navigationListener = async (frame: Frame) => {
      if (frame === page.mainFrame()) {
        redirectionPath.add(frame.url());
      }
    };

    page.on("framenavigated", navigationListener);

    return {
      getPath: () => {
        return Array.from(redirectionPath);
      }
    };
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
