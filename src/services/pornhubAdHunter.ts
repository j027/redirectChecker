import { Browser } from "patchright";
import { hunterService, CONFIDENCE_THRESHOLD } from "./hunterService.js";
import { aiClassifierService } from "./aiClassifierService.js";
import { parseProxy, spoofWindowsChrome } from "../utils/playwrightUtilities.js";
import pool from "../dbPool.js";
import crypto from "crypto";
import { sendAlert, sendCloakerAddedAlert } from "./alertService.js";
import { BrowserManagerService } from "./browserManagerService.js";

export class PornhubAdHunter {
  private browser: Browser | null = null;
  private browserInitializing: boolean = false;

  async init(): Promise<void> {
    await this.ensureBrowserIsHealthy();
  }

  async restartBrowser(): Promise<void> {
    console.log("Restarting PornhubAdHunter browser...");
    try {
      this.browserInitializing = true;
      this.browser = await BrowserManagerService.forceRestartBrowser(this.browser, false);
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
          await BrowserManagerService.closeBrowser(this.browser);
          this.browser = await BrowserManagerService.createBrowser(false);
          console.log("PornhubAdHunter initialized new browser");
        } finally {
          this.browserInitializing = false;
        }
      }
    );
  }

  async close(): Promise<void> {
    await BrowserManagerService.closeBrowser(this.browser);
    this.browser = null;
  }

  async huntPornhubAds(): Promise<boolean> {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null || !this.browser.isConnected()) {
      console.error(
        "Browser has not been initialized or crashed - pornhub ad hunter failed"
      );
      return false;
    }

    // Get the pornhub ad URL
    let adUrl: string | null = null;

    // try to grab a url up to 10 times, giving up if no url found
    for (let i = 0; i < 10; i++) {
      adUrl = await this.getPornhubAdUrl();
      if (adUrl != null) {
        break;
      }
    }

    if (adUrl == null) {
      console.log("Failed to get pornhub ad url, giving up");
      return false;
    }

    const adDestination = this.canonicalizePornhubAdUrl(adUrl);
    if (adDestination == null) {
      console.log("Failed to canonicalize pornhub ad");
      return false;
    }

    console.log("Got a pornhub ad URL:", adDestination);

    // Process the ad (similar to handleSearchAd)
    await this.handlePornhubAd(adDestination);

    return true;
  }

  private async handlePornhubAd(adDestination: string) {
    // Check if this is already a known scam
    const isKnownScam = await this.checkIfPornhubAdIsKnownScam(adDestination);
    if (isKnownScam) {
      return;
    }

    // Process the ad using the hunter service
    const processResult = await hunterService.processAd(
      adDestination,
      "https://www.pornhub.com/"
    );
    if (processResult == null) {
      console.log("Failed to process pornhub ad");
      return;
    }

    const { screenshot, html, redirectionPath } = processResult;
    const classifierResult = await aiClassifierService.runInference(screenshot);

    try {
      const { isScam, confidenceScore } = classifierResult;
      const finalUrl =
        redirectionPath[redirectionPath.length - 1] || adDestination;

      // Save classifier data
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
        const existingAdId = await hunterService.findExistingSource(
          adDestination,
          "pornhub",
          client
        );

        if (existingAdId != null) {
          const existingAdQuery = await client.query(
            `SELECT id, is_scam FROM ads 
            WHERE id = $1 AND ad_type = 'pornhub'`,
            [existingAdId]
          );
          const existingAd = existingAdQuery.rows[0];

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
              `Pornhub ad status changed from ${existingAd.is_scam} to ${isScam}`
            );

            // Send alert if status changed to scam with high confidence
            if (isScam && confidenceScore > CONFIDENCE_THRESHOLD) {
              await sendAlert({
                type: "pornhubAd",
                initialUrl: adDestination,
                finalUrl,
                isNew: false,
                confidenceScore,
                redirectionPath,
                cloakerCandidate: adDestination,
              });

              const addedToRedirectChecker = 
                await hunterService.tryAddToRedirectChecker(adDestination);
              if (addedToRedirectChecker) {
                await sendCloakerAddedAlert(adDestination, "Pornhub Ad");
              }
              console.log(
                `Auto-add to redirect checker for changed status: ${addedToRedirectChecker ? "Success" : "Failed"}`
              );
            }
          }

          console.log(`Updated existing pornhub ad: ${existingAd.id}`);
        } else {
          // Insert new ad
          const adId = crypto.randomUUID();

          await client.query(
            `INSERT INTO ads
             (id, ad_type, initial_url, final_url, redirect_path, is_scam, confidence_score)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              adId,
              "pornhub",
              adDestination,
              finalUrl,
              hunterService.pgArray(redirectionPath),
              isScam,
              confidenceScore,
            ]
          );

          console.log(`Inserted new pornhub ad: ${adId}, is_scam: ${isScam}`);

          // Send alert if new scam with high confidence
          if (isScam && confidenceScore > CONFIDENCE_THRESHOLD) {
            await sendAlert({
              type: "pornhubAd",
              initialUrl: adDestination,
              finalUrl,
              isNew: true,
              confidenceScore,
              redirectionPath,
              cloakerCandidate: adDestination,
            });

            const addedToRedirectChecker = 
              await hunterService.tryAddToRedirectChecker(adDestination);
            if (addedToRedirectChecker) {
              await sendCloakerAddedAlert(adDestination, "Pornhub Ad");
            }
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
        console.log(`Error while trying to update ad in the database ${error}`)
      } finally {
        // Always release the client back to the pool
        client.release();
      }
    } catch (dbError) {
      console.error(`Database error while processing pornhub ad: ${dbError}`);
    }
  }

  private async checkIfPornhubAdIsKnownScam(
    adDestination: string
  ): Promise<boolean> {
    const client = await pool.connect();
    try {
      const id = await hunterService.findExistingSource(adDestination, "pornhub", client);

      if (id == null){
        return false;
      }

      // Check if this URL is already known to be a scam
      const existingAdQuery = await client.query(
        `SELECT id, is_scam FROM ads 
       WHERE id = $1 AND ad_type = 'pornhub'`,
        [id]
      );

      const existingAd = existingAdQuery.rows[0];

      // If ad exists and is already marked as a scam, just update last_seen and return
      if (existingAd && existingAd.is_scam) {
        await client.query(
          `UPDATE ads SET last_seen = CURRENT_TIMESTAMP 
         WHERE id = $1`,
          [existingAd.id]
        );

        console.log(`Skipping already known scam pornhub ad: ${adDestination}`);
        return true;
      }
    } 
    catch(error) {
      console.log(`An error occured while checking for a known scam: ${error}`)
    }
    finally {
      client.release();
    }
    return false;
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

      // remove unique url parameter that the actual redirect would strip anyways
      const adUrl = new URL(adDestination);
      adUrl.searchParams.delete("vf");

      return adUrl.toString();
    } catch (error) {
      console.log("Error while trying to canonicalize pornhub ad url", error);
      return null;
    }
  }
}
