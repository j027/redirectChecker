// File: batchReportService.ts
import { readConfig } from "../config";
import { fetch } from "undici";

let batchInterval: NodeJS.Timeout;

// In\-memory queues
const netcraftQueue: Set<string> = new Set();
const crdfLabsQueue: Set<string> = new Set();

// Add a URL to the batch queues
export function enqueueReport(site: string): void {
  netcraftQueue.add(site);
  crdfLabsQueue.add(site);
}

interface NetcraftApiResponse {
  message: string;
  uuid: string;
}

// Flush batch of Netcraft reports
async function flushNetcraftQueue(): Promise<void> {
  if (netcraftQueue.size === 0) return;

  const { netcraftReportEmail, netcraftSourceExtension } = await readConfig();
  const iosAppUserAgent =
    "Report Phishing/5.0.0 (com.netcraft.BlockList.Report-Phishing; build:105; iOS 18.3.1) Alamofire/1.0";

  // Convert Set to array of objects
  const urls = Array.from(netcraftQueue).map((url) => ({ url, country: null }));
  netcraftQueue.clear();

  try {
    const response = (await fetch(
      "https://report.netcraft.com/api/v3/report/urls",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": iosAppUserAgent,
        },
        body: JSON.stringify({
          email: netcraftReportEmail,
          source: netcraftSourceExtension,
          urls,
        }),
      },
    ).then((r) => r.json())) as NetcraftApiResponse;
    console.info(
      `Netcraft batched report success: message: ${response?.message}, uuid: ${response?.uuid}`,
    );
  } catch (error) {
    console.error("Netcraft batched report failed", error);
  }
}

// Flush batch of CRDF Labs reports
async function flushCrdfLabsQueue(): Promise<void> {
  if (crdfLabsQueue.size === 0) return;

  const { crdfLabsApiKey } = await readConfig();

  const urls = Array.from(crdfLabsQueue);
  crdfLabsQueue.clear();

  try {
    const response = await fetch(
      "https://threatcenter.crdf.fr/api/v0/submit_url.json",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: crdfLabsApiKey,
          method: "submit_url",
          urls,
        }),
      },
    );
    await response.json();
    console.info("CRDF Labs batched report submitted successfully.");
  } catch (error) {
    console.error("CRDF Labs batched report failed", error);
  }
}

// Flush both queues
async function flushQueues(): Promise<void> {
  await Promise.allSettled([flushNetcraftQueue(), flushCrdfLabsQueue()]);
}

// Start a scheduled job to flush queues once every hour
export function startBatchReportProcessor(): void {
  // 3600000ms = 1 hour
  batchInterval = setInterval(flushQueues, 3600000);
}

export function stopBatchReportProcessor(): void {
  clearInterval(batchInterval);
}
