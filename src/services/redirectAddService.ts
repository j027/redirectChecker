import pool from "../dbPool.js";
import { hunterService, AddToRedirectCheckerResult } from "./hunterService.js";

/**
 * Bounded retry policy for adding cloaker candidates to the redirect checker.
 *
 * Adds are attempted when a scam destination is observed. A failed attempt is
 * retried on later sightings (with backoff) instead of being lost forever, but
 * a candidate that never works is permanently abandoned once exhausted so dead
 * redirects are not hammered indefinitely.
 */
const MAX_ATTEMPTS = 3;
const FIRST_RETRY_DELAY_MS = 30 * 60 * 1000; // 30 minutes
const SECOND_RETRY_DELAY_MS = 2 * 60 * 60 * 1000; // 2 hours

function backoffMs(completedAttempts: number): number {
  if (completedAttempts <= 1) {
    return FIRST_RETRY_DELAY_MS;
  }
  return SECOND_RETRY_DELAY_MS;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Returns true when an add attempt is allowed for this cloaker hostname.
 * Pending rows are allowed once past their backoff; exhausted/added rows never.
 */
export async function canAttemptAdd(hostname: string): Promise<boolean> {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT status, attempts, last_attempt_at
       FROM redirect_add_attempts
       WHERE hostname = $1`,
      [hostname]
    );

    if (result.rowCount === 0) {
      return true;
    }

    const row = result.rows[0];
    if (row.status !== "pending") {
      return false;
    }

    if (row.attempts >= MAX_ATTEMPTS) {
      return false;
    }

    if (row.last_attempt_at == null) {
      return true;
    }

    const elapsed = Date.now() - new Date(row.last_attempt_at).getTime();
    return elapsed >= backoffMs(row.attempts);
  } finally {
    client.release();
  }
}

/**
 * Records the outcome of an add attempt: success marks the hostname added,
 * failures increment the attempt count and exhaust after MAX_ATTEMPTS.
 */
export async function recordAddAttempt(
  hostname: string,
  added: boolean,
  error?: string
): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query(
      `INSERT INTO redirect_add_attempts
         (hostname, attempts, last_attempt_at, status, last_error)
       VALUES ($1, 1, CURRENT_TIMESTAMP, $2, $3)
       ON CONFLICT (hostname) DO UPDATE SET
         attempts = redirect_add_attempts.attempts + 1,
         last_attempt_at = CURRENT_TIMESTAMP,
         status = CASE
           WHEN $2 = 'added' THEN 'added'
           WHEN redirect_add_attempts.attempts + 1 >= $4 THEN 'exhausted'
           ELSE 'pending'
         END,
         last_error = $3`,
      [hostname, added ? "added" : "pending", error ?? null, MAX_ATTEMPTS]
    );
  } finally {
    client.release();
  }
}

export interface SightingAddResult {
  attempted: boolean;
  added: boolean;
  strategy: string | null;
}

/**
 * Attempts to add a cloaker candidate to the redirect checker for the current
 * sighting, respecting the bounded retry policy. Callers should send their
 * own "added" alert when `added` is true.
 */
export async function trySightingAdd(
  cloakerUrl: string
): Promise<SightingAddResult> {
  const hostname = hostnameOf(cloakerUrl);
  if (hostname == null) {
    return { attempted: false, added: false, strategy: null };
  }

  if (!(await canAttemptAdd(hostname))) {
    console.log(
      `Skipping add for ${hostname}: previous attempts pending backoff or exhausted`
    );
    return { attempted: false, added: false, strategy: null };
  }

  let result: AddToRedirectCheckerResult;
  try {
    result = await hunterService.tryAddToRedirectChecker(cloakerUrl);
  } catch (error) {
    await recordAddAttempt(hostname, false, String(error));
    throw error;
  }

  await recordAddAttempt(
    hostname,
    result.added,
    result.added ? undefined : "all redirect strategies failed"
  );

  return { attempted: true, added: result.added, strategy: result.strategy };
}
