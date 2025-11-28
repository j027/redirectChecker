import { chromium, Browser } from "patchright";
import { setTimeout as setTimeoutPromise } from "timers/promises";

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
      // Check if browser is still connected
      if (!browser.isConnected()) {
        console.warn("Browser is not connected");
        return false;
      }
      
      // Try to create and close a context to verify it works with timeout
      const healthCheckPromise = browser.newContext().then((context) => context.close());
      const timeoutPromise = new Promise<never>((_, reject) => 
        setTimeout(() => reject(new Error("Health check timeout")), 5000)
      );
      
      await Promise.race([healthCheckPromise, timeoutPromise]);
      return true;
    } catch (error) {
      console.warn("Browser health check failed:", error);
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
      args: [
        // Disable GPU completely to prevent GLX/Vulkan errors
        '--disable-gpu',
        '--disable-software-rasterizer',
        
        // Disable GPU features
        '--disable-accelerated-2d-canvas',
        '--disable-accelerated-video-decode',
        
        // Don't use shared memory
        '--disable-dev-shm-usage',
        
        // Ignore GPU blocklist to force software rendering
        '--ignore-gpu-blocklist',
        
        // Use OSMesa for software GL rendering
        '--use-gl=swiftshader',
      ],
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
    initCallback: () => Promise<void>,
    maxRetries: number = 3
  ): Promise<void> {
    // Wait if initialization is already in progress
    if (isInitializing) {
      console.log("Browser initialization already in progress, waiting...");
      let waitTime = 0;
      while (isInitializing && waitTime < 10000) {
        await setTimeoutPromise(500);
        waitTime += 500;
      }
      if (waitTime >= 10000) {
        throw new Error("Browser initialization timed out");
      }
      return;
    }

    // If browser doesn't exist or isn't healthy, try to initialize it with retries
    if (!browser || !(await BrowserManagerService.isBrowserHealthy(browser))) {
      let lastError: Error | null = null;
      
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          console.log(`Attempting to initialize browser (attempt ${attempt}/${maxRetries})...`);
          await initCallback();
          
          // Verify browser was actually initialized and is healthy
          // Note: We can't directly check the browser here since it's managed by the service
          // The initCallback should handle setting the browser instance
          return;
        } catch (error) {
          lastError = error as Error;
          console.error(`Browser initialization attempt ${attempt} failed:`, error);
          
          if (attempt < maxRetries) {
            console.log(`Waiting 2 seconds before retry...`);
            await setTimeoutPromise(2000);
          }
        }
      }
      
      throw new Error(`Failed to initialize browser after ${maxRetries} attempts. Last error: ${lastError?.message}`);
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

  /**
   * Forcefully restarts a browser instance by closing it and creating a new one
   * This is useful for cleaning up any lingering tabs or browser state
   * @param browser Current browser instance
   * @param isHeadless Whether to run in headless mode
   * @returns A new browser instance
   */
  static async forceRestartBrowser(
    browser: Browser | null,
    isHeadless: boolean = false
  ): Promise<Browser> {
    console.log("Force restarting browser to clear lingering state...");
    
    // Close all existing contexts and the browser
    if (browser) {
      try {
        const contexts = browser.contexts();
        for (const context of contexts) {
          try {
            await context.close();
          } catch (error) {
            console.warn("Error closing browser context:", error);
          }
        }
        await browser.close();
      } catch (error) {
        console.warn("Error during browser restart:", error);
      }
    }

    // Create a fresh browser instance
    const newBrowser = await BrowserManagerService.createBrowser(isHeadless);
    console.log("Browser successfully restarted");
    return newBrowser;
  }
}
