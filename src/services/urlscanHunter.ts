import { Browser } from "patchright";
import { fetch } from "undici";
import { aiClassifierService } from "./aiClassifierService.js";
import { reportToNetcraft } from "./reportService.js";
import { logScamReport } from "./scamReportLogger.js";
import {
  parseProxy,
  blockGoogleAnalytics,
  spoofWindowsChrome,
  simulateRandomMouseMovements,
} from "../utils/playwrightUtilities.js";
import { BrowserManagerService } from "./browserManagerService.js";
import {
  createSignalService,
  DetectedSignals,
  hasWeightedSignal,
} from "./signalService.js";
import { CONFIDENCE_THRESHOLD } from "./hunterService.js";
import pool from "../dbPool.js";

// --- URLScan API types ---

interface UrlscanLiveResult {
  task: {
    uuid: string;
    url: string;
    domain: string;
    time: string;
  };
  page?: {
    url?: string;
    domain?: string;
  };
  screenshot: string; // URL to screenshot PNG
  _id: string;
}

interface UrlscanLiveResponse {
  results: UrlscanLiveResult[];
}

// --- URLScan Hunter ---

export class UrlscanHunter {
  private processedUuids = new Set<string>();
  // Cap in-memory set to prevent unbounded growth
  private static readonly MAX_PROCESSED_CACHE = 50_000;

  /**
   * Polls the urlscan.io live feed and processes results.
   * Returns true if the cycle completed without fatal errors.
   */
  async runCycle(): Promise<boolean> {
    try {
      const results = await this.fetchLiveFeed();
      if (results.length === 0) return true;

      await this.incrementScanCount(results.length);

      for (const result of results) {
        try {
          await this.processResult(result);
        } catch (error) {
          console.error(
            `[urlscan-hunter] Error processing ${result._id}: ${error}`,
          );
        }
      }

      return true;
    } catch (error) {
      console.error(`[urlscan-hunter] Cycle error: ${error}`);
      return false;
    }
  }

  /**
   * Fetches the latest results from urlscan.io live feed.
   * Returns the most recent batch; deduplication is handled by UUID.
   */
  private async fetchLiveFeed(): Promise<UrlscanLiveResult[]> {
    const response = await fetch("https://urlscan.io/json/live/", {
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      console.error(`[urlscan-hunter] Feed returned ${response.status}`);
      return [];
    }

    const data = (await response.json()) as UrlscanLiveResponse;
    return data.results ?? [];
  }

  /**
   * Processes a single urlscan result through the pipeline:
   * 1. Dedup by UUID
   * 2. Download & classify screenshot
   * 3. If high confidence → browser verify + signal check
   * 4. If confirmed scam → report to Netcraft
   */
  private async processResult(result: UrlscanLiveResult): Promise<void> {
    const uuid = result._id;
    const url = result.page?.url ?? result.task.url;

    // Skip if we've already seen this UUID in-memory
    if (this.processedUuids.has(uuid)) return;
    this.markProcessed(uuid);

    // Skip if whitelisted
    if (aiClassifierService.isWhitelisted(url)) return;

    // Skip if already in our urlscan_reports table (DB dedup)
    if (await this.isAlreadyProcessed(uuid)) return;

    // Skip if already reported via any source
    if (await this.isAlreadyReported(url)) return;

    // --- Stage 2: Download screenshot & classify ---
    const screenshotBuffer = await this.downloadScreenshot(result.screenshot);
    if (!screenshotBuffer) return;

    const classification =
      await aiClassifierService.runInference(screenshotBuffer);
    const { isScam: rawIsScam, confidenceScore } = classification;

    if (!rawIsScam || confidenceScore < CONFIDENCE_THRESHOLD) return;

    // Classifier says scam with high confidence — increment stat
    await this.incrementClassifiedCount();

    // --- Stage 3: Browser verification ---
    let signals: DetectedSignals | null = null;
    let freshScreenshot: Buffer | null = null;

    try {
      const verification = await this.browserVerify(url);
      if (verification) {
        signals = verification.signals;
        freshScreenshot = verification.screenshot;
      }
    } catch (error) {
      console.error(
        `[urlscan-hunter] Browser verification failed for ${url}: ${error}`,
      );
    }

    // Ignore third-party hosting signal for urlscan — too many false positives at this volume
    if (signals) {
      signals.isThirdPartyHosting = false;
    }

    // Need both high confidence AND a weighted signal
    if (!signals || !hasWeightedSignal(signals)) return;

    // --- Stage 4: Report to Netcraft ---
    let reportedSuccessfully = false;
    try {
      await reportToNetcraft(url);
      reportedSuccessfully = true;
    } catch (error) {
      console.error(
        `[urlscan-hunter] Netcraft report failed for ${url}: ${error}`,
      );
    }

    // Log to urlscan_reports table
    await this.saveReport(
      uuid,
      url,
      confidenceScore,
      signals,
      reportedSuccessfully,
    );

    // Log to scam_reports for cross-module dedup
    if (reportedSuccessfully) {
      // not logging scam report here to prevent counting this
      // wait to separate these stats from the main hunter
      await this.incrementReportedCount();
      console.log(
        `[urlscan-hunter] Reported ${url} (confidence: ${(confidenceScore * 100).toFixed(1)}%)`,
      );
    }
  }

  /**
   * Downloads a screenshot PNG from urlscan.io.
   */
  private async downloadScreenshot(
    screenshotUrl: string,
  ): Promise<Buffer | null> {
    try {
      const response = await fetch(screenshotUrl);
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
    }
  }

  /**
   * Opens the URL in a fresh browser context with hunter proxy,
   * attaches signal listeners, takes a fresh screenshot, and collects signals.
   * Browser is created and destroyed per-call for reliability.
   */
  private async browserVerify(
    url: string,
  ): Promise<{ signals: DetectedSignals; screenshot: Buffer } | null> {
    let browser: Browser | null = null;

    try {
      browser = await BrowserManagerService.createBrowser(true);
      const signalService = createSignalService();

      const context = await browser.newContext({
        proxy: await parseProxy(true),
        viewport: null,
      });

      const page = await context.newPage();

      try {
        await spoofWindowsChrome(context, page);
        await blockGoogleAnalytics(page);
        await signalService.attachApiListeners(page);

        await page.goto(url, { timeout: 30000 });
        await simulateRandomMouseMovements(page);
        await page.waitForTimeout(5000);

        const screenshot = await page.screenshot();
        await signalService.detectAllSignals(page, url);

        return {
          signals: signalService.getSignals(),
          screenshot,
        };
      } finally {
        await page.close();
        await context.close();
      }
    } catch (error) {
      console.error(`[urlscan-hunter] Browser verify error: ${error}`);
      return null;
    } finally {
      await BrowserManagerService.closeBrowser(browser);
    }
  }

  // --- Database helpers ---

  private async isAlreadyProcessed(uuid: string): Promise<boolean> {
    const result = await pool.query(
      `SELECT 1 FROM urlscan_reports WHERE urlscan_uuid = $1 LIMIT 1`,
      [uuid],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async isAlreadyReported(url: string): Promise<boolean> {
    // Strip query params for fuzzy match
    let baseUrl: string;
    try {
      const parsed = new URL(url);
      baseUrl = `${parsed.origin}${parsed.pathname}`;
    } catch {
      baseUrl = url;
    }

    const result = await pool.query(
      `SELECT 1 FROM scam_reports WHERE regexp_replace(url, '\\?.*$', '') = $1 LIMIT 1`,
      [baseUrl],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async saveReport(
    uuid: string,
    url: string,
    confidence: number,
    signals: DetectedSignals,
    reportedToNetcraft: boolean,
  ): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO urlscan_reports (urlscan_uuid, url, classifier_confidence, signals, reported_to_netcraft)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (urlscan_uuid) DO NOTHING`,
        [uuid, url, confidence, JSON.stringify(signals), reportedToNetcraft],
      );
    } catch (error) {
      console.error(`[urlscan-hunter] Failed to save report: ${error}`);
    }
  }

  private async incrementScanCount(count: number): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO urlscan_scan_stats (date, urls_scanned)
         VALUES (CURRENT_DATE, $1)
         ON CONFLICT (date) DO UPDATE SET urls_scanned = urlscan_scan_stats.urls_scanned + $1`,
        [count],
      );
    } catch (error) {
      console.error(`[urlscan-hunter] Failed to update scan count: ${error}`);
    }
  }

  private async incrementClassifiedCount(): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO urlscan_scan_stats (date, urls_classified_scam)
         VALUES (CURRENT_DATE, 1)
         ON CONFLICT (date) DO UPDATE SET urls_classified_scam = urlscan_scan_stats.urls_classified_scam + 1`,
      );
    } catch (error) {
      console.error(
        `[urlscan-hunter] Failed to update classified count: ${error}`,
      );
    }
  }

  private async incrementReportedCount(): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO urlscan_scan_stats (date, urls_reported)
         VALUES (CURRENT_DATE, 1)
         ON CONFLICT (date) DO UPDATE SET urls_reported = urlscan_scan_stats.urls_reported + 1`,
      );
    } catch (error) {
      console.error(
        `[urlscan-hunter] Failed to update reported count: ${error}`,
      );
    }
  }

  /**
   * Tracks a UUID as processed, evicting old entries if cache is full.
   */
  private markProcessed(uuid: string): void {
    if (this.processedUuids.size >= UrlscanHunter.MAX_PROCESSED_CACHE) {
      // Evict oldest entries (Sets iterate in insertion order)
      const iterator = this.processedUuids.values();
      for (let i = 0; i < 10_000; i++) {
        const val = iterator.next().value;
        if (val !== undefined) {
          this.processedUuids.delete(val);
        }
      }
    }
    this.processedUuids.add(uuid);
  }
}

export const urlscanHunter = new UrlscanHunter();
