import pool from "../dbPool.js";
import { handleRedirect } from "./redirectHandlerService.js";
import { RedirectType } from "../redirectType.js";
import { reportSite } from "./reportService.js";
import { initTakedownStatusForDestination } from "./takedownMonitorService.js";
import { aiClassifierService } from "./aiClassifierService.js";
import { CONFIDENCE_THRESHOLD } from "./hunterService.js";
import { hasWeightedSignal } from "./signalService.js";
import { logRedirectEvent } from "./redirectEventLogger.js";
import { logScamReport } from "./scamReportLogger.js";

export async function checkRedirects() {
  const client = await pool.connect();
  let redirects;
  try {
    redirects = await client.query("SELECT id, source_url, type FROM redirects");
  } catch (e) {
    console.log(e);
    await logRedirectEvent("error", `Failed to query redirects: ${e}`);
    return;
  } finally {
    client.release();
  }

  await logRedirectEvent("check_start", `Starting redirect check cycle for ${redirects.rows.length} redirects`, undefined, {
    redirect_count: redirects.rows.length
  });

  const redirectHandlers: Promise<void>[] = [];

  redirects.rows.forEach((row) => {
    const sourceUrl: string = row.source_url;
    const type = row.type as RedirectType;
    const redirectId = row.id as number;
    redirectHandlers.push(processRedirectEntry(sourceUrl, type, redirectId));
  });

  await Promise.allSettled(redirectHandlers);
  await logRedirectEvent("check_end", `Redirect check cycle complete`, undefined, {
    redirect_count: redirects.rows.length
  });
}

async function processRedirectEntry(
  sourceUrl: string,
  redirectType: RedirectType,
  redirectId: number
): Promise<void> {

  const { location: redirectDestination } = await handleRedirect(sourceUrl, redirectType);

  // if we didn't redirect anywhere
  if (redirectDestination == null) {
    await logRedirectEvent("no_redirect", `No redirect destination found`, sourceUrl, {
      type: redirectType
    });
    return;
  }

  await logRedirectEvent("redirect_followed", `Redirected to ${redirectDestination}`, sourceUrl, {
    destination: redirectDestination, type: redirectType
  });

  const client = await pool.connect();
  try {
    // Start a transaction
    await client.query('BEGIN');

    let canonicalDestination: string;
    // Extract hostname during insertion
    try {
      const urlObj = new URL(redirectDestination);
      // Store just the hostname
      canonicalDestination = urlObj.hostname;
    } catch (e) {
      console.log("Failed to parse URL, falling back to full URL:", e);
      canonicalDestination = redirectDestination;
    }

    // Query using the hostname column
    const result = await client.query(
      "SELECT id FROM redirect_destinations WHERE hostname = $1 FOR UPDATE",
      [canonicalDestination]
    );

    if (result.rows.length > 0) {
      // If found, update the last seen timestamp
      await client.query(
        "UPDATE redirect_destinations SET last_seen = NOW() WHERE id = $1",
        [result.rows[0].id]
      );
      await logRedirectEvent("existing_destination", `Known destination, updated last_seen`, sourceUrl, {
        hostname: canonicalDestination
      });
      // Commit the transaction - we're done
      await client.query('COMMIT');
    } else {
      // If not found, classify the redirect and handle appropriately
      const classificationResult = await aiClassifierService.classifyUrl(redirectDestination);
      if (classificationResult == null) {
        console.log("Could not get a classification result - giving up");
        await logRedirectEvent("error", `Classification failed`, sourceUrl, {
          destination: redirectDestination
        });
        await client.query('ROLLBACK'); // Roll back transaction
        return;
      }

      // Apply confidence threshold + signal check for effective scam decision
      const classifierIsScam = classificationResult.isScam;
      const confidenceScore = classificationResult.confidenceScore;
      const signals = classificationResult.signals;
      
      // Scam = classifier says scam AND confidence >= threshold AND at least one weighted signal
      const isScam = classifierIsScam && confidenceScore >= CONFIDENCE_THRESHOLD && hasWeightedSignal(signals);

      await logRedirectEvent("classification", `Classified ${redirectDestination}: ${isScam ? "SCAM" : "clean"}`, sourceUrl, {
        destination: redirectDestination,
        classifier_is_scam: classifierIsScam,
        confidence: confidenceScore,
        effective_is_scam: isScam
      });

      // Now we insert, still within the same transaction
      const insertResult = await client.query(
        `INSERT INTO redirect_destinations 
         (redirect_id, destination_url, hostname, is_scam, classifier_is_scam, confidence_score,
          signal_fullscreen, signal_keyboard_lock, signal_pointer_lock, 
          signal_third_party_hosting, signal_ip_address, signal_page_frozen, signal_worker_bomb) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [
          redirectId, 
          redirectDestination, 
          canonicalDestination, 
          isScam,
          classifierIsScam,
          confidenceScore,
          signals.fullscreenRequested,
          signals.keyboardLockRequested,
          signals.pointerLockRequested,
          signals.isThirdPartyHosting,
          signals.isIpAddress,
          signals.pageLoadFrozen,
          signals.workerBombDetected
        ]
      );

      // Initialize security status for this new destination
      const destinationId = insertResult.rows[0].id;
      await initTakedownStatusForDestination(destinationId, isScam, client);

      await logRedirectEvent("new_destination", `New destination: ${redirectDestination} (${isScam ? "SCAM" : "clean"})`, sourceUrl, {
        destination: redirectDestination, hostname: canonicalDestination, is_scam: isScam, confidence: confidenceScore
      });

      // If it's a scam site, report it with the screenshot and HTML
      if (isScam) {
        await logScamReport(redirectDestination, "redirect");
        await logRedirectEvent("scam_found", `Scam detected: ${redirectDestination}`, sourceUrl, {
          destination: redirectDestination, confidence: confidenceScore
        });
        await reportSite(
          redirectDestination,
          sourceUrl,
          classificationResult.screenshot,
          classificationResult.html,
          { signals, confidenceScore }
        );
      }
      
      // Commit the transaction
      await client.query('COMMIT');
    }
  } catch (error) {
    // If an error occurs, roll back the transaction
    await client.query('ROLLBACK');
    console.log("Error updating redirect_history:", error);
    await logRedirectEvent("error", `Error processing redirect: ${error}`, sourceUrl, {
      destination: redirectDestination
    });
  } finally {
    client.release();
  }
}
