import pool from "../dbPool.js";

export type HunterType = "search" | "typosquat" | "pornhub" | "adspyglass" | "scheduler";

export type HunterEventType =
  | "cycle_start"
  | "cycle_end"
  | "browser_restart"
  | "ads_found"
  | "ad_processed"
  | "ad_skipped"
  | "classification"
  | "scam_detected"
  | "added_to_checker"
  | "status_changed"
  | "error"
  | "timeout"
  | "whitelisted";

/**
 * Logs a hunter event to the database for debugging and monitoring.
 * Fire-and-forget: errors are caught and logged to console to avoid disrupting hunt flow.
 */
export async function logHunterEvent(
  hunterType: HunterType,
  eventType: HunterEventType,
  message: string,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO hunter_events (hunter_type, event_type, message, details)
       VALUES ($1, $2, $3, $4)`,
      [hunterType, eventType, message, details ? JSON.stringify(details) : null]
    );
  } catch (error) {
    // Don't let logging failures disrupt the hunting flow
    console.error(`Failed to log hunter event: ${error}`);
  }
}

/**
 * Cleans up hunter events older than the specified number of days.
 */
export async function pruneHunterEvents(daysToKeep: number = 7): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM hunter_events WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
      [daysToKeep]
    );
    return result.rowCount ?? 0;
  } catch (error) {
    console.error(`Failed to prune hunter events: ${error}`);
    return 0;
  }
}
