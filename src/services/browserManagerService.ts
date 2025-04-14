import { chromium, Browser } from "patchright";
import { setTimeout } from "timers/promises";

export class BrowserManagerService {
  // Static utility methods that can be used by any service

  /**
   * Checks if a browser instance is healthy
   * @param browser Browser instance to check
   * @returns true if healthy, false if not
   */
  static async isBrowserHealthy(browser: Browser | null): Promise<boolean> {
    if (!browser) return false;

    try {
      await browser.newContext().then((context) => context.close());
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Creates a new browser instance
   * @param isHeadless Whether to run in headless mode
   * @returns A new browser instance
   */
  static async createBrowser(isHeadless: boolean = false): Promise<Browser> {
    return await chromium.launch({
      headless: isHeadless,
      executablePath: "/var/lib/flatpak/exports/bin/org.chromium.Chromium",
      chromiumSandbox: true,
    });
  }

  /**
   * Base method for ensuring a browser is healthy
   * To be used by services managing their own browser instance
   * @param browser Current browser instance
   * @param isInitializing Flag indicating if browser is initializing
   * @param initCallback Function that initializes the browser
   */
  static async ensureBrowserHealth(
    browser: Browser | null,
    isInitializing: boolean,
    initCallback: () => Promise<void>
  ): Promise<void> {
    // Wait if initialization is already in progress
    if (isInitializing) {
      console.log("Browser initialization already in progress, waiting...");
      while (isInitializing) {
        await setTimeout(500);
      }
      return;
    }

    // If browser doesn't exist or isn't healthy, initialize it
    if (!browser || !(await BrowserManagerService.isBrowserHealthy(browser))) {
      await initCallback();
    }
  }

  /**
   * Safely closes a browser instance
   */
  static async closeBrowser(browser: Browser | null): Promise<void> {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.warn("Error closing browser:", error);
      }
    }
  }
}
