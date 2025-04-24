import pool from "../dbPool.js";
import { handleRedirect } from "./redirectHandlerService.js";
import { RedirectType } from "../redirectType.js";
import { reportSite } from "./reportService.js";
import { initTakedownStatusForDestination } from "./takedownMonitorService.js";
import { aiClassifierService } from "./aiClassifierService.js";

export async function checkRedirects() {
  const client = await pool.connect();
  let redirects;
  try {
    redirects = await client.query("SELECT id, source_url, type FROM redirects");
  } catch (e) {
    console.log(e);
    return;
  } finally {
    client.release();
  }

  const redirectHandlers: Promise<void>[] = [];

  redirects.rows.forEach((row) => {
    const sourceUrl: string = row.source_url;
    const type = row.type as RedirectType;
    const redirectId = row.id as number;
    redirectHandlers.push(processRedirectEntry(sourceUrl, type, redirectId));
  });

  await Promise.allSettled(redirectHandlers);
}

async function processRedirectEntry(
  sourceUrl: string,
  redirectType: RedirectType,
  redirectId: number
): Promise<void> {

  const redirectDestination = await handleRedirect(sourceUrl, redirectType);

  // if we didn't redirect anywhere
  if (redirectDestination == null) {
    return;
  }

  const client = await pool.connect();
  try {
    // Start a transaction
    await client.query('BEGIN');

    let canonicalDestination: string;
    try {
      const urlObj = new URL(redirectDestination);
      // Extract just the hostname and path for canonical comparison
      // Strip trailing slash from pathname for consistent matching
      const pathname = urlObj.pathname.endsWith('/') && urlObj.pathname.length > 1 
        ? urlObj.pathname.slice(0, -1) 
        : urlObj.pathname;
      canonicalDestination = urlObj.hostname + pathname;
    } catch (e) {
      console.log("Failed to parse URL, falling back to full URL:", e);
      canonicalDestination = redirectDestination;
    }

    // Use a simpler and more reliable approach for URL matching
    const result = await client.query(
      "SELECT id FROM redirect_destinations WHERE " +
      "host(regexp_replace(destination_url, 'https?://', '')) = host(regexp_replace($1, 'https?://', '')) " +
      "FOR UPDATE",
      [redirectDestination]
    );

    if (result.rows.length > 0) {
      // If found, update the last seen timestamp
      await client.query(
        "UPDATE redirect_destinations SET last_seen = NOW() WHERE id = $1",
        [result.rows[0].id]
      );
      // Commit the transaction - we're done
      await client.query('COMMIT');
    } else {
      // If not found, classify the redirect and handle appropriately
      const classificationResult = await aiClassifierService.classifyUrl(redirectDestination);
      if (classificationResult == null) {
        console.log("Could not get a classification result - giving up");
        await client.query('ROLLBACK'); // Roll back transaction
        return;
      }

      // Now we insert, still within the same transaction
      const insertResult = await client.query(
        "INSERT INTO redirect_destinations (redirect_id, destination_url, is_popup) VALUES ($1, $2, $3) RETURNING id",
        [redirectId, redirectDestination, classificationResult.isScam]
      );

      // Initialize security status for this new destination
      const destinationId = insertResult.rows[0].id;
      await initTakedownStatusForDestination(destinationId, classificationResult.isScam, client);

      // If it's a scam site, report it with the screenshot and HTML
      if (classificationResult.isScam) {
        await reportSite(
          redirectDestination,
          sourceUrl,
          classificationResult.screenshot,
          classificationResult.html
        );
      }
      
      // Commit the transaction
      await client.query('COMMIT');
    }
  } catch (error) {
    // If an error occurs, roll back the transaction
    await client.query('ROLLBACK');
    console.log("Error updating redirect_history:", error);
  } finally {
    client.release();
  }
}
