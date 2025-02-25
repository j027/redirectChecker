// File: batchReportService.ts
import { readConfig } from "../config";
import { fetch } from "undici";

// In-memory queues
const crdfLabsQueue: Set<string> = new Set();

// Add a URL to the batch queues
export function enqueueReport(site: string): void {
  crdfLabsQueue.add(site);
}

interface CrdfLabsResponse {
  success: boolean;
  message: string;
  urls_submitted?: number;
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
    const data = await response.json() as CrdfLabsResponse;
    console.info(`CRDF Labs report: success=${data.success}, message=${data.message}, urls submitted=${data.urls_submitted}`);
  } catch (error) {
    console.error("CRDF Labs batched report failed", error);
  }
}

// Flush all batch queues
export async function flushQueues(): Promise<void> {
  await Promise.allSettled([
    flushCrdfLabsQueue(),
  ]);
}
