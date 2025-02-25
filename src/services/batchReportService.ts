// File: batchReportService.ts
import { readConfig } from "../config";
import { fetch } from "undici";

// In-memory queues
const crdfLabsQueue: Set<string> = new Set();

// Add a URL to the batch queues
export function enqueueReport(site: string): void {
  crdfLabsQueue.add(site);
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

// Flush all batch queues
export async function flushQueues(): Promise<void> {
  await Promise.allSettled([
    flushCrdfLabsQueue(),
  ]);
}
