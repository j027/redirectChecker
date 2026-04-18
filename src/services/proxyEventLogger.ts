import pool from "../dbPool.js";

export type ProxyEventType = "ip_check" | "rotation" | "error";

/**
 * Logs a proxy event to the database for monitoring proxy IP changes and rotations.
 * Fire-and-forget: errors are caught and logged to console to avoid disrupting flow.
 */
export async function logProxyEvent(
  eventType: ProxyEventType,
  message: string,
  opts?: { ipAddress?: string; statusCode?: number }
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO proxy_events (event_type, ip_address, status_code, message)
       VALUES ($1, $2, $3, $4)`,
      [eventType, opts?.ipAddress ?? null, opts?.statusCode ?? null, message]
    );
  } catch (error) {
    console.error(`Failed to log proxy event: ${error}`);
  }
}

/**
 * Cleans up proxy events older than the specified number of days.
 */
export async function pruneProxyEvents(daysToKeep: number = 7): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM proxy_events WHERE created_at < NOW() - INTERVAL '1 day' * $1`,
      [daysToKeep]
    );
    return result.rowCount ?? 0;
  } catch (error) {
    console.error(`Failed to prune proxy events: ${error}`);
    return 0;
  }
}
