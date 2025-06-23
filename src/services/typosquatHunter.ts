import { Browser } from "patchright";
import { CONFIDENCE_THRESHOLD, hunterService } from "./hunterService.js";
import crypto from "crypto";
import { aiClassifierService } from "./aiClassifierService.js";
import pool from "../dbPool.js";
import { sendTyposquatAlert } from "./alertService.js";

export class TyposquatHunter {
  private browser: Browser | null = null;

  constructor(browser: Browser) {
    this.browser = browser;
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
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - typosquat hunter failed"
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
             (id, ad_type, initial_url, final_url, redirect_path, is_scam, confidence_score)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              adId,
              "typosquat",
              typosquat,
              finalUrl,
              hunterService.pgArray(redirectionPath),
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

          console.log(
            `Updated last_seen for existing destination: ${finalUrl}`
          );
        }

        // Only send an alert if:
        // 1. It's classified as a scam with high confidence
        // 2. We haven't seen this destination before from any typosquat
        if (
          isScam &&
          confidenceScore > CONFIDENCE_THRESHOLD &&
          isNewDestination
        ) {
          await sendTyposquatAlert(
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
}
