import { fetch } from "undici";
import { promises as fs } from "fs";
import path from "path";
import crypto from "crypto";
import { readConfig } from "../config.js";
import pool from "../dbPool.js";

const MSRC_API_BASE = "https://api.msrc.microsoft.com/report/v3.0";
const MSRC_ABUSE_ENDPOINT = `${MSRC_API_BASE}/abuse`;
const MSRC_FILE_ENDPOINT = `${MSRC_API_BASE}/file`;
const MSRC_TIMEOUT_MS = 30 * 1000;
const MSRC_SCREENSHOT_DIR = path.join(process.cwd(), "data", "msrc");
const RETRY_GAP_MS = 30 * 60 * 1000;
const RETRY_MAX_ATTEMPTS = 3;
const RETRY_WINDOW = "24 hours";

interface MsrcAbuseReport {
  date: string;
  time: string;
  timeZone: string; // format: "+0000" or "-0000"
  threatType: "URL";
  incidentType: "Phishing";
  reporterName: string;
  reporterEmail: string;
  reporterOrg?: string;
  reportNotes: string;
  source: "ReportApi";
  severity: "High" | "Medium" | "Low";
  anonymizeReport: boolean;
  sourceUrl: string;
  destinationUrl: string;
  attachmentId?: string;
  attachmentFileName?: string;
  testSubmission?: boolean;
}

async function hasAlreadyReported(provider: string, scamUrl: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM abuse_reports WHERE provider = $1 AND scam_url = $2 LIMIT 1",
    [provider, scamUrl]
  );
  return (result.rowCount ?? 0) > 0;
}

async function logAbuseReport(
  provider: string,
  reportType: string,
  scamUrl: string,
  sourceUrl: string | null,
  reportPayload: object,
  responseStatus: string,
  responseBody: string
): Promise<void> {
  await pool.query(
    `INSERT INTO abuse_reports (provider, report_type, scam_url, source_url, report_payload, response_status, response_body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [provider, reportType, scamUrl, sourceUrl, JSON.stringify(reportPayload), responseStatus, responseBody]
  );
}

function screenshotPath(scamUrl: string): string {
  const hash = crypto.createHash("sha256").update(scamUrl).digest("hex");
  return path.join(MSRC_SCREENSHOT_DIR, `${hash}.png`);
}

async function saveScreenshot(scamUrl: string, screenshot: Buffer): Promise<void> {
  try {
    await fs.mkdir(MSRC_SCREENSHOT_DIR, { recursive: true });
    await fs.writeFile(screenshotPath(scamUrl), screenshot, { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      console.error(`Error saving MSRC screenshot for ${scamUrl}: ${err}`);
    }
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

// 504s and timeouts are held for review: MSRC may have accepted the report before the timeout.
function isRetryable(status: string): boolean {
  if (status === "error") return true;
  return /^error_5\d\d$/.test(status) && status !== "error_504";
}

async function uploadScreenshot(screenshot: Buffer): Promise<string | null> {
  try {
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="screenshot.png"\r\n`),
      Buffer.from(`Content-Type: image/png\r\n\r\n`),
      screenshot,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const response = await fetch(MSRC_FILE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
      signal: AbortSignal.timeout(MSRC_TIMEOUT_MS),
    });

    if (response.ok) {
      const json = await response.json() as { name: string; id: string }[];
      return json?.[0]?.id || null;
    }

    console.error(`MSRC screenshot upload failed: ${response.status}`);
    return null;
  } catch (err) {
    console.error(`Error uploading screenshot to MSRC: ${err}`);
    return null;
  }
}

export async function reportToMsrc(
  scamUrl: string,
  sourceUrl: string,
  screenshot?: Buffer | null
): Promise<void> {
  if (await hasAlreadyReported("msrc", scamUrl)) {
    console.info(`MSRC: already reported ${scamUrl}, skipping`);
    return;
  }

  const config = await readConfig();
  const now = new Date();

  let attachmentId: string | null = null;
  if (screenshot) {
    await saveScreenshot(scamUrl, screenshot);
    attachmentId = await uploadScreenshot(screenshot);
  }

  const report: MsrcAbuseReport = {
    date: now.toISOString().slice(0, 10),
    time: now.toISOString().slice(11, 19),
    timeZone: "+0000",
    threatType: "URL",
    incidentType: "Phishing",
    reporterName: config.msrcReporterName,
    reporterEmail: config.msrcReporterEmail,
    reportNotes: `Automated detection of a tech support scam page hosted on Microsoft infrastructure. This page impersonates a security warning and uses browser-locking techniques (such as fullscreen, keyboard lock, and/or fake error dialogs) to coerce victims into calling a fraudulent support number.`,
    source: "ReportApi",
    severity: "High",
    anonymizeReport: true,
    destinationUrl: scamUrl,
    sourceUrl,
    ...(attachmentId && {
      attachmentId,
      attachmentFileName: "screenshot.png",
    }),
    ...(config.msrcReporterOrg && { reporterOrg: config.msrcReporterOrg }),
  };

  await sendReport(scamUrl, sourceUrl, report);
}

async function sendReport(scamUrl: string, sourceUrl: string, report: MsrcAbuseReport): Promise<string> {
  let status: string;
  let responseBody: string;
  try {
    const response = await fetch(MSRC_ABUSE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
      signal: AbortSignal.timeout(MSRC_TIMEOUT_MS),
    });

    responseBody = await response.text();
    status = response.ok ? "success" : `error_${response.status}`;
  } catch (err) {
    responseBody = err instanceof Error ? `${err.message}${err.cause ? ` (cause: ${err.cause})` : ""}` : String(err);
    status = isTimeout(err) ? "error_timeout" : "error";
  }

  await logAbuseReport("msrc", "msrc_api", scamUrl, sourceUrl, report, status, responseBody);

  if (status === "success") {
    console.info(`Successfully reported to MSRC: ${scamUrl}`);
  } else {
    console.error(`MSRC report failed for ${scamUrl}: ${status} - ${responseBody}`);
  }

  return status;
}

export async function retryFailedMsrcReports(): Promise<void> {
  const result = await pool.query(
    `SELECT scam_url,
            max(reported_at) AS last_attempt,
            (array_agg(response_status ORDER BY reported_at DESC))[1] AS last_status
     FROM abuse_reports
     WHERE provider = 'msrc'
     GROUP BY scam_url
     HAVING NOT bool_or(response_status = 'success')
        AND min(reported_at) > now() - $1::interval
        AND count(*) < $2`,
    [RETRY_WINDOW, RETRY_MAX_ATTEMPTS]
  );

  for (const row of result.rows as { scam_url: string; last_attempt: Date; last_status: string }[]) {
    if (!isRetryable(row.last_status)) continue;
    if (Date.now() - row.last_attempt.getTime() < RETRY_GAP_MS) continue;

    try {
      await retryMsrcReport(row.scam_url);
    } catch (err) {
      console.error(`MSRC retry failed for ${row.scam_url}: ${err}`);
    }
  }
}

async function retryMsrcReport(scamUrl: string): Promise<void> {
  const latest = await pool.query(
    `SELECT report_payload FROM abuse_reports
     WHERE provider = 'msrc' AND scam_url = $1
     ORDER BY reported_at DESC
     LIMIT 1`,
    [scamUrl]
  );

  const report: MsrcAbuseReport = { ...latest.rows[0].report_payload };
  delete report.attachmentId;
  delete report.attachmentFileName;

  const screenshot = await fs.readFile(screenshotPath(scamUrl)).catch(() => null);
  if (screenshot) {
    const attachmentId = await uploadScreenshot(screenshot);
    if (attachmentId) {
      report.attachmentId = attachmentId;
      report.attachmentFileName = "screenshot.png";
    }
  }

  await sendReport(scamUrl, report.sourceUrl, report);
}
