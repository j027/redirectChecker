import { chromium, Browser, Page, Frame } from "patchright";
import {
  blockGoogleAnalytics,
  parseProxy,
  spoofWindowsChrome,
  simulateRandomMouseMovements
} from "../utils/playwrightUtilities.js";
import { aiClassifierService } from "./aiClassifierService.js";
import crypto from "crypto";
import pool from "../dbPool.js";
import { discordClient } from "../discordBot.js";
import { TextChannel } from "discord.js";
import { readConfig } from "../config.js";
import { handleRedirect } from "../services/redirectHandlerService.js";
import { RedirectType } from "../redirectType.js";

// given a detected scam, confidence level above this will be treated as one
// this is because the image model has false positive issues otherwise
// eventually will use both image and html model with hopefully fewer false positives
const CONFIDENCE_THRESHOLD = 0.98;

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

      // HACK: ensure the page has a few seconds to load
      await page.waitForTimeout(20000);

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

      // Batch processing configuration
      const BATCH_SIZE = 5;
      let successCount = 0;
      let failCount = 0;

      // Process ads in batches instead of all at once
      for (let i = 0; i < adContainers.length; i += BATCH_SIZE) {
        console.log(
          `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(adContainers.length / BATCH_SIZE)}`
        );

        const currentBatch = adContainers.slice(i, i + BATCH_SIZE);
        const batchRequests: Promise<void>[] = [];

        for (const adContainer of currentBatch) {
          const adLink = await adContainer
            .getByRole("link")
            .first()
            .getAttribute("href");
          const adText = await adContainer.innerText();

          if (adLink == null) {
            console.log("Failed to get search ad link, trying the next ad");
            continue;
          }

          batchRequests.push(this.handleSearchAd(adLink, adText, searchUrl));
        }

        // Process current batch and wait for all to complete
        const batchResults = await Promise.allSettled(batchRequests);

        // Log batch results
        batchResults.forEach((result) => {
          if (result.status === "fulfilled") {
            successCount++;
          } else {
            failCount++;
            console.log(`Failed ad processing: ${result.reason}`);
          }
        });

        console.log(
          `Batch ${Math.floor(i / BATCH_SIZE) + 1} complete: ${batchResults.length} ads processed`
        );
      }

      console.log(
        `Ad processing complete. Success: ${successCount}, Failed: ${failCount}`
      );
      return true;
    } catch (error) {
      console.log(`Error while hunting for scams in search ads: ${error}`);
      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }

  private async handleSearchAd(
    adLink: string,
    adText: string,
    searchUrl: string
  ) {
    // grab where the ad is going to, without opening the ad
    // this is because we want to avoid damaging ip quality
    const adDestination = this.canonicalizeSearchAdUrl(adLink);

    if (adDestination == null) {
      return;
    }

    const client = await pool.connect();
    try {
      // Check if this URL is already known to be a scam
      const existingAdQuery = await client.query(
        `SELECT id, is_scam FROM ads 
         WHERE initial_url = $1 AND ad_type = 'search'`,
        [adDestination]
      );

      const existingAd = existingAdQuery.rows[0];

      // If ad exists and is already marked as a scam, just update last_seen and return
      if (existingAd && existingAd.is_scam) {
        await client.query(
          `UPDATE ads SET last_seen = CURRENT_TIMESTAMP 
           WHERE id = $1`,
          [existingAd.id]
        );

        console.log(`Skipping already known scam ad: ${adDestination}`);
        return;
      }
    } finally {
      client.release();
    }

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
    blockGoogleAnalytics(page);

    // will be used later to classify if it is a scam
    // and for storage in the database
    let screenshot: Buffer | null = null;
    let html: string | null = null;
    let redirectionPath: string[] | null = null;

    try {
      spoofWindowsChrome(context, page);
      const redirectTracker = this.trackRedirectionPath(page, adDestination);
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
      await page.close();
      await context.close();
    }

    const classifierResult = await aiClassifierService.runInference(screenshot);

    try {
      const { isScam, confidenceScore } = classifierResult;
      const finalUrl =
        redirectionPath[redirectionPath.length - 1] || adDestination;

      await aiClassifierService.saveData(
        finalUrl,
        screenshot,
        html,
        classifierResult.isScam,
        classifierResult.confidenceScore
      );

      // Get a client from the pool for transaction support
      const client = await pool.connect();

      try {
        // Start transaction
        await client.query("BEGIN");

        // Check if ad exists
        const existingAdQuery = await client.query(
          `SELECT id, is_scam FROM ads 
           WHERE initial_url = $1 AND ad_type = 'search'`,
          [adDestination]
        );

        const existingAd = existingAdQuery.rows[0];

        if (existingAd) {
          // Update existing ad
          await client.query(
            `UPDATE ads SET 
               last_seen = CURRENT_TIMESTAMP,
               last_updated = CURRENT_TIMESTAMP,
               final_url = $1,
               redirect_path = $2,
               confidence_score = $3
             WHERE id = $4`,
            [
              finalUrl,
              this.pgArray(redirectionPath),
              confidenceScore,
              existingAd.id,
            ]
          );

          // Check if status changed
          if (existingAd.is_scam !== isScam) {
            await client.query(`UPDATE ads SET is_scam = $1 WHERE id = $2`, [
              isScam,
              existingAd.id,
            ]);

            // Add history record
            const reason = isScam
              ? `Changed to scam with confidence ${confidenceScore}`
              : `No longer classified as scam`;

            await client.query(
              `INSERT INTO ad_status_history 
               (ad_id, previous_status, new_status, reason)
               VALUES ($1, $2, $3, $4)`,
              [existingAd.id, existingAd.is_scam, isScam, reason]
            );

            console.log(
              `Ad status changed from ${existingAd.is_scam} to ${isScam}`
            );
            if (isScam && confidenceScore > CONFIDENCE_THRESHOLD) {
              await this.sendAdScamAlert(
                adDestination,
                finalUrl,
                adText,
                false,
                confidenceScore,
                redirectionPath
              );

              const addedToRedirectChecker =
                await this.tryAddToRedirectChecker(adDestination);
              console.log(
                `Auto-add to redirect checker for changed status: ${addedToRedirectChecker ? "Success" : "Failed"}`
              );
            }
          }

          console.log(`Updated existing ad: ${existingAd.id}`);
        } else {
          // Insert new ad
          const adId = crypto.randomUUID();

          await client.query(
            `INSERT INTO ads
             (id, ad_type, initial_url, final_url, redirect_path, is_scam, confidence_score)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              adId,
              "search",
              adDestination,
              finalUrl,
              this.pgArray(redirectionPath),
              isScam,
              confidenceScore,
            ]
          );

          await client.query(
            `INSERT INTO search_ads
             (ad_id, ad_url, ad_text, search_url)
             VALUES ($1, $2, $3, $4)`,
            [adId, adLink, adText, searchUrl]
          );

          console.log(`Inserted new ad: ${adId}, is_scam: ${isScam}`);
          if (isScam && confidenceScore > CONFIDENCE_THRESHOLD) {
            await this.sendAdScamAlert(
              adDestination,
              finalUrl,
              adText,
              true,
              confidenceScore,
              redirectionPath
            );

            const addedToRedirectChecker =
              await this.tryAddToRedirectChecker(adDestination);
            console.log(
              `Auto-add to redirect checker for new scam: ${addedToRedirectChecker ? "Success" : "Failed"}`
            );
          }
        }

        // Commit transaction
        await client.query("COMMIT");
      } catch (error) {
        // Rollback on error
        await client.query("ROLLBACK");
        throw error;
      } finally {
        // Always release the client back to the pool
        client.release();
      }
    } catch (dbError) {
      console.error(`Database error while processing ad: ${dbError}`);
    }
  }

  private async sendAdScamAlert(
    adDestination: string,
    finalUrl: string,
    adText: string,
    isNew: boolean = true,
    confidenceScore: number,
    redirectionPath: string[] | null = null
  ) {
    try {
      const { channelId } = await readConfig();
      const channel = discordClient.channels.cache.get(
        channelId
      ) as TextChannel;

      if (channel) {
        // Format confidence as percentage with 2 decimal places
        const confidencePercent = (confidenceScore * 100).toFixed(2);

        // Format ad text: clean up extra whitespace and limit length
        const formattedAdText = adText
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 150);

        // Build message components
        const header = isNew
          ? `🚨 NEW SCAM AD DETECTED 🚨 (Confidence: ${confidencePercent}%)`
          : `⚠️ EXISTING AD NOW MARKED AS SCAM ⚠️ (Confidence: ${confidencePercent}%)`;

        const adTextSection = `**Ad Text:**\n${formattedAdText}${formattedAdText.length >= 150 ? "..." : ""}`;

        // Build redirect path section
        let pathSection = "";
        if (redirectionPath && redirectionPath.length > 0) {
          pathSection = "**Redirect Path:**\n";
          redirectionPath.forEach((url, index) => {
            pathSection += `${index + 1}. ${url}\n`;
          });
        } else {
          pathSection = `**Initial URL:** ${adDestination}\n**Final URL:** ${finalUrl}`;
        }

        // Combine all sections
        const messageText = `${header}\n\n${adTextSection}\n\n${pathSection}`;

        await channel.send(messageText);
        console.log("Discord alert sent");
      } else {
        console.error("Ad hunter Discord channel not found");
      }
    } catch (error) {
      console.error(`Error sending Discord notification: ${error}`);
      // Don't throw - this is non-critical functionality
    }
  }

  /**
   * Extracts and normalizes the actual destination URL from a search ad link
   * @param adUrl The raw ad URL from search results
   * @returns The canonicalized destination URL or null if extraction fails
   */
  private canonicalizeSearchAdUrl(adUrl: string): string | null {
    try {
      let adDestination = new URL(adUrl).searchParams.get("adurl");
      if (adDestination == null) {
        console.log("Failed to extract destination from search ad url");
        return null;
      }

      adDestination = decodeURIComponent(adDestination);

      // strip out parameters that are in the decoded url
      // that aren't actually there if you followed the redirect
      const url = new URL(adDestination);
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

      adDestination = url.toString();

      // Handle DoubleClick redirect URLs
      if (
        adDestination.includes(
          "https://ad.doubleclick.net/searchads/link/click"
        )
      ) {
        const destUrl = new URL(adDestination).searchParams.get("ds_dest_url");

        if (destUrl == null) {
          console.log("Failed to extract destination from DoubleClick URL");
          return adDestination;
        }
        return destUrl;
      }

      return adDestination;
    } catch (error) {
      console.log(`Error canonicalizing URL ${error}`);
      return null;
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
    const randomSearchTerm = searchTerms[crypto.randomInt(searchTerms.length)];

    // Encode the search term to make it URL-safe
    const encodedSearchTerm = encodeURIComponent(randomSearchTerm);

    // Combine the search website and encoded search term
    return `${randomSearchWebsite}${encodedSearchTerm}`;
  }

  private trackRedirectionPath(page: Page, startUrl: string) {
    const redirectionPath: Set<string> = new Set();

    const navigationListener = async (frame: Frame) => {
      if (frame === page.mainFrame()) {
        redirectionPath.add(frame.url());
      }
    };

    // ensure the initial url is a part of the redirection path
    redirectionPath.add(startUrl);
    page.on("framenavigated", navigationListener);

    return {
      getPath: () => {
        return Array.from(redirectionPath);
      },
    };
  }

  /**
   * Attempts to automatically add a scam URL to the redirect checker
   * by trying different redirect strategies in sequence
   *
   * @param url The URL to add to the redirect checker
   * @returns True if successfully added, false if all strategies failed
   */
  private async tryAddToRedirectChecker(url: string): Promise<boolean> {
    console.log(`Attempting to add ${url} to redirect checker automatically`);

    // Check if URL already exists in the database
    const checkClient = await pool.connect();
    try {
      const query = "SELECT 1 FROM redirects WHERE source_url = $1 LIMIT 1";
      const result = await checkClient.query(query, [url]);

      if (result.rowCount && result.rowCount > 0) {
        console.log(`URL ${url} already exists in redirect checker`);
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

  private pgArray(values: string[]): string {
    if (!values || values.length === 0) return "{}";
    return (
      "{" + values.map((v) => `"${v.replace(/"/g, '""')}"`).join(",") + "}"
    );
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const hunterService = new HunterService();
