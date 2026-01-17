import { Browser } from "patchright";
import { CONFIDENCE_THRESHOLD, hunterService } from "./hunterService.js";
import crypto from "crypto";
import { aiClassifierService } from "./aiClassifierService.js";
import pool from "../dbPool.js";
import { sendAlert, sendCloakerAddedAlert } from "./alertService.js";
import { BrowserManagerService } from "./browserManagerService.js";

export class TyposquatHunter {
  private browser: Browser | null = null;
  private browserInitializing: boolean = false;

  async init(): Promise<void> {
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

    const { screenshot, html, redirectionPath } = result;
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
    const { isScam: rawIsScam, confidenceScore } = classifierResult;
    // Only treat as scam if confidence is above threshold
    const isScam = rawIsScam && confidenceScore >= CONFIDENCE_THRESHOLD;

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
             (id, ad_type, initial_url, final_url, redirect_path, classifier_is_scam, confidence_score, is_scam)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
              adId,
              "typosquat",
              typosquat,
              finalUrl,
              hunterService.pgArray(redirectionPath),
              rawIsScam,
              confidenceScore,
              isScam,
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
