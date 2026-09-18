import pool from "../dbPool.js";
import { logRedirectEvent } from "./redirectEventLogger.js";
import { isDnsResolvable } from "./takedownMonitorService.js";

/**
 * Retires redirects that are no longer active or useful.
 *
 * Retirement is a soft delete: rows keep their destinations and takedown
 * history, are excluded from monitoring, and can be revived if the redirect is
 * seen again.
 */
export async function pruneOldRedirects(): Promise<void> {
  console.log("Starting redirect pruning process...");
  
  try {
    await pruneNonResolvingRedirects();
    await pruneInactiveScamRedirects();
    console.log("Redirect pruning completed successfully");
  } catch (error) {
    console.error("Error during redirect pruning:", error);
  }
}

/**
 * Retires redirects where the source URL no longer resolves via DNS
 */
async function pruneNonResolvingRedirects(): Promise<void> {
  const client = await pool.connect();
  
  try {
    // Get all active source URLs
    const result = await client.query(
      "SELECT id, source_url FROM redirects WHERE deleted_at IS NULL"
    );
    
    const nonResolvingIds: number[] = [];
    
    // Check each source URL for DNS resolution
    for (const row of result.rows) {
      const sourceUrl = row.source_url;
      const isResolvable = await isDnsResolvable(sourceUrl);

      if (!isResolvable) {
        nonResolvingIds.push(row.id);
      }
    }
    
    // Retire non-resolving redirects
    if (nonResolvingIds.length > 0) {
      const retiredCount = await retireRedirects(client, nonResolvingIds, "dns_unresolvable");
      console.log(`Retired ${retiredCount} redirects that no longer resolve via DNS`);
    } else {
      console.log("No non-resolving redirects found");
    }
    
  } finally {
    client.release();
  }
}

/**
 * Retires redirects that haven't led to a scam in the last 5 days.
 * Skips redirects created less than 1 day ago to give them time to be classified.
 */
async function pruneInactiveScamRedirects(): Promise<void> {
  const client = await pool.connect();
  
  try {
    // Find redirects that haven't led to a scam in the last 5 days,
    // but only if the redirect itself is older than 1 day
    const result = await client.query(`
      SELECT r.id, r.source_url 
      FROM redirects r
      WHERE r.deleted_at IS NULL
        AND r.created_at < NOW() - INTERVAL '1 day'
        AND NOT EXISTS (
          SELECT 1 
          FROM redirect_destinations rd
          WHERE rd.redirect_id = r.id
            AND rd.is_scam = true
            AND rd.last_seen > NOW() - INTERVAL '5 days'
        )
    `);
    
    if (result.rows.length > 0) {
      const inactiveIds = result.rows.map(row => row.id);
      const retiredCount = await retireRedirects(client, inactiveIds, "inactive_scam");
      console.log(`Retired ${retiredCount} redirects that haven't led to scams in the last 5 days`);
    } else {
      console.log("No inactive scam redirects found");
    }
    
  } finally {
    client.release();
  }
}

/**
 * Helper function to soft-delete (retire) redirects by ID
 */
async function retireRedirects(
  client: any,
  redirectIds: number[],
  reason: string
): Promise<number> {
  if (redirectIds.length === 0) return 0;
  
  try {
    const result = await client.query(`
      UPDATE redirects
      SET deleted_at = CURRENT_TIMESTAMP,
          deleted_reason = $2
      WHERE id = ANY($1::int[])
        AND deleted_at IS NULL
      RETURNING id, source_url
    `, [redirectIds, reason]);

    for (const row of result.rows) {
      await logRedirectEvent(
        "redirect_retired",
        `Retired redirect (${reason})`,
        row.source_url,
        { reason }
      );
    }

    return result.rowCount;
  } catch (error) {
    console.error("Error retiring redirects:", error);
    throw error;
  }
}
