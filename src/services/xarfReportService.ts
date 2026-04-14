import { randomUUID, createHash } from "crypto";
import nodemailer from "nodemailer";
import { readConfig } from "../config.js";
import pool from "../dbPool.js";

export interface XarfProvider {
  name: string;
  abuseEmail: string;
  hostPatterns: string[];
  xarfType: "fraud" | "phishing";
}

export const XARF_PROVIDERS: XarfProvider[] = [
  {
    name: "laravel-forge",
    abuseEmail: "security@laravel.com",
    hostPatterns: ["on-forge.com"],
    xarfType: "fraud",
  },
];

export function getMatchingXarfProvider(hostname: string): XarfProvider | null {
  const lower = hostname.toLowerCase();
  for (const provider of XARF_PROVIDERS) {
    for (const pattern of provider.hostPatterns) {
      if (lower.endsWith(`.${pattern}`) || lower === pattern) {
        return provider;
      }
    }
  }
  return null;
}

interface XarfEvidence {
  content_type: string;
  description: string;
  payload: string;
  hash: string;
  size: number;
}

interface XarfReport {
  xarf_version: string;
  report_id: string;
  timestamp: string;
  reporter: { org: string; contact: string; domain: string };
  sender: { org: string; contact: string; domain: string };
  source_identifier: string;
  category: "content";
  type: "fraud" | "phishing";
  url: string;
  evidence_source: "automated_scan";
  confidence?: number;
  evidence: XarfEvidence[];
  tags: string[];
  description: string;
}

const MAX_EVIDENCE_SIZE = 5 * 1024 * 1024; // 5MB per XARF spec

function buildEvidence(screenshot: Buffer | null): XarfEvidence[] {
  if (!screenshot || screenshot.length > MAX_EVIDENCE_SIZE) return [];

  const hash = createHash("sha256").update(screenshot).digest("hex");

  return [
    {
      content_type: "image/png",
      description: "Automated screenshot of scam page at time of detection",
      payload: screenshot.toString("base64"),
      hash: `sha256:${hash}`,
      size: screenshot.length,
    },
  ];
}

export function buildXarfReport(
  scamUrl: string,
  screenshot: Buffer | null,
  confidence: number | undefined,
  xarfType: "fraud" | "phishing",
  reporterOrg: string,
  reporterContact: string,
  reporterDomain: string
): XarfReport {
  let hostname: string;
  try {
    hostname = new URL(scamUrl).hostname;
  } catch {
    hostname = scamUrl;
  }

  const reporter = { org: reporterOrg, contact: reporterContact, domain: reporterDomain };

  return {
    xarf_version: "4.0.0",
    report_id: randomUUID(),
    timestamp: new Date().toISOString(),
    reporter,
    sender: reporter,
    source_identifier: hostname,
    category: "content",
    type: xarfType,
    url: scamUrl,
    evidence_source: "automated_scan",
    ...(confidence !== undefined && { confidence }),
    evidence: buildEvidence(screenshot),
    tags: ["severity:high", "detection:automated"],
    description:
      "Automated detection of a tech support scam. This page displays fake security warnings and uses browser-locking techniques to prevent users from leaving, coercing them into calling a fraudulent tech support number.",
  };
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
  scamUrl: string,
  sourceUrl: string | null,
  reportPayload: object,
  responseStatus: string,
  responseBody: string
): Promise<void> {
  await pool.query(
    `INSERT INTO abuse_reports (provider, report_type, scam_url, source_url, report_payload, response_status, response_body)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [provider, "xarf_email", scamUrl, sourceUrl, JSON.stringify(reportPayload), responseStatus, responseBody]
  );
}

export async function sendXarfReport(
  scamUrl: string,
  sourceUrl: string | null,
  screenshot: Buffer | null,
  confidence: number | undefined,
  provider: XarfProvider
): Promise<void> {
  if (await hasAlreadyReported(provider.name, scamUrl)) {
    console.info(`XARF [${provider.name}]: already reported ${scamUrl}, skipping`);
    return;
  }

  const config = await readConfig();

  const report = buildXarfReport(
    scamUrl,
    screenshot,
    confidence,
    provider.xarfType,
    config.xarfReporterOrg,
    config.xarfReporterContact,
    config.xarfReporterDomain
  );

  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: {
      user: config.smtpUser,
      pass: config.smtpPass,
    },
  });

  try {
    const info = await transporter.sendMail({
      from: config.xarfReporterContact,
      to: provider.abuseEmail,
      subject: `[XARF] Abuse Report: Scam/Fraud detected on ${new URL(scamUrl).hostname}`,
      text: JSON.stringify(report, null, 2),
      headers: {
        "X-XARF": "XARF",
        "Auto-Submitted": "auto-generated",
      },
    });

    await logAbuseReport(provider.name, scamUrl, sourceUrl, report, "success", info.messageId ?? "");
    console.info(`XARF [${provider.name}]: successfully reported ${scamUrl} (messageId: ${info.messageId})`);
  } catch (err) {
    await logAbuseReport(provider.name, scamUrl, sourceUrl, report, "error", String(err));
    console.error(`XARF [${provider.name}]: error reporting ${scamUrl}: ${err}`);
  }
}
