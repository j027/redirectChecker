import { readConfig } from "../config.js";
import { fetch } from "undici";
import { discordClient } from "../discordClient.js";
import { TextChannel, EmbedBuilder } from "discord.js";
import { userAgentService } from "./userAgentService.js";
import { browserReportService } from "./browserReportService.js";
import pool from "../dbPool.js";
import { WebRiskServiceClient } from '@google-cloud/web-risk';
import { DetectedSignals } from './signalService.js';
import { formatSignals, formatConfidence, SignalData } from '../utils/discordFormatting.js';
import { isMicrosoftHosted } from '../utils/hostingDetection.js';
import { reportToMsrc } from './msrcReportService.js';
import { getMatchingXarfProvider, sendXarfReport } from './xarfReportService.js';
import { redactIpFromUrl } from '../utils/urlUtils.js';
import { reportToDiscourse } from './discourseReportService.js';
import {
  ReportContext,
  ReportOutcome,
  reportInput,
  trackReport,
  truncateResponse,
} from './reportLogService.js';

let webRiskClient: WebRiskServiceClient|null = null; 

async function readResponseSnippet(
  response: Awaited<ReturnType<typeof fetch>>
): Promise<string> {
  return truncateResponse(await response.text()) ?? "";
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function reportToGoogleSafeBrowsing(
  site: string,
  screenshot: Buffer | null,
  html: string | null,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("safe_browsing_crx", "threat_intel", site, context),
    async () => {
      // fail hard if the user agent is not available - this ensures this is properly fixed
      const userAgent = await userAgentService.getUserAgent();
      if (userAgent == null) {
        throw new Error("Failed to get user agent");
      }

      // request format can be found here
      // https://github.com/chromium/suspicious-site-reporter/blob/444666114ec758df1c151514cfd9e2218141da42/extension/client_request.proto#L21
      const reportBody = [site, null];
      
      // If screenshot and HTML are provided, use them directly
      if (screenshot && html) {
        reportBody.push(screenshot.toString("base64"), html);
      }

      const response = await fetch(
        "https://safebrowsing.google.com/safebrowsing/clientreport/crx-report",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": userAgent },
          body: JSON.stringify(reportBody),
        },
      );
      const responseText = await readResponseSnippet(response);

      if (response.ok) {
        console.info(`Successfully reported to Google Safe Browsing: ${site}`);
        return {
          status: "success",
          httpStatus: response.status,
          responseSnippet: responseText,
        };
      }

      console.error(`Google Safe Browsing report failed for ${site}: Status ${response.status}${responseText ? ` - ${responseText}` : ''}`);
      return {
        status: "error",
        httpStatus: response.status,
        responseSnippet: responseText,
        errorMessage: `HTTP ${response.status}`,
      };
    }
  );
}

interface NetcraftApiResponse {
  message: string;
  uuid: string;
}

export async function reportToNetcraft(
  site: string,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("netcraft", "threat_intel", site, context),
    async () => {
      const { netcraftReportEmail } = await readConfig();

      const response = await fetch("https://report.netcraft.com/api/v3/report/urls", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: netcraftReportEmail,
          urls: [{ url: site, country: "US" }],
        }),
      });
      const text = await readResponseSnippet(response);
      const data = parseJson<NetcraftApiResponse>(text);

      if (!response.ok) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: `HTTP ${response.status}`,
        };
      }

      if (data?.uuid == null) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "Netcraft response missing uuid",
        };
      }

      console.info(`Netcraft report message: ${data.message} uuid: ${data.uuid}`);
      return {
        status: "success",
        httpStatus: response.status,
        externalId: data.uuid,
        responseSnippet: text,
        metadata: { message: data.message },
      };
    }
  );
}

interface UrlscanResponse {
  message: string;
  uuid: string;
  visibility: string;
  url: string;
}

async function reportToUrlscan(
  site: string,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("urlscan", "scan", site, context),
    async () => {
      const { urlscanApiKey } = await readConfig();

      const response = await fetch("https://urlscan.io/api/v1/scan/", {
        method: "POST",
        headers: {
          "API-Key": urlscanApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: site,
          visibility: "public",
        }),
      });
      const text = await readResponseSnippet(response);
      const data = parseJson<UrlscanResponse>(text);

      if (!response.ok) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: `HTTP ${response.status}`,
        };
      }

      if (data?.uuid == null) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "URLScan response missing uuid",
        };
      }

      console.info(`Reported to URLScan: ${site} (uuid: ${data.uuid}, message: ${data.message})`);
      return {
        status: "submitted",
        httpStatus: response.status,
        externalId: data.uuid,
        externalUrl: `https://urlscan.io/result/${data.uuid}/`,
        responseSnippet: text,
        metadata: { message: data.message, visibility: data.visibility },
      };
    }
  );
}

interface VirusTotalResponse {
  data: {
    id: string;
    type: string;
  };
}

async function reportToVirusTotal(
  site: string,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("virustotal", "scan", site, context),
    async () => {
      const { virusTotalApiKey } = await readConfig();
      const response = await fetch("https://www.virustotal.com/api/v3/urls", {
        method: "POST",
        headers: {
          "x-apikey": virusTotalApiKey
        },
        body: new URLSearchParams({
          url: site
        })
      });
      const text = await readResponseSnippet(response);
      const data = parseJson<VirusTotalResponse>(text);

      if (!response.ok) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: `HTTP ${response.status}`,
        };
      }

      if (data?.data?.id == null) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "VirusTotal response missing data.id",
        };
      }

      console.info(`VirusTotal report id: ${data.data.id}`);
      return {
        status: "submitted",
        httpStatus: response.status,
        externalId: data.data.id,
        responseSnippet: text,
        metadata: { analysis_id: data.data.id },
      };
    }
  );
}

interface KasperskyResponse {
  Zone?: string;
  UrlGeneralInfo?: {
    Url: string;
    Host: string;
    Categories: string[];
  };
}

async function reportToKaspersky(
  site: string,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("kaspersky", "threat_intel", site, context, { mode: "lookup" }),
    async () => {
      const { kasperskyApiKey } = await readConfig();
      
      const url = new URL('https://opentip.kaspersky.com/api/v1/search/url');
      url.searchParams.append('request', site);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "x-api-key": kasperskyApiKey
        }
      });
      const text = await readResponseSnippet(response);
      const data = parseJson<KasperskyResponse>(text);

      if (!response.ok) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: `HTTP ${response.status}`,
        };
      }

      if (data == null) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "Kaspersky response was not JSON",
        };
      }

      console.info(`Reported to Kaspersky: ${site} (Zone: ${data.Zone || 'unknown'})`);
      return {
        status: "success",
        httpStatus: response.status,
        responseSnippet: text,
        metadata: {
          mode: "lookup",
          zone: data.Zone ?? null,
          categories: data.UrlGeneralInfo?.Categories ?? null,
        },
      };
    }
  );
}

interface MetaDefenderResponse {
  status: string;
  in_queue: number;
  queue_priority: string;
  sandbox_id: string;
}

async function reportToMetaDefender(
  site: string,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("metadefender", "scan", site, context),
    async () => {
      const { metaDefenderApiKey } = await readConfig();
      
      const response = await fetch("https://api.metadefender.com/v4/sandbox", {
        method: "POST",
        headers: {
          "apikey": metaDefenderApiKey,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          url: site
        })
      });
      const text = await readResponseSnippet(response);
      const data = parseJson<MetaDefenderResponse>(text);

      if (!response.ok) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: `HTTP ${response.status}`,
        };
      }

      if (data?.sandbox_id == null) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "MetaDefender response missing sandbox_id",
        };
      }

      console.info(`Reported to MetaDefender: ${site} (sandbox_id: ${data.sandbox_id}, status: ${data.status})`);
      return {
        status: "submitted",
        httpStatus: response.status,
        externalId: data.sandbox_id,
        responseSnippet: text,
        metadata: {
          provider_status: data.status,
          in_queue: data.in_queue,
          queue_priority: data.queue_priority,
        },
      };
    }
  );
}

interface CheckPhishResponse {
  jobID: string;
  timestamp: number;
}

async function reportToCheckPhish(
  site: string,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("checkphish", "scan", site, context),
    async () => {
      const { checkPhishApiKey } = await readConfig();
      
      const response = await fetch("https://developers.bolster.ai/api/neo/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          apiKey: checkPhishApiKey,
          urlInfo: { url: site },
          scanType: "full"
        })
      });
      const text = await readResponseSnippet(response);
      const data = parseJson<CheckPhishResponse>(text);

      if (!response.ok) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: `HTTP ${response.status}`,
        };
      }

      if (data?.jobID == null) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "CheckPhish response missing jobID",
        };
      }

      console.info(`Reported to CheckPhish: ${site} (jobID: ${data.jobID})`);
      return {
        status: "submitted",
        httpStatus: response.status,
        externalId: data.jobID,
        responseSnippet: text,
        metadata: { timestamp: data.timestamp },
      };
    }
  );
}

interface HybridAnalysisResponse {
  job_id: string;
  submission_id: string;
  environment_id: number;
  sha256: string;
}

async function reportToHybridAnalysis(
  site: string,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("hybrid_analysis", "scan", site, context),
    async () => {
      const { hybridAnalysisApiKey } = await readConfig();

      // fail hard if the user agent is not available - this ensures this is properly fixed
      const userAgent = await userAgentService.getUserAgent();
      if (userAgent == null) {
        throw new Error("Failed to get user agent");
      }
      
      const response = await fetch("https://www.hybrid-analysis.com/api/v2/submit/url", {
        method: "POST",
        headers: {
          "api-key": hybridAnalysisApiKey,
          "User-Agent": userAgent,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          url: site,
          environment_id: "140" // win11 64bit
        })
      });
      const text = await readResponseSnippet(response);
      const data = parseJson<HybridAnalysisResponse>(text);

      if (!response.ok) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: `HTTP ${response.status}`,
        };
      }

      if (data?.job_id == null) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "Hybrid Analysis response missing job_id",
        };
      }

      console.info(`Reported to Hybrid Analysis: ${site} (job_id: ${data.job_id})`);
      return {
        status: "submitted",
        httpStatus: response.status,
        externalId: data.job_id,
        responseSnippet: text,
        metadata: {
          submission_id: data.submission_id,
          sha256: data.sha256,
          environment_id: data.environment_id,
        },
      };
    }
  );
}

interface CloudflareUrlScannerResponse {
  uuid: string;
  api: string;
  visibility: "public" | "private";
  url: string;
  result: string;
  message: string;
}

export async function reportToCloudflareUrlScanner(
  site: string,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("cloudflare_urlscan", "scan", site, context),
    async () => {
      const { cloudflareUrlScannerApiKey, cloudflareAccountId } =
        await readConfig();

      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/urlscanner/v2/scan`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${cloudflareUrlScannerApiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: site,
          }),
        }
      );
      const text = await readResponseSnippet(response);
      const data = parseJson<CloudflareUrlScannerResponse>(text);

      if (!response.ok) {
        console.error(`Cloudflare URL Scanner report failed for ${site}: ${response.status} ${text}`);
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: `HTTP ${response.status}`,
        };
      }

      if (data?.uuid == null) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "Cloudflare response missing uuid",
        };
      }

      console.info(`Reported to Cloudflare URL Scanner: ${site} (scanId: ${data.uuid})`);
      return {
        status: "submitted",
        httpStatus: response.status,
        externalId: data.uuid,
        externalUrl: data.result ?? null,
        responseSnippet: text,
        metadata: {
          api_url: data.api,
          visibility: data.visibility,
          message: data.message,
        },
      };
    }
  );
}

interface CrdfLabsResponse {
  error: boolean;
  error_code: string | null;
  message: string | null;
  data: {
    msg: string;
    ref: string;
    report_url?: string;
  } | null;
}

async function reportToCrdfLabs(
  site: string,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("crdf", "scan", site, context),
    async () => {
      const { crdfLabsApiKey } = await readConfig();

      if (!crdfLabsApiKey) {
        return { status: "skipped", metadata: { reason: "not_configured" } };
      }

      const response = await fetch(
        "https://threatcenter.crdf.fr/api/v1/submit_url.json",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${crdfLabsApiKey}`,
          },
          body: JSON.stringify({
            method: "submit_url",
            urls: [site],
          }),
        },
      );
      const text = await readResponseSnippet(response);
      const data = parseJson<CrdfLabsResponse>(text);

      if (!response.ok) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: `HTTP ${response.status}`,
        };
      }

      if (data == null) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "CRDF response was not JSON",
        };
      }

      if (data.error) {
        console.error(`CRDF Labs report error: code=${data.error_code}, message=${data.message}`);
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: data.message ?? data.error_code ?? "CRDF report error",
          metadata: { error_code: data.error_code },
        };
      }

      if (data.data?.ref == null) {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "CRDF response missing ref",
        };
      }

      console.info(`CRDF Labs report: message=${data.data.msg}, reference=${data.data.ref}`);
      return {
        status: "submitted",
        httpStatus: response.status,
        externalId: data.data.ref,
        externalUrl: data.data.report_url ?? null,
        responseSnippet: text,
        metadata: { message: data.data.msg },
      };
    }
  );
}

export async function initializeGoogleWebRiskClient() {
  try {
    webRiskClient = new WebRiskServiceClient();
    await webRiskClient.initialize();
  }
  catch (error) {
    console.error(`There was an error trying to initialize google web risk client ${error}`);
    webRiskClient = null;
  }
}

// this is just the enterprise version of the google safe browsing api
// they have a fully documented reporting api, that automatically classifies and flags much faster
// than the undocumented api
// the api is limited to 100 free reports per month though
async function reportToGoogleWebRisk(
  site: string,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("web_risk", "threat_intel", site, context),
    async () => {
      if (webRiskClient == null) {
        console.log("Google web risk api is not authenticated, skipping this report");
        return { status: "skipped", metadata: { reason: "not_configured" } };
      }
      
      const { googleWebRiskApiProjectName } = await readConfig();
      
      // Begin transaction to handle report count tracking
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        
        // Get current month in standardized format (first day of month)
        const currentMonth = (await client.query(
          `SELECT date_trunc('month', CURRENT_DATE) as month`
        )).rows[0].month;
        
        // First, try to select the current row with FOR UPDATE to lock it
        const currentRow = await client.query(
          `SELECT report_count FROM webrisk_monthly_reports 
           WHERE month = $1 FOR UPDATE`,
          [currentMonth]
        );
        
        let reportCount;
        if (currentRow.rowCount === 0) {
          // No row exists, insert a new one
          const insertResult = await client.query(
            `INSERT INTO webrisk_monthly_reports (month, report_count)
             VALUES ($1, 1)
             RETURNING report_count`,
            [currentMonth]
          );
          reportCount = insertResult.rows[0].report_count;
        } else {
          // Row exists, update it
          const updateResult = await client.query(
            `UPDATE webrisk_monthly_reports
             SET report_count = report_count + 1
             WHERE month = $1
             RETURNING report_count`,
            [currentMonth]
          );
          reportCount = updateResult.rows[0].report_count;
        }
        
        // Check if we're at or over limit
        if (reportCount > 100) {
          // We've exceeded our monthly limit, revert the increment
          await client.query(
            `UPDATE webrisk_monthly_reports SET report_count = report_count - 1 WHERE month = $1`,
            [currentMonth]
          );
          await client.query('COMMIT');
          console.warn(`Monthly Google Web Risk report limit reached (${reportCount-1}/100). Skipping report for: ${site}`);
          return {
            status: "skipped",
            metadata: { reason: "monthly_limit", report_count: reportCount - 1 },
          };
        }
        
        // We're under the limit, proceed with report
        try {
          // Create submission request
          const createSubmissionRequest = {
            parent: googleWebRiskApiProjectName,
            submission: {
              uri: site
            }
          };
          
          // Submit to Web Risk API
          const [operation] = await webRiskClient.submitUri(createSubmissionRequest);
          
          console.info(`Reported to Google Web Risk API: ${site} (${reportCount}/100 monthly reports)`);
          console.log("Web Risk operation tracking details:", {
            name: operation.name,
            done: operation.done,
            metadata: operation.metadata,
          });
          
          // Commit transaction to finalize count update
          await client.query('COMMIT');
          return {
            status: "submitted",
            externalId: operation.name ?? null,
            metadata: {
              report_count: reportCount,
              operation_name: operation.name ?? null,
              operation_done: operation.done ?? null,
            },
          };
        } catch (apiError) {
          // API call failed, rollback the counter increment
          await client.query(
            `UPDATE webrisk_monthly_reports SET report_count = report_count - 1 WHERE month = $1`,
            [currentMonth]
          );
          await client.query('COMMIT');
          console.error(`Error submitting to Google Web Risk API: ${apiError}`);
          return {
            status: "error",
            errorMessage: String(apiError),
            metadata: { report_count: reportCount },
          };
        }
      } catch (dbError) {
        // Handle database transaction errors
        await client.query('ROLLBACK');
        console.error(`Database error in Web Risk reporting: ${dbError}`);
        return { status: "error", errorMessage: String(dbError) };
      } finally {
        // Always release the client
        client.release();
      }
    }
  );
}

export interface ReportOptions {
  signals?: DetectedSignals;
  confidenceScore?: number;
  redirectDestinationId?: number;
  adId?: string;
}

const BEHAVIOR_SIGNAL_LABELS: Array<[keyof DetectedSignals, string]> = [
  ["fullscreenRequested", "fullscreen trap"],
  ["keyboardLockRequested", "keyboard lock"],
  ["pointerLockRequested", "pointer lock"],
  ["pageLoadFrozen", "frozen page"],
  ["workerBombDetected", "worker flood"],
];

function buildSafeBrowsingReportDetails(
  urlscanUuid: string | null,
  signals?: DetectedSignals,
  confidenceScore?: number
): string {
  let details = "Automated report: tech support scam detected";

  if (confidenceScore !== undefined) {
    details += ` (classifier confidence ${(confidenceScore * 100).toFixed(1)}%)`;
  }
  details += ".";

  const behaviors = BEHAVIOR_SIGNAL_LABELS
    .filter(([key]) => signals?.[key])
    .map(([, label]) => label);
  if (behaviors.length > 0) {
    details += ` Page behavior: ${behaviors.join(", ")}.`;
  }

  if (urlscanUuid) {
    details += ` URLScan: https://urlscan.io/result/${urlscanUuid}/`;
  }

  return details;
}

export async function reportSite(
  site: string, 
  redirect: string, 
  screenshot: Buffer | null, 
  html: string | null,
  options?: ReportOptions
) {
  // Redact any IP addresses leaked in query parameter values before forwarding
  // to external reporters. Hostnames are intentionally left unchanged so scam
  // destinations remain identifiable.
  site = redactIpFromUrl(site);
  redirect = redactIpFromUrl(redirect);

  const context: ReportContext = {
    sourceUrl: redirect,
    redirectDestinationId: options?.redirectDestinationId ?? null,
    adId: options?.adId ?? null,
    metadata: {
      ...(options?.confidenceScore !== undefined
        ? { confidence_score: options.confidenceScore }
        : {}),
    },
  };

  // Submit to external scanners first so we can link their screenshots in the Discourse post.
  const [cfResult, urlscanResult] = await Promise.allSettled([
    reportToCloudflareUrlScanner(site, context),
    reportToUrlscan(site, context),
  ]);
  const cloudflareOutcome =
    cfResult.status === "fulfilled" ? cfResult.value : null;
  const urlscanOutcome =
    urlscanResult.status === "fulfilled" ? urlscanResult.value : null;
  const cloudflareScanId = cloudflareOutcome?.externalId ?? null;
  const urlscanUuid = urlscanOutcome?.externalId ?? null;

  const enrichedContext: ReportContext = {
    ...context,
    metadata: {
      ...(context.metadata ?? {}),
      ...(cloudflareScanId ? { cloudflare_scan_id: cloudflareScanId } : {}),
      ...(urlscanUuid ? { urlscan_uuid: urlscanUuid } : {}),
    },
  };

  // report to google safe browsing, netcraft, virustotal, kaspersky, metadefender, microsoft smartscreen,
  // checkphish, hybrid analysis, and crdf labs
  const reports = [];
  reports.push(reportToNetcraft(site, enrichedContext));
  reports.push(reportToGoogleSafeBrowsing(site, screenshot, html, enrichedContext));
  reports.push(reportToVirusTotal(site, enrichedContext));
  reports.push(reportToKaspersky(site, enrichedContext));
  reports.push(reportToMetaDefender(site, enrichedContext));
  reports.push(browserReportService.reportToSmartScreen(site, enrichedContext));
  reports.push(browserReportService.enqueueSafeBrowsingReport(
    site,
    buildSafeBrowsingReportDetails(urlscanUuid, options?.signals, options?.confidenceScore),
    enrichedContext
  ));
  reports.push(reportToCheckPhish(site, enrichedContext));
  reports.push(reportToHybridAnalysis(site, enrichedContext));
  reports.push(reportToCrdfLabs(site, enrichedContext));

  // google web risk api (needs special permission to get access)
  reports.push(reportToGoogleWebRisk(site, enrichedContext));

  // send a message in the discord server with a link to the popup
  reports.push(sendMessageToDiscord(site, redirect, options?.signals, options?.confidenceScore, enrichedContext));

  // report to Discourse
  reports.push(reportToDiscourse(site, redirect, cloudflareScanId, urlscanUuid, enrichedContext));

  // MSRC reporting for Microsoft-hosted scam URLs
  try {
    const siteHostname = new URL(site).hostname;
    if (isMicrosoftHosted(siteHostname)) {
      reports.push(reportToMsrc(site, redirect, screenshot, enrichedContext));
    }

    // XARF reporting for matching hosting providers
    const xarfProvider = getMatchingXarfProvider(siteHostname);
    if (xarfProvider) {
      reports.push(sendXarfReport(site, redirect, screenshot, options?.confidenceScore, xarfProvider, enrichedContext));
    }
  } catch {
    // URL parsing failed — skip hosting-based reports
  }

  // wait for all the reports to finish
  await Promise.allSettled(reports);
}

async function sendMessageToDiscord(
  site: string, 
  redirect: string, 
  signals?: DetectedSignals, 
  confidenceScore?: number,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("discord", "notification", site, context),
    async () => {
      const { channelId } = await readConfig();
      const channel = discordClient.channels.cache.get(channelId) as TextChannel;
      if (!channel) {
        console.error("Channel not found");
        return { status: "error", errorMessage: "Discord channel not found" };
      }

      // Build an embed for the scam report
      const embed = new EmbedBuilder()
        .setTitle('🚨 Scam Detected')
        .setColor(0xff4444)
        .setTimestamp();
      
      // Add scam URL field
      try {
        const siteUrl = new URL(site);
        embed.addFields({
          name: 'Scam URL',
          value: `[${siteUrl.hostname}](${site})`,
          inline: false
        });
      } catch {
        embed.addFields({
          name: 'Scam URL',
          value: site,
          inline: false
        });
      }
      
      // Add source/redirect field
      if (redirect !== site) {
        try {
          const redirectUrl = new URL(redirect);
          embed.addFields({
            name: 'Source',
            value: `[${redirectUrl.hostname}](${redirect})`,
            inline: true
          });
        } catch {
          embed.addFields({
            name: 'Source',
            value: redirect,
            inline: true
          });
        }
      }
      
      // Add confidence field
      if (confidenceScore !== undefined) {
        embed.addFields({
          name: 'Confidence',
          value: formatConfidence(confidenceScore),
          inline: true
        });
      }
      
      // Add signals field
      if (signals) {
        const signalData: SignalData = {
          fullscreen: signals.fullscreenRequested,
          keyboardLock: signals.keyboardLockRequested,
          pointerLock: signals.pointerLockRequested,
          thirdPartyHosting: signals.isThirdPartyHosting,
          ipAddress: signals.isIpAddress,
          pageFrozen: signals.pageLoadFrozen,
          workerBomb: signals.workerBombDetected,
        };
        const signalEmojis = formatSignals(signalData);
        if (signalEmojis) {
          embed.addFields({
            name: 'Signals',
            value: signalEmojis,
            inline: true
          });
        }
      }
      
      const message = await channel.send({ embeds: [embed] });
      return {
        status: "success",
        externalId: message.id,
        externalUrl: message.url,
        metadata: { channel_id: channelId },
      };
    }
  );
}
