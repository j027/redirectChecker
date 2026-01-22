import pool from "../dbPool.js";
import { isDnsResolvable } from "./takedownMonitorService.js";

/**
 * Prunes redirects that are no longer active or useful
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
 * Removes redirects where the source URL no longer resolves via DNS
 */
async function pruneNonResolvingRedirects(): Promise<void> {
  const client = await pool.connect();
  
  try {
    // Get all source URLs
    const result = await client.query(
      "SELECT id, source_url FROM redirects"
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
    
    // Delete non-resolving redirects
    if (nonResolvingIds.length > 0) {
      const deletedCount = await deleteRedirects(client, nonResolvingIds);
      console.log(`Removed ${deletedCount} redirects that no longer resolve via DNS`);
    } else {
      console.log("No non-resolving redirects found");
    }
    
  } finally {
    client.release();
  }
}

/**
 * Removes redirects that haven't led to a scam in the last 5 days
 */
async function pruneInactiveScamRedirects(): Promise<void> {
  const client = await pool.connect();
  
  try {
    // Find redirects that haven't led to a scam in the last 5 days
    const result = await client.query(`
      SELECT r.id 
      FROM redirects r
      WHERE NOT EXISTS (
        SELECT 1 
        FROM redirect_destinations rd
        WHERE rd.redirect_id = r.id
          AND rd.is_scam = true
          AND rd.last_seen > NOW() - INTERVAL '5 days'
      )
    `);
    
    if (result.rows.length > 0) {
      const inactiveIds = result.rows.map(row => row.id);
      const deletedCount = await deleteRedirects(client, inactiveIds);
      console.log(`Removed ${deletedCount} redirects that haven't led to scams in the last 5 days`);
    } else {
      console.log("No inactive scam redirects found");
    }
    
  } finally {
    client.release();
  }
}

/**
 * Helper function to delete redirects by ID
 */
async function deleteRedirects(client: any, redirectIds: number[]): Promise<number> {
  if (redirectIds.length === 0) return 0;
  
  try {
    // Simply delete from redirects table - cascade will handle the rest
    const redirectResult = await client.query(`
      DELETE FROM redirects
      WHERE id = ANY($1::int[])
    `, [redirectIds]);
    
    return redirectResult.rowCount;
  } catch (error) {
    console.error("Error deleting redirects:", error);
    throw error;
  }
}