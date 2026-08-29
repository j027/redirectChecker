import { fetch, ProxyAgent } from "undici";
import { readConfig } from "../config.js";
import { aiClassifierService } from "./aiClassifierService.js";
import { reportToNetcraft } from "./reportService.js";
import { CONFIDENCE_THRESHOLD } from "./hunterService.js";
import { DetectedSignals, hasWeightedSignal } from "./signalService.js";
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
    const { hunterProxy } = await readConfig();
    const proxyAgent = new ProxyAgent(hunterProxy);

    const response = await fetch("https://urlscan.io/json/live/", {
      headers: { Accept: "application/json" },
      dispatcher: proxyAgent,
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
   * 2. Download & classify screenshot (quick pre-filter)
   * 3. If high confidence → browser verify + signal check
   * 4. If confirmed scam with signals → report to Netcraft
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

    // --- Stage 1: Download screenshot & quick classify (pre-filter) ---
    const screenshotBuffer = await this.downloadScreenshot(result.screenshot);
    if (!screenshotBuffer) return;

    const quickClassification =
      await aiClassifierService.runInference(screenshotBuffer);
    if (!quickClassification.isScam || quickClassification.confidenceScore < CONFIDENCE_THRESHOLD) return;

    // Quick filter says scam — increment classified stat
    await this.incrementClassifiedCount();

    // --- Stage 2: Browser verification + signal collection ---
    const verification = await aiClassifierService.classifyUrl(url);
    if (!verification) {
      // Browser verification failed — log but don't report
      await this.saveReport(uuid, url, quickClassification.confidenceScore, false, false);
      return;
    }

    const { isScam, confidenceScore, signals } = verification;

    // disable signals that have too many false positives for this hunter
    signals.isThirdPartyHosting = false;
    signals.workerBombDetected = false;
    signals.isIpAddress = false;
    const passesSignalCheck = hasWeightedSignal(signals);

    if (!isScam || confidenceScore < CONFIDENCE_THRESHOLD || !passesSignalCheck) {
      // Browser verification didn't confirm — log result but don't report
      await this.saveReport(uuid, url, confidenceScore, false, isScam, passesSignalCheck, signals);
      console.log(
        `[urlscan-hunter] Skipped ${url} — isScam=${isScam}, confidence=${(confidenceScore * 100).toFixed(1)}%, hasSignal=${passesSignalCheck}`,
      );
      return;
    }

    // --- Stage 3: Report to Netcraft ---
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
      reportedSuccessfully,
      isScam,
      passesSignalCheck,
      signals,
    );

    if (reportedSuccessfully) {
      await this.incrementReportedCount();
      console.log(
        `[urlscan-hunter] Reported ${url} (confidence: ${(confidenceScore * 100).toFixed(1)}%, signals: ${JSON.stringify(signals)})`,
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
      const { hunterProxy } = await readConfig();
      const proxyAgent = new ProxyAgent(hunterProxy);

      const response = await fetch(screenshotUrl, { dispatcher: proxyAgent });
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    } catch {
      return null;
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
    reportedToNetcraft: boolean,
    classifierIsScam?: boolean,
    hasSignal?: boolean,
    signals?: DetectedSignals,
  ): Promise<void> {
    try {
      await pool.query(
        `INSERT INTO urlscan_reports (
           urlscan_uuid, url, classifier_confidence, reported_to_netcraft,
           classifier_is_scam, has_weighted_signal,
           signal_fullscreen, signal_keyboard_lock, signal_pointer_lock,
           signal_third_party_hosting, signal_ip_address, signal_page_frozen, signal_worker_bomb
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (urlscan_uuid) DO NOTHING`,
        [
          uuid, url, confidence, reportedToNetcraft,
          classifierIsScam ?? null, hasSignal ?? null,
          signals?.fullscreenRequested ?? false,
          signals?.keyboardLockRequested ?? false,
          signals?.pointerLockRequested ?? false,
          signals?.isThirdPartyHosting ?? false,
          signals?.isIpAddress ?? false,
          signals?.pageLoadFrozen ?? false,
          signals?.workerBombDetected ?? false,
        ],
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
