import { Browser } from "patchright";
import {
  blockGoogleAnalytics,
  blockPageResources,
  spoofWindowsChrome,
  parseProxy,
  simulateRandomMouseMovements,
  trackRedirectionPath
} from "../utils/playwrightUtilities.js";
import { BrowserManagerService } from './browserManagerService.js';
export class BrowserRedirectService {
  private browser: Browser | null;
  private browserInitializing: boolean;

  constructor() {
    this.browser = null;
    this.browserInitializing = false;
  }

  async init() {
    await this.ensureBrowserIsHealthy();
  }

  private async ensureBrowserIsHealthy(): Promise<void> {
    await BrowserManagerService.ensureBrowserHealth(
      this.browser,
      this.browserInitializing,
      async () => {
        try {
          this.browserInitializing = true;
          
          // Close existing browser if any
          await BrowserManagerService.closeBrowser(this.browser);
          
          // Create new browser
          this.browser = await BrowserManagerService.createBrowser(false);
          console.log("Browser redirect service initialized new browser");
        } finally {
          this.browserInitializing = false;
        }
      }
    );
  }

  async handleRedirect(
    redirectUrl: string,
    referrer?: string
  ): Promise<string | null> {
    await this.ensureBrowserIsHealthy();

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
    await spoofWindowsChrome(context, page);
    await blockGoogleAnalytics(page);
    await blockPageResources(page);

    try {
      const redirectTracker = trackRedirectionPath(page, redirectUrl);
      await page.goto(redirectUrl, { waitUntil: "commit", referer: referrer });

      // wait for the url to change
      await page.waitForURL("**");

      // randomly move mouse a bit (some redirects check for this)
      // then wait to ensure the new page loads
      await simulateRandomMouseMovements(page);
      await page.waitForTimeout(2000);

      let destinationUrl = page.url();

      // get last url with the same hostname as final destination
      // on error parsing the url, fall back to the final destination
      try {
        const redirectionPath = redirectTracker.getPath();
        const finalHostname = new URL(destinationUrl).hostname;
        let matchedUrl: string | null = null;
      
        for (let i = redirectionPath.length - 1; i >= 0; i--) {
          try {
            if (new URL(redirectionPath[i]).hostname === finalHostname) {
              matchedUrl = redirectionPath[i];
              break;
            }
          } catch {}
        }
      
        if (matchedUrl) {
          destinationUrl = matchedUrl;
        }
      } catch {
        // Fallback to page.url() if hostname can't be grabbed
        destinationUrl = page.url();
      }
      
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
