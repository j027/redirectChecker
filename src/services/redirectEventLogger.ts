import pool from "../dbPool.js";

export type RedirectEventType =
  | "check_start"
  | "check_end"
  | "redirect_followed"
  | "new_destination"
  | "classification"
  | "scam_found"
  | "no_redirect"
  | "existing_destination"
  | "error";

/**
 * Logs a redirect checker event to the database for debugging and monitoring.
 * Fire-and-forget: errors are caught and logged to console to avoid disrupting redirect flow.
 */
export async function logRedirectEvent(
  eventType: RedirectEventType,
  message: string,
  sourceUrl?: string,
  details?: Record<string, unknown>
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO redirect_events (event_type, source_url, message, details)
       VALUES ($1, $2, $3, $4)`,
      [eventType, sourceUrl ?? null, message, details ? JSON.stringify(details) : null]
    );
  } catch (error) {
    // Don't let logging failures disrupt the redirect checking flow
    console.error(`Failed to log redirect event: ${error}`);
  }
}

/**
 * Cleans up redirect events older than the specified number of days.
 */
export async function pruneRedirectEvents(daysToKeep: number = 7): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM redirect_events WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
      [daysToKeep]
    );
    return result.rowCount ?? 0;
  } catch (error) {
    console.error(`Failed to prune redirect events: ${error}`);
    return 0;
  }
}
