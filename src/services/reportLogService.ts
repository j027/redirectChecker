import pool from "../dbPool.js";

export type ReportChannel =
  | "cloudflare_urlscan"
  | "urlscan"
  | "netcraft"
  | "safe_browsing_crx"
  | "virustotal"
  | "kaspersky"
  | "metadefender"
  | "smartscreen"
  | "safe_browsing_web_form"
  | "checkphish"
  | "hybrid_analysis"
  | "crdf"
  | "web_risk"
  | "discourse"
  | "discord"
  | "msrc"
  | "xarf";

export type ReportCategory =
  | "scan"
  | "threat_intel"
  | "abuse_report"
  | "notification";

export type ReportStatus =
  | "queued"
  | "success"
  | "submitted"
  | "error"
  | "captcha"
  | "blocked"
  | "rejected"
  | "skipped"
  | "abandoned";

export type ReportTerminalStatus = Exclude<ReportStatus, "queued">;

export interface ReportContext {
  sourceUrl?: string | null;
  provider?: string | null;
  redirectDestinationId?: number | null;
  adId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ReportLogInput {
  channel: ReportChannel;
  category: ReportCategory;
  url: string;
  sourceUrl?: string | null;
  provider?: string | null;
  redirectDestinationId?: number | null;
  adId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ReportOutcome {
  status: ReportTerminalStatus;
  httpStatus?: number | null;
  externalId?: string | null;
  externalUrl?: string | null;
  responseSnippet?: string | null;
  errorMessage?: string | null;
  abuseReportId?: number | null;
  metadata?: Record<string, unknown>;
}

const MAX_RESPONSE_SNIPPET = 4000;
const MAX_ERROR_MESSAGE = 2000;

export function truncateResponse(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  return value.length > MAX_RESPONSE_SNIPPET
    ? value.slice(0, MAX_RESPONSE_SNIPPET)
    : value;
}

function truncateError(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  return value.length > MAX_ERROR_MESSAGE
    ? value.slice(0, MAX_ERROR_MESSAGE)
    : value;
}

export function reportInput(
  channel: ReportChannel,
  category: ReportCategory,
  url: string,
  context?: ReportContext,
  metadata?: Record<string, unknown>
): ReportLogInput {
  return {
    channel,
    category,
    url,
    sourceUrl: context?.sourceUrl ?? null,
    provider: context?.provider ?? null,
    redirectDestinationId: context?.redirectDestinationId ?? null,
    adId: context?.adId ?? null,
    metadata: {
      ...(context?.metadata ?? {}),
      ...(metadata ?? {}),
    },
  };
}

/**
 * Inserts the start of a report attempt. Returns null when logging fails so
 * reporting itself is never blocked by the audit table.
 */
export async function startReport(
  input: ReportLogInput,
  options: { startedAt?: Date | null } = {}
): Promise<number | null> {
  try {
    const result = await pool.query(
      `INSERT INTO report_submissions
         (channel, category, status, url, source_url, provider,
          redirect_destination_id, ad_id, started_at, metadata)
       VALUES ($1, $2, 'queued', $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input.channel,
        input.category,
        input.url,
        input.sourceUrl ?? null,
        input.provider ?? null,
        input.redirectDestinationId ?? null,
        input.adId ?? null,
        options.startedAt === undefined ? new Date() : options.startedAt,
        JSON.stringify(input.metadata ?? {}),
      ]
    );
    return Number(result.rows[0].id);
  } catch (error) {
    console.error(`Failed to log report start (${input.channel}): ${error}`);
    return null;
  }
}

/**
 * Finishes a report attempt. Only transitions a row that is not already
 * complete, so a late duplicate cannot overwrite terminal history.
 */
export async function finishReport(
  id: number | null,
  outcome: ReportOutcome
): Promise<void> {
  if (id == null) {
    return;
  }

  try {
    await pool.query(
      `UPDATE report_submissions
       SET status = $2,
           completed_at = now(),
           started_at = COALESCE(started_at, now()),
           http_status = $3,
           external_id = $4,
           external_url = $5,
           response_snippet = $6,
           error_message = $7,
           abuse_report_id = $8,
           metadata = metadata || $9::jsonb
       WHERE id = $1
         AND completed_at IS NULL`,
      [
        id,
        outcome.status,
        outcome.httpStatus ?? null,
        outcome.externalId ?? null,
        outcome.externalUrl ?? null,
        truncateResponse(outcome.responseSnippet),
        truncateError(outcome.errorMessage),
        outcome.abuseReportId ?? null,
        JSON.stringify(outcome.metadata ?? {}),
      ]
    );
  } catch (error) {
    console.error(`Failed to log report finish (id ${id}): ${error}`);
  }
}

/**
 * Runs a reporter and records both its start and terminal outcome. Reporter
 * exceptions become an error outcome so one channel cannot abort the fan-out.
 */
export async function trackReport(
  input: ReportLogInput,
  run: () => Promise<ReportOutcome>
): Promise<ReportOutcome> {
  const id = await startReport(input, { startedAt: new Date() });

  try {
    const outcome = await run();
    await finishReport(id, outcome);
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[report:${input.channel}] ${message}`);
    const outcome: ReportOutcome = {
      status: "error",
      errorMessage: message,
    };
    await finishReport(id, outcome);
    return outcome;
  }
}

/** Records a report that was deliberately not attempted. */
export async function logSkippedReport(
  input: ReportLogInput,
  reason: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const id = await startReport(input, { startedAt: new Date() });
  await finishReport(id, {
    status: "skipped",
    metadata: { reason, ...(metadata ?? {}) },
  });
}

export async function markReportStarted(id: number | null): Promise<void> {
  if (id == null) {
    return;
  }

  try {
    await pool.query(
      `UPDATE report_submissions
       SET started_at = COALESCE(started_at, now())
       WHERE id = $1
         AND completed_at IS NULL`,
      [id]
    );
  } catch (error) {
    console.error(`Failed to mark report started (id ${id}): ${error}`);
  }
}

export async function updateReportProgress(
  id: number | null,
  metadata: Record<string, unknown>
): Promise<void> {
  if (id == null) {
    return;
  }

  try {
    await pool.query(
      `UPDATE report_submissions
       SET metadata = metadata || $2::jsonb
       WHERE id = $1
         AND completed_at IS NULL`,
      [id, JSON.stringify(metadata)]
    );
  } catch (error) {
    console.error(`Failed to update report progress (id ${id}): ${error}`);
  }
}

/**
 * Marks queued rows that can no longer be running as abandoned. Used for the
 * in-memory Safe Browsing queue on startup and as a periodic safety net.
 */
export async function abandonStaleReports(
  olderThanMinutes: number,
  channel?: ReportChannel
): Promise<number> {
  try {
    const params: Array<number | string> = [olderThanMinutes];
    let channelClause = "";
    if (channel != null) {
      params.push(channel);
      channelClause = ` AND channel = $2`;
    }

    const result = await pool.query(
      `UPDATE report_submissions
       SET status = 'abandoned',
           completed_at = now(),
           error_message = COALESCE(error_message, 'stale queued report'),
           metadata = metadata || '{"reason":"stale"}'::jsonb
       WHERE status = 'queued'
         AND submitted_at < now() - make_interval(mins => $1::int)${channelClause}`,
      params
    );
    return result.rowCount ?? 0;
  } catch (error) {
    console.error(`Failed to abandon stale reports: ${error}`);
    return 0;
  }
}

export async function pruneReportSubmissions(
  daysToKeep: number = 365
): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM report_submissions
       WHERE completed_at IS NOT NULL
         AND submitted_at < now() - make_interval(days => $1::int)`,
      [daysToKeep]
    );
    return result.rowCount ?? 0;
  } catch (error) {
    console.error(`Failed to prune report submissions: ${error}`);
    return 0;
  }
}
