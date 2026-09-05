import { Browser } from "patchright";
import {
  blockGoogleAnalytics,
  blockMailtoLinks,
  blockPageResources,
  spoofWindowsChrome,
  parseProxy,
  simulateRandomMouseMovements,
  trackRedirectionPath
} from "../utils/playwrightUtilities.js";
import { BrowserManagerService } from './browserManagerService.js';
import { attachRequestLogger, RequestLogger, CapturedRequest } from '../utils/requestLogger.js';
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

  /**
   * Force restart the browser to clear any lingering state
   */
  public async restartBrowser(): Promise<void> {
    console.log("Restarting browser redirect service browser...");
    try {
      this.browserInitializing = true;
      this.browser = await BrowserManagerService.forceRestartBrowser(
        this.browser,
        false
      );
    } finally {
      this.browserInitializing = false;
    }
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
    referrer?: string,
    useHunterProxy? : boolean,
    captureRequests: boolean = false
  ): Promise<{ destination: string | null; requests: CapturedRequest[] }> {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null || !this.browser.isConnected()) {
      console.error(
        "Browser has not been initialized or has crashed - redirect handling failed"
      );
      return { destination: null, requests: [] };
    }

    const context = await this.browser.newContext({
      proxy: await parseProxy(useHunterProxy),
      viewport: null,
    });

    const page = await context.newPage();

    let loopDetected = false;
    let requestLogger: RequestLogger | null = null;

    try {
      // Inside try so a spoof failure fails closed (and still hits
      // the finally cleanup) like every other spoof call site.
      await spoofWindowsChrome(context, page);
      await blockGoogleAnalytics(page);
      await blockMailtoLinks(page);
      await blockPageResources(page);

      if (captureRequests) {
        requestLogger = await attachRequestLogger(page);
      }

      const redirectTracker = await trackRedirectionPath(page, redirectUrl);

      // Loop detection: track hostname frequency across navigations.
      // If any hostname appears too many times, abort by closing the page.
      const MAX_HOSTNAME_HITS = 4;
      const hostnameHits = new Map<string, number>();

      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        try {
          const hostname = new URL(frame.url()).hostname;
          const count = (hostnameHits.get(hostname) ?? 0) + 1;
          hostnameHits.set(hostname, count);
          if (count >= MAX_HOSTNAME_HITS) {
            loopDetected = true;
            console.log(`Redirect loop detected: ${hostname} appeared ${count} times — aborting`);
            page.close().catch(() => {});
          }
        } catch {}
      });

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
      
      return { destination: destinationUrl != redirectUrl ? destinationUrl : null, requests: requestLogger?.entries ?? [] };
    } catch (error) {
      if (loopDetected) {
        console.log(`Redirect loop aborted for ${redirectUrl}`);
      } else {
        console.log(`Error when handling redirect: ${error}`);
      }
      return { destination: null, requests: requestLogger?.entries ?? [] };
    } finally {
      requestLogger?.detach();
      await page.close().catch(() => {});
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
