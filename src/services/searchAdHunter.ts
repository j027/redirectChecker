import { Browser } from "patchright";
import { hunterService, CONFIDENCE_THRESHOLD } from "./hunterService.js";
import { aiClassifierService } from "./aiClassifierService.js";
import {
  parseProxy,
  blockGoogleAnalytics,
} from "../utils/playwrightUtilities.js";
import pool from "../dbPool.js";
import crypto from "crypto";
import { sendAdScamAlert } from "./alertService.js";

export class SearchAdHunter {
  private browser: Browser | null = null;

  constructor(browser: Browser) {
    this.browser = browser;
  }

  async huntSearchAds() {
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - search ad hunter failed"
      );
      return false;
    }

    const context = await this.browser.newContext({
      proxy: await parseProxy(true),
      viewport: null,
    });

    // not spoofing chrome on windows because that breaks ad load
    const page = await context.newPage();
    const searchUrl = this.generateSearchUrl();

    try {
      await blockGoogleAnalytics(page);
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

      // Process each frame directly with JavaScript evaluation
      for (const frame of adFrames) {
        try {
          // Extract all relevant ad information directly using JavaScript
          const frameAds = await frame
            .evaluate(() => {
              // Find all ad containers using standard JavaScript
              const adElements = [];

              // Find all spans
              const spans = document.querySelectorAll("span");
              for (const span of spans) {
                // Check if the span contains "Sponsored" text
                if (
                  span.textContent &&
                  span.textContent.includes("Sponsored")
                ) {
                  // Get the container (parent's parent or other suitable ancestor)
                  let container = span.parentElement;
                  if (container) container = container.parentElement;

                  if (container) {
                    adElements.push(container);
                  }
                }
              }

              return adElements.map((adElement) => {
                // Find all links within the ad element
                const links = Array.from(adElement.querySelectorAll("a")).map(
                  (a) => ({
                    href: a.href,
                    text: a.innerText || "",
                  })
                );

                // Get the main ad link (usually the one with most text or a specific pattern)
                let mainLink =
                  links.length > 0 ? links[links.length - 1] : null;

                // Get all text content for the ad
                const adText = adElement.textContent || "Ad text unavailable";

                return {
                  mainLink: mainLink ? mainLink.href : null,
                  allLinks: links,
                  text: adText,
                };
              });
            })
            .catch((e) => {
              console.log(`Failed to evaluate frame: ${e.message}`);
              return [];
            });

          console.log(`Found ${frameAds.length} ads in frame`);
          adContainers.push(...frameAds.filter((ad) => ad.mainLink));
        } catch (frameError) {
          console.log(`Error processing ad frame: ${frameError}`);
        }
      }

      console.log(
        `Found ${adContainers.length} total search ads before deduplication`
      );

      // Deduplicate by mainLink using a Set
      const uniqueAdContainers = Array.from(
        new Map(
          adContainers
            .filter((ad) => ad.mainLink) // Remove ads without links first
            .map((ad) => [ad.mainLink, ad]) // Use mainLink as key
        ).values()
      );

      console.log(
        `Found ${uniqueAdContainers.length} unique search ads after deduplication`
      );

      // Process ads using the deduplicated list
      const BATCH_SIZE = 5;
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < uniqueAdContainers.length; i += BATCH_SIZE) {
        console.log(
          `Processing batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(uniqueAdContainers.length / BATCH_SIZE)}`
        );

        const currentBatch = uniqueAdContainers.slice(i, i + BATCH_SIZE);
        const batchRequests: Promise<void>[] = [];

        for (const adData of currentBatch) {
          try {
            // We already have the data we need, no more locator operations required
            const adLink = adData.mainLink;
            const adText = adData.text;

            if (!adLink) {
              console.log("No main link found for ad, skipping");
              continue;
            }

            batchRequests.push(this.handleSearchAd(adLink, adText, searchUrl));
          } catch (error) {
            console.log(`Error processing ad: ${error}`);
            continue;
          }
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
      return false;
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

    // we already saw this, and it's a scam so then skip it
    const isKnownScam = await this.checkIfSearchAdIsKnownScam(adDestination);
    if (isKnownScam) {
      return;
    }

    const processResult = await hunterService.processAd(
      adDestination,
      "https://syndicatedsearch.goog/"
    );
    if (processResult == null) {
      return;
    }

    const { screenshot, html, redirectionPath } = processResult;
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
              hunterService.pgArray(redirectionPath),
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
              await sendAdScamAlert(
                adDestination,
                finalUrl,
                adText,
                false,
                confidenceScore,
                redirectionPath
              );

              const addedToRedirectChecker =
                await hunterService.tryAddToRedirectChecker(adDestination);
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
              hunterService.pgArray(redirectionPath),
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
            await sendAdScamAlert(
              adDestination,
              finalUrl,
              adText,
              true,
              confidenceScore,
              redirectionPath
            );

            const addedToRedirectChecker =
              await hunterService.tryAddToRedirectChecker(adDestination);
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

  private async checkIfSearchAdIsKnownScam(
    adDestination: string
  ): Promise<boolean> {
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
        return true;
      }
    } finally {
      client.release();
    }
    return false;
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
}
