import { chromium, Browser } from "patchright";
import {
  blockGoogleAnalytics,
  blockPageResources,
  spoofWindowsChrome,
  parseProxy,
  simulateRandomMouseMovements,
} from "../utils/playwrightUtilities.js";
export class BrowserRedirectService {
  private browser: Browser | null;

  constructor() {
    this.browser = null;
  }

  async init() {
    this.browser = await chromium.launch({
      headless: false,
      executablePath: "/snap/bin/chromium",
      chromiumSandbox: true,
    });
  }

  async handleRedirect(
    redirectUrl: string,
    referrer?: string
  ): Promise<string | null> {
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - redirect handling failed"
      );
      return null;
    }

    const context = await this.browser.newContext({
      proxy: await parseProxy(),
      viewport: null,
    });

    const page = await context.newPage();
    await blockGoogleAnalytics(page);
    await blockPageResources(page);

    try {
      await spoofWindowsChrome(context, page);
      await page.goto(redirectUrl, { waitUntil: "commit", referer: referrer });

      // wait for the url to change
      await page.waitForURL("**");

      // randomly move mouse a bit (some redirects check for this)
      // then wait to ensure the new page loads
      await simulateRandomMouseMovements(page);
      await page.waitForTimeout(2000);

      const destinationUrl = page.url();

      return destinationUrl != redirectUrl ? destinationUrl : null;
    } catch (error) {
      console.log(`Error when handling redirect: ${error}`);
      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }

  async close() {
    if (this.browser == null) {
      return;
    }

    await this.browser.close();
  }
}

export const browserRedirectService = new BrowserRedirectService();
