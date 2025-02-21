// File: batchReportService.ts
import { readConfig } from "../config";
import { fetch } from "undici";
import { setTimeout } from "node:timers/promises";

// In-memory queues
const netcraftQueue: Set<string> = new Set();
const crdfLabsQueue: Set<string> = new Set();
const urlscanQueue: Set<string> = new Set();

// Add a URL to the batch queues
export function enqueueReport(site: string): void {
  netcraftQueue.add(site);
  crdfLabsQueue.add(site);
  urlscanQueue.add(site);
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

// Process URLScan in batches of 60
async function processUrlscanBatch(): Promise<void> {
  if (urlscanQueue.size === 0) return;

  const { urlscanApiKey } = await readConfig();
  const urls = Array.from(urlscanQueue).slice(0, 60);

  for (const url of urls) {
    try {
      await fetch("https://urlscan.io/api/v1/scan/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "API-Key": urlscanApiKey
        },
        body: JSON.stringify({
          url: url,
          visibility: "public"
        })
      });
      urlscanQueue.delete(url); // Remove only processed URLs
    } catch (error) {
      console.error(`URLScan submission failed for ${url}`);
      urlscanQueue.delete(url); // Remove failed ones too since we're ignoring failures
    }
  }

  // If there are more URLs, wait a minute and process the next batch
  if (urlscanQueue.size > 0) {
    await setTimeout(60000);
    await processUrlscanBatch();
  }
}

// Flush both queues
export async function flushQueues(): Promise<void> {
  await Promise.allSettled([
    flushNetcraftQueue(), 
    flushCrdfLabsQueue(),
    processUrlscanBatch()
  ]);
}
