import { Browser, Page } from "patchright";
import crypto, { randomBytes, randomInt } from "crypto";
import { blockGoogleAnalytics, parseProxy, spoofWindowsChrome, trackRedirectionPath, simulateRandomMouseMovements } from "../utils/playwrightUtilities.js";
import { hunterService, CONFIDENCE_THRESHOLD } from "./hunterService.js";
import { aiClassifierService } from "./aiClassifierService.js";
import pool from "../dbPool.js";
import { sendAlert, sendCloakerAddedAlert } from "./alertService.js";
import { BrowserManagerService } from "./browserManagerService.js";
import { createSignalService, DetectedSignals, createEmptySignals, hasWeightedSignal } from "./signalService.js";

export class AdSpyGlassHunter {
  private browser: Browser | null = null;
  private browserInitializing: boolean = false;

  async init(): Promise<void> {
    await this.ensureBrowserIsHealthy();
  }

  async restartBrowser(): Promise<void> {
    console.log("Restarting AdSpyGlassHunter browser...");
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
          console.log("AdSpyGlassHunter initialized new browser");
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

  async huntAdSpyGlassAds() {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null || !this.browser.isConnected()) {
      console.error(
        "Browser has not been initialized or crashed - AdSpyGlass hunter failed"
      );
      return false;
    }

    let site = this.getRandomWebsite();

    const context = await this.browser.newContext({
        proxy: await parseProxy(true),
        viewport: null
    })

    let page = await context.newPage();
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const popupPromises: Promise<void>[] = [];

    try {
        await spoofWindowsChrome(context, page);
        await blockGoogleAnalytics(page);

        await page.goto(site, {
            waitUntil: "load",
            timeout: 60000
        });

        // Navigate to video page without clicking to avoid popunder
        try {
            const video = page.locator('a[href*="video/"]').first();
            await video.waitFor({state: "visible", timeout: 30000});
            
            // Get the href attribute from the first video link
            const videoUrl = await video.getAttribute('href');
            
            if (videoUrl) {
                // Handle relative URLs
                const fullVideoUrl = videoUrl.startsWith('http') 
                    ? videoUrl 
                    : new URL(videoUrl, site).toString();
                
                console.log(`Navigating to video page: ${fullVideoUrl}`);
                
                // Navigate instead of clicking to avoid popunder
                await page.goto(fullVideoUrl, {
                    waitUntil: "load",
                    timeout: 30000
                });

                // setup the popup listener before we do any clicking
                context.on("page", async (p: Page) => {
                    if (p.url() !== fullVideoUrl) {
                        popupPromises.push(this.handleAdClick(p, userAgent));
                        return;
                    }

                    popupPromises.push(this.handleAdClick(page, userAgent));
                    page = p;

                    // spoof the new video page
                    await spoofWindowsChrome(context, page);
                    await blockGoogleAnalytics(page);
                });
                
                // Click multiple times with delays to trigger ads
                for (let i = 0; i < 5; i++) {
                    try {
                        // Now look for iframe in video-embedded div and click multiple times
                        const videoEmbeddedDiv = page.locator('div.video-embedded');
                        const iframe = videoEmbeddedDiv.locator('iframe');
                        await iframe.waitFor({ state: "attached", timeout: 10000 });
                        const frameLocator = page.frameLocator('div.video-embedded iframe');

                        await frameLocator.locator('body').click({ 
                            timeout: 10000,
                            force: true 
                        });

                        await page.waitForTimeout(randomInt(5, 10) * 1000);                        
                    } catch (clickError) {
                        console.log(`Iframe click ${i + 1} failed:`, clickError);
                    }
                }
            }
        } catch (error) {
            console.log("Error navigating to video page:", error);
        }
    }
    catch (error) {
        console.error("Error navigating to site with AdSpyGlass ads:", error);
        return false;
    }

    try {
        await Promise.all(popupPromises);
    }
    catch (error) {
        console.error("Error handling adspyglass popup ads:", error);
        return false;
    } finally {
        await page.close();
        await context.close();
    }

    // if we got here, we probably found some ads and didn't break anything
    return true;
  }

  private async handleAdClick(page: Page, userAgent: string): Promise<void> {
    await spoofWindowsChrome(page.context(), page, userAgent);
    await blockGoogleAnalytics(page);

    // Create signal service for this popup
    const signalService = createSignalService();
    
    let screenshot: Buffer | null = null;
    let html: string | null = null;
    let redirectionPath: string[] | null = null;
    let signals: DetectedSignals = createEmptySignals();

    try {
      // Attach signal listeners
      await signalService.attachApiListeners(page);
      
      // Set up redirect tracking for this popup page
      const redirectTracker = await trackRedirectionPath(page, page.url());
      
      // Wait for page to load and simulate some interaction
      await page.waitForLoadState("load");
      await simulateRandomMouseMovements(page);
      await page.waitForTimeout(5000);
      
      // Take screenshot and get content
      screenshot = await page.screenshot();
      html = await page.content();
      redirectionPath = redirectTracker.getPath();
      
      // Collect signals
      const finalUrl = redirectionPath[redirectionPath.length - 1] || page.url();
      await signalService.detectAllSignals(page, finalUrl);
      signals = signalService.getSignals();
      
      if (signalService.hasWeightedSignal()) {
        console.log(`🚨 Weighted signals detected for AdSpyGlass popup:`, signals);
      }
      
      console.log(`AdSpyGlass popup captured: ${page.url()}`);
      console.log(`Redirect path: ${redirectionPath}`);

      // Process this ad popup
      await this.handleAdSpyGlassAd(page.url(), screenshot, html, redirectionPath, signals);
      
    } catch (error) {
      console.log(`Error handling AdSpyGlass ad popup: ${error}`);
    } finally {
      // Close the popup page
      try {
        await page.close();
      } catch (closeError) {
        console.log(`Error closing popup page: ${closeError}`);
      }
    }
  }

  private async handleAdSpyGlassAd(
    adUrl: string,
    screenshot: Buffer,
    html: string,
    redirectionPath: string[],
    signals: DetectedSignals
  ) {
    const finalUrl = redirectionPath[redirectionPath.length - 1] || adUrl;

    console.log(`AdSpyGlass ad ${adUrl} redirected to ${finalUrl}`);

    // Skip processing if no meaningful redirects
    if (redirectionPath.length <= 1) {
      console.log(
        `AdSpyGlass ad ${adUrl} has no meaningful redirects, skipping`
      );
      return;
    }

    const classifierResult = await aiClassifierService.runInference(screenshot);

    // Check if URL is whitelisted - skip processing if so
    if (aiClassifierService.isWhitelisted(finalUrl)) {
      console.log(`✅ Whitelisted domain detected: ${finalUrl} - Skipping AdSpyGlass ad processing`);
      return;
    }

    const { isScam: rawIsScam, confidenceScore } = classifierResult;
    // Only treat as scam if confidence is above threshold AND has a weighted signal
    const hasSignal = hasWeightedSignal(signals);
    const isScam = rawIsScam && confidenceScore >= CONFIDENCE_THRESHOLD && hasSignal;

    try {
      // Save the classified data to AI service (use raw values for training)
      await aiClassifierService.saveData(
        finalUrl,
        screenshot,
        html,
        rawIsScam,
        confidenceScore
      );

      const client = await pool.connect();

      try {
        await client.query("BEGIN");

        // Replace the existing destination query with fuzzy matching
        const existingDestId = await hunterService.findExistingDestination(
          finalUrl,
          "adspyglass",
          client
        );
        const isNewDestination = existingDestId === null;

        if (isNewDestination) {
          // New destination we haven't seen before
          const adId = crypto.randomUUID();

          await client.query(
            `INSERT INTO ads
             (id, ad_type, initial_url, final_url, redirect_path, classifier_is_scam, confidence_score, is_scam,
              signal_fullscreen, signal_keyboard_lock, signal_pointer_lock, signal_third_party_hosting, signal_ip_address, signal_page_frozen)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              adId,
              "adspyglass",
              adUrl,
              finalUrl,
              hunterService.pgArray(redirectionPath),
              rawIsScam,
              confidenceScore,
              isScam,
              signals.fullscreenRequested,
              signals.keyboardLockRequested,
              signals.pointerLockRequested,
              signals.isThirdPartyHosting,
              signals.isIpAddress,
              signals.pageLoadFrozen,
            ]
          );

          console.log(`New AdSpyGlass record: ${adUrl} -> ${finalUrl}`);
        } else {
          // We've seen this destination before, just update last_seen timestamp
          await client.query(
            `UPDATE ads SET last_seen = CURRENT_TIMESTAMP 
             WHERE id = $1`,
            [existingDestId]
          );

          console.log(
            `Updated last_seen for existing destination: ${finalUrl}`
          );
        }

        // Only send an alert if:
        // 1. It's classified as a scam
        // 2. We haven't seen this destination before from any AdSpyGlass ad
        if (
          isScam &&
          isNewDestination
        ) {
          const cloakerCandidate = hunterService.findCloakerCandidate(
            redirectionPath,
            finalUrl
          );

          await sendAlert({
            type: "adspyglass",
            initialUrl: adUrl,
            finalUrl,
            confidenceScore,
            redirectionPath,
            cloakerCandidate,
          });
          console.log(`Sent alert for new scam destination: ${finalUrl}`);

          if (cloakerCandidate != null) {
            const addedToChecker =
              await hunterService.tryAddToRedirectChecker(cloakerCandidate);
            if (addedToChecker) {
              await sendCloakerAddedAlert(cloakerCandidate, "AdSpyGlass");
              console.log(
                `Added cloaker to redirect checker: ${cloakerCandidate}`
              );
            }
          }
        }

        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        console.error(`Database error: ${error}`);
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error(`Error in AdSpyGlass hunter: ${error}`);
    }
  }

  private getRandomWebsite(): string {
    const adSpyGlassWebsites = [
      "https://reallifecam.to/",
      "https://camcaps.to/",
    ];

    const randomWebsite = adSpyGlassWebsites[crypto.randomInt(adSpyGlassWebsites.length)];
    return randomWebsite;
  }
}