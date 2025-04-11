import { Browser, Page, Frame, Response } from "patchright";
import {
  blockGoogleAnalytics,
  parseProxy,
  spoofWindowsChrome,
  simulateRandomMouseMovements,
} from "../utils/playwrightUtilities.js";
import { aiClassifierService } from "./aiClassifierService.js";
import crypto from "crypto";
import pool from "../dbPool.js";
import { discordClient } from "../discordBot.js";
import { TextChannel } from "discord.js";
import { readConfig } from "../config.js";
import { handleRedirect } from "../services/redirectHandlerService.js";
import { RedirectType } from "../redirectType.js";
import { BrowserManagerService } from "./browserManagerService.js";

// given a detected scam, confidence level above this will be treated as one
// this is because the image model has false positive issues otherwise
// eventually will use both image and html model with hopefully fewer false positives
const CONFIDENCE_THRESHOLD = 0.98;

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

  async huntSearchAds() {
    await this.ensureBrowserIsHealthy();

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
          const frameAds = await frame.evaluate(() => {
            // Find all ad containers using standard JavaScript
            const adElements = [];
            
            // Find all spans
            const spans = document.querySelectorAll('span');
            for (const span of spans) {
              // Check if the span contains "Sponsored" text
              if (span.textContent && span.textContent.includes('Sponsored')) {
                // Get the container (parent's parent or other suitable ancestor)
                let container = span.parentElement;
                if (container) container = container.parentElement;
                
                if (container) {
                  adElements.push(container);
                }
              }
            }
            
            return adElements.map(adElement => {
              // Find all links within the ad element
              const links = Array.from(adElement.querySelectorAll('a')).map(a => ({
                href: a.href,
                text: a.innerText || ''
              }));
              
              // Get the main ad link (usually the one with most text or a specific pattern)
              let mainLink = links.length > 0 ? links[links.length - 1] : null;
              
              // Get all text content for the ad
              const adText = adElement.textContent || "Ad text unavailable";
              
              return {
                mainLink: mainLink ? mainLink.href : null,
                allLinks: links,
                text: adText
              };
            });
          }).catch(e => {
            console.log(`Failed to evaluate frame: ${e.message}`);
            return [];
          });
          
          console.log(`Found ${frameAds.length} ads in frame`);
          adContainers.push(...frameAds.filter(ad => ad.mainLink));
        } catch (frameError) {
          console.log(`Error processing ad frame: ${frameError}`);
        }
      }

      console.log(`Found ${adContainers.length} total search ads before deduplication`);

      // Deduplicate by mainLink using a Set
      const uniqueAdContainers = Array.from(
        new Map(
          adContainers
            .filter(ad => ad.mainLink) // Remove ads without links first
            .map(ad => [ad.mainLink, ad]) // Use mainLink as key
        ).values()
      );

      console.log(`Found ${uniqueAdContainers.length} unique search ads after deduplication`);

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

    // we already saw this, and it's a scam so then skip it
    const isKnownScam = await this.checkIfSearchAdIsKnownScam(adDestination);
    if (isKnownScam) {
      return;
    }

    const processResult = await this.processAd(
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

  private async processAd(
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
      const redirectTracker = this.trackRedirectionPath(page, adDestination);
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
    
    // Track main frame navigations
    const navigationListener = (frame: Frame) => {
      if (frame === page.mainFrame()) {
        redirectionPath.add(frame.url());
      }
    };

    // Track HTTP redirects specifically (catches 301, 302, 303, 307, 308)
    const responseListener = (response: Response) => {
      const status = response.status();
      if (status >= 300 && status < 400) {
        const location = response.headers()["location"];
        if (location) {
          try {
            // Handle both absolute and relative URLs
            const baseUrl = response.url();
            const redirectUrl = new URL(location, baseUrl).toString();
            console.log(`HTTP ${status} redirect: ${baseUrl} → ${redirectUrl}`);
            redirectionPath.add(redirectUrl);
          } catch (e) {
            console.log(`Failed to parse redirect URL: ${location}`);
          }
        }
      }
    };

    // Ensure initial URL is tracked
    redirectionPath.add(startUrl);
    
    // Add event listeners
    page.on("framenavigated", navigationListener);
    page.on("response", responseListener);

    return {
      getPath: () => {
        return Array.from(redirectionPath);
      }
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

  private getRandomTyposquatUrl(): string {
    const typosquatDomains = [
      // Facebook typosquats
      "facebaak.com",
      "facebiik.com",
      "fac3book.com",
      "faceb00k.com",
      "afcebook.com",
      "faicebook.com",
      "fucebook.com",
      "facbeook.com",
      "faceboko.com",
      "faceblok.com",
      "fzcebook.com",
      "facebppk.com",
      "ftacebook.com",

      // Gmail typosquats
      "gmaip.com",
      "gmai.com",
      "gmaol.com",
      "ggmail.com",
      "gmaii.com",
      "gmsail.com",
      "ygmail.com",
      "gmalil.com",
      "gmaiol.com",
      "gmaili.com",
      "gjmail.com",
      "gmailk.com",
      "gmaijl.com",
      "gmkail.com",
      "gmaqil.com",
      "gmqail.com",
      "gmajil.com",

      // Google typosquats
      "googlo.com",
      "goorle.com",
      "googls.com",
      "ygoogle.com",
      "gopogle.com",
      "googpe.com",
      "gdoogle.com",
      "voovle.com",
      "goodgle.com",
      "googloe.com",
      "googlpe.com",
      "googlre.com",
      "goovgle.com",
      "geogle.com",
      "goigle.com",
      "googae.com",
      "googee.com",
      "googfe.com",
      "goohe.com",
      "googln.com",
      "googme.com",
      "googre.com",
      "googte.com",
      "googwe.com",
      "gookle.com",
      "goolle.com",
      "goonle.com",
      "gooqle.com",
      "gooxle.com",
      "gooyle.com",
      "gopgle.com",
      "guogle.com",

      // YouTube typosquats
      "yotube.com",
      "youutbe.com",
      "outube.com",
      "yautube.com",
      "youtubo.com",
      "yohtube.com",
      "youthbe.com",
      "yojutube.com",
      "youtubd.com",
      "youtubs.com",
      "youtubu.com",

      // Twitter typosquats
      "twittre.com",
      "twltter.com",
      "twutter.com",
      "fwitter.com",
      "tsitter.com",
      "twiyter.com",
      "twittee.com",
      "tywitter.com",
      "twuitter.com",
      "twiutter.com",
      "twitfer.com",
      "twittet.com",
      "twiktter.com",
    ];

    const randomDomain =
      typosquatDomains[crypto.randomInt(typosquatDomains.length)];
    if (!randomDomain.startsWith("http")) {
      return `http://${randomDomain}`;
    }

    return randomDomain;
  }

  async huntTyposquat() {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - typosquat hunter failed"
      );
      return null;
    }

    const typosquat = this.getRandomTyposquatUrl();
    console.log(`Checking typosquat domain: ${typosquat}`);
    
    const result = await this.processAd(typosquat);

    if (result == null) {
      console.log(`Failed to process typosquat: ${typosquat}`);
      return null;
    }

    const { screenshot, html, redirectionPath } = result;
    const finalUrl = redirectionPath[redirectionPath.length - 1] || typosquat;
    
    console.log(`Typosquat ${typosquat} redirected to ${finalUrl}`);
    
    // Skip processing if no meaningful redirects
    if (redirectionPath.length <= 1) {
      console.log(`Typosquat ${typosquat} has no meaningful redirects, skipping`);
      return null;
    }

    const classifierResult = await aiClassifierService.runInference(screenshot);
    const { isScam, confidenceScore } = classifierResult;

    try {
      // Save the classified data to AI service
      await aiClassifierService.saveData(
        finalUrl,
        screenshot,
        html,
        isScam,
        confidenceScore
      );

      const client = await pool.connect();
      
      try {
        await client.query("BEGIN");

        // Replace the existing destination query with fuzzy matching
        const existingDestId = await this.findExistingDestination(finalUrl, 'typosquat', client);
        const isNewDestination = existingDestId === null;
        
        if (isNewDestination) {
          // New destination we haven't seen before
          const adId = crypto.randomUUID();
          
          await client.query(
            `INSERT INTO ads
             (id, ad_type, initial_url, final_url, redirect_path, is_scam, confidence_score)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              adId,
              "typosquat",
              typosquat,
              finalUrl,
              this.pgArray(redirectionPath),
              isScam,
              confidenceScore,
            ]
          );
          
          console.log(`New typosquat record: ${typosquat} -> ${finalUrl}`);
        } else {
          // We've seen this destination before, just update last_seen timestamp
          await client.query(
            `UPDATE ads SET last_seen = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [existingDestId]
          );
          
          console.log(`Updated last_seen for existing destination: ${finalUrl}`);
        }
        
        // Only send an alert if:
        // 1. It's classified as a scam with high confidence
        // 2. We haven't seen this destination before from any typosquat
        if (isScam && confidenceScore > CONFIDENCE_THRESHOLD && isNewDestination) {
          await this.sendTyposquatAlert(
            typosquat,
            finalUrl,
            confidenceScore,
            redirectionPath
          );
          console.log(`Sent alert for new scam destination: ${finalUrl}`);
        }

        await client.query("COMMIT");
        return true;
      } catch (error) {
        await client.query("ROLLBACK");
        console.error(`Database error: ${error}`);
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error(`Error in typosquat hunter: ${error}`);
      return null;
    }
  }

  private async sendTyposquatAlert(
    typosquatDomain: string,
    finalUrl: string,
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

        // Build message components
        const header = `🚨 NEW TYPOSQUAT SCAM DESTINATION 🚨 (Confidence: ${confidencePercent}%)`;
        
        let pathSection = `**Typosquat Domain:** ${typosquatDomain}\n**Final URL:** ${finalUrl}\n\n`;
        
        if (redirectionPath && redirectionPath.length > 0) {
          pathSection += "**Redirect Path:**\n";
          redirectionPath.forEach((url, index) => {
            pathSection += `${index + 1}. ${url}\n`;
          });
        }

        // Combine all sections
        const messageText = `${header}\n\n${pathSection}`;

        await channel.send(messageText);
        console.log("Discord typosquat alert sent");
      } else {
        console.error("Discord channel not found");
      }
    } catch (error) {
      console.error(`Error sending Discord notification: ${error}`);
    }
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
  private async findExistingDestination(url: string, adType: string, client: any): Promise<string | null> {
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
