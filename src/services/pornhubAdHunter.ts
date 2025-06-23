import { Browser } from "patchright";
import { parseProxy, spoofWindowsChrome } from "../utils/playwrightUtilities.js";

export class PornhubAdHunter {
  private browser: Browser | null = null;

  constructor(browser: Browser) {
    this.browser = browser;
  }

  async huntPornhubAds(): Promise<boolean> {
    // TODO: use existing code to visit the parsed destination and classify
    // TODO: track the results in the database, sending a discord message
    // TODO: add commented out code that will be ready to automatically add cloakers discovered

    const adUrl = await this.getPornhubAdUrl();

    if (adUrl == null) {
      console.log("Failed to get pornhub ad url, giving up");
      return false;
    }

    const adDestination = this.canonicalizePornhubAdUrl(adUrl);
    if (adDestination == null) {
      console.log("Failed to canonicalize pornhub ad");
      return false;
    }

    console.log("Got a url", adDestination);

    return true;
  }

  private async getPornhubAdUrl(): Promise<string | null> {
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - pornhub ad hunter failed"
      );
      return null;
    }

    const context = await this.browser.newContext({
      proxy: await parseProxy(true),
      viewport: null,
    });

    const page = await context.newPage();

    try {
      // Make direct request to the ad API endpoint
      await spoofWindowsChrome(context, page);
      const response = await page.evaluate(async () => {
        const response = await fetch(
          "https://www.pornhub.com/_xa/ads_batch?data=%5B%7B%22spots%22%3A%5B%7B%22zone%22%3A30781%7D%5D%7D%5D"
        );
        return await response.json();
      });

      if (!response || !response[0] || !response[0].full_html) {
        console.log("Failed to get ad data or invalid response format");
        return null;
      }

      const adHtml = response[0].full_html;

      // Extract URL using regex
      const url = await page.evaluate((html) => {
        const regex = new RegExp('(?<=<a href=").+(?=" target)');
        const match = html.match(regex);
        return match ? match[0] : null;
      }, adHtml);

      if (!url) {
        console.log("Couldn't extract ad URL from HTML");
        return null;
      }

      return url;
    } catch (error) {
      console.error(`Error while fetching pornhub ads: ${error}`);
      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }

  private canonicalizePornhubAdUrl(url: string): string | null {
    try {
      let adDestination = new URL(url).searchParams.get("url");
      if (adDestination == null) {
        return null;
      }

      // decode until the string stops changing
      let prevValue = "";
      let maxIterations = 5;

      for (let i = 0; i < maxIterations && adDestination !== prevValue; i++) {
        prevValue = adDestination;
        adDestination = decodeURIComponent(adDestination);
      }

      return adDestination;
    } catch (error) {
      console.log("Error while trying to canonicalize pornhub ad url", error);
      return null;
    }
  }
}
