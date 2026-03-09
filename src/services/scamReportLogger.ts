import pool from "../dbPool.js";

/**
 * Logs a scam detection to the persistent scam_reports table.
 * This table is append-only and never pruned, so stats survive
 * even when redirect_destinations or ads records are deleted.
 *
 * Fire-and-forget: errors are caught and logged to avoid disrupting detection flow.
 */
export async function logScamReport(url: string, sourceType: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO scam_reports (url, source_type) VALUES ($1, $2)`,
      [url, sourceType]
    );
  } catch (error) {
    console.error(`Failed to log scam report: ${error}`);
  }
}
