/**
 * Capture-only Taboola click URL pattern discovery.
 *
 * Logs in to Yahoo Mail, captures real Taboola responses, and reports
 * the click URL hosts/parameters that expose a landing page. It never clicks
 * an ad, writes ads, sends alerts, or reports anything.
 *
 * Usage:
 *   yarn tsx scripts/taboola-patterns.ts
 *   yarn tsx scripts/taboola-patterns.ts --capture-window=45000
 */
import { promises as fs } from "fs";
import path from "path";
// hunterService must load before taboolaHunter because the two modules import
// each other (same pattern as the hunter tests).
import "../src/services/hunterService.js";
import {
  TaboolaBid,
  taboolaHunter,
} from "../src/services/taboolaHunter.js";
import { unwrapYahooClickUrl } from "../src/utils/urlUtils.js";

const OUTPUT_DIR = path.join(process.cwd(), "data", "taboola");

interface PatternSummary {
  host: string;
  parameter: string;
  destinationHosts: Set<string>;
  count: number;
  exampleDestination: string;
}

function parseCaptureWindow(): number {
  const argument = process.argv.find((value) =>
    value.startsWith("--capture-window=")
  );
  if (argument == null) {
    return 35_000;
  }

  const value = Number.parseInt(argument.split("=")[1] ?? "", 10);
  return Number.isFinite(value) && value >= 5_000 ? value : 35_000;
}

function tryDecodeUrl(value: string): string | null {
  const candidates: string[] = [value];

  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) {
      candidates.push(decoded);
    }
  } catch {
    // Ignore malformed escapes.
  }

  try {
    const base64 = Buffer.from(value, "base64").toString("utf8");
    if (base64.startsWith("http://") || base64.startsWith("https://")) {
      candidates.push(base64);
    }
  } catch {
    // Not base64.
  }

  for (const candidate of candidates) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        return parsed.toString();
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function summarizeDestination(destination: string): string {
  try {
    const parsed = new URL(destination);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "(invalid)";
  }
}

function analyzeBid(
  bid: TaboolaBid,
  summaries: Map<string, PatternSummary>
): void {
  const clickUrl = bid.creative?.clickUrl;
  if (clickUrl == null) {
    return;
  }

  let parsed: URL;
  try {
    parsed = new URL(clickUrl);
  } catch {
    return;
  }

  const add = (parameter: string, destination: string): void => {
    const key = `${parsed.hostname}|${parameter}`;
    const existing = summaries.get(key);
    if (existing != null) {
      existing.count++;
      existing.destinationHosts.add(summarizeDestination(destination));
      return;
    }

    summaries.set(key, {
      host: parsed.hostname,
      parameter,
      destinationHosts: new Set([summarizeDestination(destination)]),
      count: 1,
      exampleDestination: summarizeDestination(destination),
    });
  };

  const unwrapped = unwrapYahooClickUrl(clickUrl);
  if (unwrapped != null) {
    try {
      const unwrappedUrl = new URL(unwrapped);
      add("path:/rurl/", unwrappedUrl.toString());
    } catch {
      add("path:/rurl/", unwrapped);
    }
  }

  for (const [parameter, value] of parsed.searchParams) {
    const decoded = tryDecodeUrl(value);
    if (decoded != null) {
      add(parameter, decoded);
    }
  }

  // Path-based redirects: /redirect/<url>, /go/<url>, /r/<url>.
  for (const marker of ["/redirect/", "/go/", "/r/"]) {
    const index = parsed.pathname.indexOf(marker);
    if (index === -1) {
      continue;
    }

    const pathDestination = parsed.pathname.slice(index + marker.length);
    const decoded = tryDecodeUrl(pathDestination);
    if (decoded != null) {
      add(`path:${marker}`, decoded);
    }
  }
}

async function main(): Promise<void> {
  const captureWindowMs = parseCaptureWindow();

  console.log(
    `Capturing Taboola responses for ${captureWindowMs / 1000}s (no clicks)`
  );

  await taboolaHunter.init();
  try {
    const result = await taboolaHunter.huntTaboolaAds({
      patternOnly: true,
      captureWindowMs,
    });

    if (result.status === "failed") {
      console.error(`Capture failed: ${result.reason}`);
      process.exitCode = 1;
      return;
    }

    const bids = result.bids ?? [];
    console.log(`\nCaptured ${bids.length} actionable bid(s)\n`);

    if (bids.length === 0) {
      console.log("No bids with a usable destination were captured.");
      return;
    }

    const summaries = new Map<string, PatternSummary>();
    for (const bid of bids) {
      analyzeBid(bid, summaries);
    }

    const rows = Array.from(summaries.values()).sort(
      (a, b) => b.count - a.count
    );

    console.log(
      "Host".padEnd(34) +
        "Parameter".padEnd(18) +
        "Count".padEnd(7) +
        "Destination host/path"
    );
    console.log("-".repeat(100));
    for (const row of rows) {
      console.log(
        row.host.padEnd(34) +
          row.parameter.padEnd(18) +
          String(row.count).padEnd(7) +
          Array.from(row.destinationHosts).join(", ")
      );
    }

    console.log("\nPer-bid resolution:");
    for (const bid of bids) {
      console.log(
        `- ${bid.advertiserDomains.join(",") || "(no adomain)"} ` +
          `cid=${bid.campaignId ?? "?"} crid=${bid.creativeId ?? "?"} ` +
          `src=${bid.destination?.source ?? "none"} ` +
          `click=${bid.destination?.requiresClick ?? "?"} ` +
          `placement=${bid.placement ?? "?"} floor=${bid.bidfloor ?? "?"}`
      );
      if (bid.destination != null) {
        console.log(`  -> ${bid.destination.url}`);
      }
    }

    const report = {
      generatedAt: new Date().toISOString(),
      captureWindowMs,
      bidCount: bids.length,
      patterns: rows.map((row) => ({
        host: row.host,
        parameter: row.parameter,
        count: row.count,
        destinationHosts: Array.from(row.destinationHosts),
        exampleDestination: row.exampleDestination,
      })),
      bids: bids.map((bid) => ({
        advertiserDomains: bid.advertiserDomains,
        campaignId: bid.campaignId,
        creativeId: bid.creativeId,
        placement: bid.placement,
        bidfloor: bid.bidfloor,
        destinationSource: bid.destination?.source,
        requiresClick: bid.destination?.requiresClick,
        destination: bid.destination?.url,
      })),
    };

    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const reportPath = path.join(
      OUTPUT_DIR,
      `patterns-${timestamp}.json`
    );
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nSaved report to ${reportPath}`);
  } finally {
    await taboolaHunter.close();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
