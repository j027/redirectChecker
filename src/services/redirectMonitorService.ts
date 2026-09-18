import pool from "../dbPool.js";
import { handleRedirect } from "./redirectHandlerService.js";
import { RedirectType } from "../redirectType.js";
import { reportSite } from "./reportService.js";
import { initTakedownStatusForDestination } from "./takedownMonitorService.js";
import { aiClassifierService, ClassificationResult } from "./aiClassifierService.js";
import { CONFIDENCE_THRESHOLD } from "./hunterService.js";
import { hasWeightedSignal, DetectedSignals } from "./signalService.js";
import { logRedirectEvent } from "./redirectEventLogger.js";
import { logScamReport } from "./scamReportLogger.js";

export async function checkRedirects() {
  const client = await pool.connect();
  let redirects;
  try {
    redirects = await client.query("SELECT id, source_url, type FROM redirects WHERE deleted_at IS NULL");
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

  const redirectDestination = await handleRedirect(sourceUrl, redirectType);

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

    // Query using the hostname column. Join the owner so a destination kept
    // alive by a retired (soft-deleted) redirect is reclassified instead of
    // being silently treated as known.
    const result = await client.query(
      `SELECT rd.id, r.deleted_at AS owner_deleted_at
       FROM redirect_destinations rd
       JOIN redirects r ON r.id = rd.redirect_id
       WHERE rd.hostname = $1
       FOR UPDATE OF rd`,
      [canonicalDestination]
    );

    const existingDestination = result.rows[0];
    const ownerRetired =
      existingDestination != null && existingDestination.owner_deleted_at != null;

    if (existingDestination != null && !ownerRetired) {
      // If found and still owned by an active redirect, update the last seen timestamp
      await client.query(
        "UPDATE redirect_destinations SET last_seen = NOW() WHERE id = $1",
        [existingDestination.id]
      );
      await logRedirectEvent("existing_destination", `Known destination, updated last_seen`, sourceUrl, {
        hostname: canonicalDestination
      });
      // Commit the transaction - we're done
      await client.query('COMMIT');
      return;
    }

    if (ownerRetired) {
      // The owning redirect was retired. Hand the destination to the active
      // redirect that is seeing it now, then reclassify it below.
      await client.query(
        "UPDATE redirect_destinations SET redirect_id = $1 WHERE id = $2",
        [redirectId, existingDestination.id]
      );
      await logRedirectEvent("existing_destination", `Destination transferred from retired redirect`, sourceUrl, {
        hostname: canonicalDestination, redirect_id: redirectId
      });
    }

    // Classify the redirect destination
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

    if (ownerRetired) {
      // Update the transferred row with the fresh classification
      await client.query(
        `UPDATE redirect_destinations SET
           destination_url = $2,
           last_seen = NOW(),
           is_scam = $3,
           classifier_is_scam = $4,
           confidence_score = $5,
           signal_fullscreen = $6,
           signal_keyboard_lock = $7,
           signal_pointer_lock = $8,
           signal_third_party_hosting = $9,
           signal_ip_address = $10,
           signal_page_frozen = $11,
           signal_worker_bomb = $12
         WHERE id = $1`,
        [
          existingDestination.id,
          redirectDestination,
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

      await initTakedownStatusForDestination(existingDestination.id, isScam, client);

      await logRedirectEvent("new_destination", `Destination reactivated: ${redirectDestination} (${isScam ? "SCAM" : "clean"})`, sourceUrl, {
        destination: redirectDestination, hostname: canonicalDestination, is_scam: isScam, confidence: confidenceScore
      });

      if (isScam) {
        await reportScamDestination(redirectDestination, sourceUrl, classificationResult, signals, confidenceScore);
      }

      await client.query('COMMIT');
      return;
    }

    // Now we insert, still within the same transaction. ON CONFLICT keeps the
    // SELECT-then-INSERT atomic: concurrent checks redirecting to the same
    // hostname would otherwise both miss the SELECT and one would fail the
    // unique_hostname constraint.
    const insertResult = await client.query(
      `INSERT INTO redirect_destinations 
       (redirect_id, destination_url, hostname, is_scam, classifier_is_scam, confidence_score,
        signal_fullscreen, signal_keyboard_lock, signal_pointer_lock, 
        signal_third_party_hosting, signal_ip_address, signal_page_frozen, signal_worker_bomb) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (hostname) DO UPDATE SET last_seen = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
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

    if (insertResult.rows[0].inserted !== true) {
      // Another transaction inserted this hostname first; its cycle owns the
      // takedown init and any reporting.
      await logRedirectEvent("existing_destination", `Known destination, updated last_seen`, sourceUrl, {
        hostname: canonicalDestination
      });
      await client.query('COMMIT');
      return;
    }

    // Initialize security status for this new destination
    const destinationId = insertResult.rows[0].id;
    await initTakedownStatusForDestination(destinationId, isScam, client);

    await logRedirectEvent("new_destination", `New destination: ${redirectDestination} (${isScam ? "SCAM" : "clean"})`, sourceUrl, {
      destination: redirectDestination, hostname: canonicalDestination, is_scam: isScam, confidence: confidenceScore
    });

    // If it's a scam site, report it with the screenshot and HTML
    if (isScam) {
      await reportScamDestination(redirectDestination, sourceUrl, classificationResult, signals, confidenceScore);
    }
    
    // Commit the transaction
    await client.query('COMMIT');
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

async function reportScamDestination(
  destinationUrl: string,
  sourceUrl: string,
  classificationResult: ClassificationResult,
  signals: DetectedSignals,
  confidenceScore: number
): Promise<void> {
  await logScamReport(destinationUrl, "redirect");
  await logRedirectEvent("scam_found", `Scam detected: ${destinationUrl}`, sourceUrl, {
    destination: destinationUrl, confidence: confidenceScore
  });
  await reportSite(
    destinationUrl,
    sourceUrl,
    classificationResult.screenshot,
    classificationResult.html,
    { signals, confidenceScore }
  );
}
