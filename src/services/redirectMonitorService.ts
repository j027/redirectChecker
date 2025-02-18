import pool from "../dbPool";
import { handleRedirect } from "./redirectHandlerService";
import { RedirectType } from "../redirectType";
import {reportSite} from "./reportService";

export async function checkRedirects() {
  const client = await pool.connect();
  let redirects;
  try {
    redirects = await client.query("SELECT * FROM redirects");
  } catch (e) {
    console.log(e);
    return;
  } finally {
    client.release();
  }

  const redirectHandlers: Promise<void>[] = [];

  redirects.rows.forEach((row) => {
    const sourceUrl: string = row.source_url;
    const regex = new RegExp(row.regex_pattern);
    const type = row.type as RedirectType;
    const redirectId = row.id as number;
    redirectHandlers.push(processRedirectEntry(sourceUrl, regex, type, redirectId));
  });

  await Promise.allSettled(redirectHandlers);
}

async function processRedirectEntry(
  sourceUrl: string,
  regex: RegExp,
  redirectType: RedirectType,
  redirectId: number
): Promise<void> {
  const [redirectDestination, isPopup] = await handleRedirect(
    sourceUrl,
    regex,
    redirectType,
  );

  // if we didn't redirect anywhere
  if (redirectDestination == null) {
    console.log(
      `The redirect with source ${sourceUrl} did not go anywhere, this may be expected if redirect is disabled`,
    );
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
      // If not found, create a new entry with the redirect id, destination, and is_popup flag
      await client.query(
        "INSERT INTO redirect_destinations (redirect_id, destination_url, is_popup) VALUES ($1, $2, $3)",
        [redirectId, redirectDestination, isPopup]
      );

      // if it is a popup, make sure to report it
      if (isPopup) {
        await reportSite(redirectDestination, sourceUrl);
      }
    }
  } catch (error) {
    console.log("Error updating redirect_history:", error);
  } finally {
    client.release();
  }
}
