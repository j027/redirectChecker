import { Browser } from "patchright";
import {
  blockGoogleAnalytics,
  parseProxy,
  spoofWindowsChrome,
  simulateRandomMouseMovements,
  trackRedirectionPath
} from "../utils/playwrightUtilities.js";
import { aiClassifierService } from "./aiClassifierService.js";
import pool from "../dbPool.js";
import { handleRedirect } from "../services/redirectHandlerService.js";
import { RedirectType } from "../redirectType.js";
import { BrowserManagerService } from "./browserManagerService.js";
import { SearchAdHunter } from "./searchAdHunter.js";
import { TyposquatHunter } from "./typosquatHunter.js";

// given a detected scam, confidence level above this will be treated as one
// this is because the image model has false positive issues otherwise
// eventually will use both image and html model with hopefully fewer false positives
export const CONFIDENCE_THRESHOLD = 0.98;

interface ProcessAdResult {
  screenshot: Buffer;
  html: string;
  redirectionPath: string[];
}

export class HunterService {
  private browser: Browser | null = null;
  private isHeadless: boolean = false;
  private browserInitializing: boolean = false;

  async init(headless = false) {
    this.isHeadless = headless;
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
          this.browser = await BrowserManagerService.createBrowser(
            this.isHeadless
          );
          console.log("Hunter service initialized new browser");
        } finally {
          this.browserInitializing = false;
        }
      }
    );
  }

  public async huntSearchAds() {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - search ad hunter failed"
      );
      return false;
    }

    const searchAdHunter = new SearchAdHunter(this.browser);
    const result = await searchAdHunter.huntSearchAds();
    return result;
  }

  public async huntTyposquat() {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null) {
      console.error("Browser has not been initiaized - typosquat hunter failed");
      return false;
    }

    const typosquatHunter = new TyposquatHunter(this.browser);
    const result = await typosquatHunter.huntTyposquat();
    return result;
  }

  public async processAd(
    adDestination: string,
    referer?: string
  ): Promise<ProcessAdResult | null> {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - ad hunter processor failed"
      );
      return null;
    }

    const context = await this.browser.newContext({
      proxy: await parseProxy(true),
      viewport: null,
    });

    const page = await context.newPage();
    let screenshot: Buffer | null = null;
    let html: string | null = null;
    let redirectionPath: string[] | null = null;

    try {
      await spoofWindowsChrome(context, page);
      await blockGoogleAnalytics(page);
      const redirectTracker = await trackRedirectionPath(page, adDestination);
      await page.goto(adDestination, { referer });

      await simulateRandomMouseMovements(page);
      await page.waitForTimeout(5000);
      await page.mouse.click(0, 0);

      screenshot = await page.screenshot();
      html = await page.content();
      redirectionPath = redirectTracker.getPath();
    } catch (error) {
      console.log(`There was an error when processing ad destination ${error}`);
      return null;
    } finally {
      await page.close();
      await context.close();
    }

    return { screenshot, html, redirectionPath };
  }

  /**
   * Attempts to automatically add a scam URL to the redirect checker
   * by trying different redirect strategies in sequence
   *
   * @param url The URL to add to the redirect checker
   * @returns True if successfully added, false if all strategies failed
   */
  public async tryAddToRedirectChecker(url: string): Promise<boolean> {
    console.log(`Attempting to add ${url} to redirect checker automatically`);

    // Extract domain from the incoming URL
    const domain = new URL(url).hostname.toLowerCase();

    // Check if domain already exists in the database
    const checkClient = await pool.connect();
    try {
      // Compare only hostnames (ignoring http/https)
      const query = `
        SELECT 1 
        FROM redirects 
        WHERE lower(
          regexp_replace(source_url, '^https?://([^/]+)/?.*$', '\\1')
        ) = $1
        LIMIT 1
      `;
      const result = await checkClient.query(query, [domain]);

      if (result.rowCount && result.rowCount > 0) {
        console.log(`Domain ${domain} already exists in redirect checker`);
        return true; // Already being monitored, consider this a success
      }
    } finally {
      checkClient.release();
    }

    // Try each redirect type in priority order
    const redirectTypesToTry = [
      RedirectType.HTTP,
      RedirectType.WeeblyDigitalOceanJs,
      RedirectType.BrowserRedirect,
      RedirectType.BrowserRedirectPornhub,
    ];

    for (const redirectType of redirectTypesToTry) {
      try {
        console.log(`Trying ${redirectType} for ${url}`);
        const redirectDestination = await handleRedirect(url, redirectType);

        if (redirectDestination) {
          console.log(`Got destination ${redirectDestination}, classifying...`);

          // Classify the destination URL
          try {
            const classificationResult =
              await aiClassifierService.classifyUrl(redirectDestination);
            if (classificationResult == null) {
              console.log("Failed to get classification result");
              continue; // Try next redirect type
            }

            const isScam = classificationResult.isScam;

            if (!isScam) {
              console.log(
                `Destination ${redirectDestination} not classified as scam, trying next redirect type`
              );
              continue; // Try next redirect type
            }

            // Found a working redirect that leads to a scam, add to database
            const client = await pool.connect();
            try {
              const insertQuery =
                "INSERT INTO redirects (source_url, type) VALUES ($1, $2)";
              await client.query(insertQuery, [url, redirectType]);
              console.log(
                `Successfully added ${url} to redirect checker as ${redirectType}`
              );
              return true;
            } finally {
              client.release();
            }
          } catch (classificationError) {
            console.log(`Classification failed: ${classificationError}`);
            continue; // Try next redirect type
          }
        }
      } catch (error) {
        console.log(`Failed with ${redirectType}: ${error}`);
        // Continue to next type
      }
    }

    console.log(
      `All redirect strategies failed or destinations were not classified as scams for ${url}`
    );
    return false;
  }

  public pgArray(values: string[]): string {
    if (!values || values.length === 0) return "{}";
    return (
      "{" + values.map((v) => `"${v.replace(/"/g, '""')}"`).join(",") + "}"
    );
  }

  /**
   * Strips query parameters from a URL for fuzzy matching
   * @param url The URL to strip query parameters from
   * @returns The base URL without query parameters
   */
  private stripQueryParameters(url: string): string {
    try {
      const parsedUrl = new URL(url);
      return `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
    } catch (e) {
      console.log(`Error stripping query parameters from URL: ${e}`);
      return url; // Return original if parsing fails
    }
  }

  /**
   * Finds existing destination record using fuzzy URL matching
   * @param url The URL to find a match for
   * @param adType The type of ad ("typosquat" or "search")
   * @returns The matching record ID or null if not found
   */
  public async findExistingDestination(url: string, adType: string, client: any): Promise<string | null> {
    // Strip query parameters for matching
    const strippedUrl = this.stripQueryParameters(url);
    
    try {
      // base URL matching without query parameters
      const query = `
        SELECT id, final_url FROM ads 
        WHERE ad_type = $1
        AND regexp_replace(final_url, '\\?.*$', '') = $2
        ORDER BY last_seen DESC
        LIMIT 1
      `;
      
      const result = await client.query(query, [adType, strippedUrl]);
      
      if (result.rowCount && result.rowCount > 0) {
        console.log(`Found fuzzy match for ${url}: ${result.rows[0].final_url}`);
        return result.rows[0].id;
      }
      
      return null;
    } catch (e) {
      console.error(`Error during fuzzy URL matching: ${e}`);
      return null;
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const hunterService = new HunterService();
