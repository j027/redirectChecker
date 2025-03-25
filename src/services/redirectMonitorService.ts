import pool from "../dbPool.js";
import { handleRedirect } from "./redirectHandlerService.js";
import { RedirectType } from "../redirectType.js";
import { reportSite } from "./reportService.js";
import { initTakedownStatusForDestination } from "./takedownMonitorService.js";
import { browserReportService } from "./browserReportService.js";

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

  const [redirectDestination, isScam, screenshot, html] = await handleRedirect(
    sourceUrl,
    redirectType,
  );

  // if we didn't redirect anywhere
  if (redirectDestination == null) {
    return;
  }

  const client = await pool.connect();
  try {
    // Check if a record already exists for the given redirect destination
    const result = await client.query(
      "SELECT * FROM redirect_destinations WHERE destination_url = $1",
      [redirectDestination]
    );

    if (result.rows.length > 0) {
      // If found, update the last seen timestamp
      await client.query(
        "UPDATE redirect_destinations SET last_seen = NOW() WHERE destination_url = $1",
        [redirectDestination]
      );
    } else {
      // If not found, create a new entry with the redirect id, destination, and us_popup flag
      const insertResult = await client.query(
        "INSERT INTO redirect_destinations (redirect_id, destination_url, is_popup) VALUES ($1, $2, $3) RETURNING id",
        [redirectId, redirectDestination, isScam]
      );

      // Initialize security status for this new destination
      const destinationId = insertResult.rows[0].id;
      await initTakedownStatusForDestination(destinationId, isScam);

      // If it's a scam site, report it with the screenshot and HTML
      if (isScam) {
        await reportSite(redirectDestination, sourceUrl, screenshot, html);
      }
    }
  } catch (error) {
    console.log("Error updating redirect_history:", error);
  } finally {
    client.release();
  }
}
