import { fetch } from "undici";
import { readConfig } from "../config.js";
import pool from "../dbPool.js";

const MSRC_API_BASE = "https://api.msrc.microsoft.com/report/v3.0";
const MSRC_ABUSE_ENDPOINT = `${MSRC_API_BASE}/abuse`;
const MSRC_FILE_ENDPOINT = `${MSRC_API_BASE}/file`;

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

  try {
    const response = await fetch(MSRC_ABUSE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });

    const responseBody = await response.text();
    const status = response.ok ? "success" : `error_${response.status}`;

    await logAbuseReport("msrc", "msrc_api", scamUrl, sourceUrl, report, status, responseBody);

    if (response.ok) {
      console.info(`Successfully reported to MSRC: ${scamUrl}`);
    } else {
      console.error(`MSRC report failed for ${scamUrl}: ${response.status} - ${responseBody}`);
    }
  } catch (err) {
    const errMsg = err instanceof Error ? `${err.message}${err.cause ? ` (cause: ${err.cause})` : ""}` : String(err);
    await logAbuseReport("msrc", "msrc_api", scamUrl, sourceUrl, report, "error", errMsg);
    console.error(`Error reporting to MSRC: ${errMsg}`);
  }
}
