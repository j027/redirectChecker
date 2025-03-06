import { chromium, Browser, Page } from "patchright";
import { readConfig } from "../config.js";

export class BrowserRedirectService {
  private browser: Browser | null;

  constructor() {
    this.browser = null;
  }

  async init() {
    this.browser = await chromium.launch({ headless: false });
  }

  async handleRedirect(redirectUrl: string): Promise<string | null> {
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - redirect handling failed",
      );
      return null;
    }

    const context = await this.browser.newContext({
      proxy: {
        ...(await this.parseProxy()),
      },
    });

    const page = await context.newPage();
    await this.blockGoogleAnalytics(page);

    try {
      await page.goto(redirectUrl, { waitUntil: "commit" });

      // wait for the url to change
      await page.waitForURL("**");
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

  async handlePornhubRedirect(redirectUrl: string): Promise<string | null> {
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - redirect handling failed",
      );
      return null;
    }

    const context = await this.browser.newContext({
      proxy: {
        ...(await this.parseProxy()),
      },
      // HACK: redirect needs an old chrome version to work
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-ch-ua": "\"Not(A:Brand\";v=\"99\", \"Google Chrome\";v=\"133\", \"Chromium\";v=\"133\"",
      }
    });

    const page = await context.newPage();
    await this.blockGoogleAnalytics(page);

    try {
      await page.goto(redirectUrl, { waitUntil: "commit", referer: "https://www.pornhub.com/" });

      // wait for the url to change
      await page.waitForURL("**");
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

  private async parseProxy() {
    const { proxy } = await readConfig();

    // Parse proxy URL to extract username and password
    let server = proxy;
    let username = undefined;
    let password = undefined;

    try {
      const proxyUrl = new URL(proxy);

      // Check if there are auth credentials in the URL
      if (proxyUrl.username || proxyUrl.password) {
        username = decodeURIComponent(proxyUrl.username);
        password = decodeURIComponent(proxyUrl.password);

        // Reconstruct proxy URL without auth for server parameter
        server = `${proxyUrl.protocol}//${proxyUrl.host}${proxyUrl.pathname}${proxyUrl.search}`;
      }
    } catch (err) {
      console.error(`Failed to parse proxy URL: ${err}`);
    }

    return { server, username, password };
  }

  private async blockGoogleAnalytics(page: Page) {
    await page.route("https://www.google-analytics.com/g/collect*", (route) => {
      route.fulfill({
        status: 204,
        body: "",
      });
    });
  }

  async close() {
    if (this.browser == null) {
      return;
    }

    await this.browser.close();
  }
}

export const browserRedirectService = new BrowserRedirectService();
