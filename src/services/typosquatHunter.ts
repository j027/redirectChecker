import { Browser } from "patchright";
import { CONFIDENCE_THRESHOLD, hunterService } from "./hunterService.js";
import crypto from "crypto";
import { aiClassifierService } from "./aiClassifierService.js";
import pool from "../dbPool.js";
import { sendAlert, sendCloakerAddedAlert } from "./alertService.js";
import { BrowserManagerService } from "./browserManagerService.js";
import { hasWeightedSignal } from "./signalService.js";
import fs from "fs/promises";
import path from "path";

export class TyposquatHunter {
  private browser: Browser | null = null;
  private browserInitializing: boolean = false;
  private typosquatDomains: string[] = [];

  async init(): Promise<void> {
    await this.loadTyposquats();
    await this.ensureBrowserIsHealthy();
  }

  async restartBrowser(): Promise<void> {
    console.log("Restarting TyposquatHunter browser...");
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
          console.log("TyposquatHunter initialized new browser");
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

  private async loadTyposquats(): Promise<void> {
    const filePath = path.join(process.cwd(), "typosquats.json");
    const data = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(data);

    if (!Array.isArray(parsed)) {
      throw new Error("Invalid typosquats.json format: expected an array of domain strings");
    }

    const domains = parsed
      .filter((item): item is string => typeof item === "string")
      .map((domain) => domain.trim())
      .filter((domain) => domain.length > 0);

    if (domains.length === 0) {
      throw new Error("typosquats.json contained no valid domains");
    }

    // Remove duplicates
    this.typosquatDomains = Array.from(new Set(domains));

    console.log(`Loaded ${this.typosquatDomains.length} typosquat domains from ${filePath}`);
  }

  private getRandomTyposquatUrl(): string {
    if (!this.typosquatDomains || this.typosquatDomains.length === 0) {
      throw new Error("Typosquat domains not loaded; ensure typosquats.json exists and contains domains.");
    }

    const randomDomain = this.typosquatDomains[crypto.randomInt(this.typosquatDomains.length)];
    if (!randomDomain.startsWith("http")) {
      return `http://${randomDomain}`;
    }

    return randomDomain;
  }

  async huntTyposquat() {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null || !this.browser.isConnected()) {
      console.error(
        "Browser has not been initialized or crashed - typosquat hunter failed"
      );
      return null;
    }

    const typosquat = this.getRandomTyposquatUrl();
    console.log(`Checking typosquat domain: ${typosquat}`);

    const result = await hunterService.processAd(typosquat);

    if (result == null) {
      console.log(`Failed to process typosquat: ${typosquat}`);
      return null;
    }

    const { screenshot, html, redirectionPath, signals } = result;
    const finalUrl = redirectionPath[redirectionPath.length - 1] || typosquat;

    console.log(`Typosquat ${typosquat} redirected to ${finalUrl}`);

    // Skip processing if no meaningful redirects
    if (redirectionPath.length <= 1) {
      console.log(
        `Typosquat ${typosquat} has no meaningful redirects, skipping`
      );
      return null;
    }

    const classifierResult = await aiClassifierService.runInference(screenshot);

    // Check if URL is whitelisted - skip processing if so
    if (aiClassifierService.isWhitelisted(finalUrl)) {
      console.log(`✅ Whitelisted domain detected: ${finalUrl} - Skipping typosquat processing`);
      return null;
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
          "typosquat",
          client
        );
        const isNewDestination = existingDestId === null;

        if (isNewDestination) {
          // New destination we haven't seen before
          const adId = crypto.randomUUID();

          await client.query(
            `INSERT INTO ads
             (id, ad_type, initial_url, final_url, redirect_path, classifier_is_scam, confidence_score, is_scam,
              signal_fullscreen, signal_keyboard_lock, signal_pointer_lock, signal_third_party_hosting, signal_ip_address, signal_page_frozen, signal_worker_bomb)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
              adId,
              "typosquat",
              typosquat,
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
              signals.workerBombDetected,
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

          console.log(
            `Updated last_seen for existing destination: ${finalUrl}`
          );
        }

        // Only send an alert if:
        // 1. It's classified as a scam
        // 2. We haven't seen this destination before from any typosquat
        if (
          isScam &&
          isNewDestination
        ) {
          const cloakerCandidate = hunterService.findCloakerCandidate(
            redirectionPath,
            finalUrl
          );

          await sendAlert({
            type: "typosquat",
            initialUrl: typosquat,
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
              await sendCloakerAddedAlert(cloakerCandidate, "Typosquat");
              console.log(
                `Added cloaker to redirect checker: ${cloakerCandidate}`
              );
            }
          }
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
}
