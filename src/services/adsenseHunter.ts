import crypto from "crypto";
import { Browser, Frame, Page } from "patchright";
import {
  blockGoogleAnalytics,
  parseProxy,
  spoofWindowsChrome,
} from "../utils/playwrightUtilities.js";
import {
  canonicalizeAdDestinationForDedupe,
  extractAdDestinationUrl,
} from "../utils/urlUtils.js";
import { BrowserManagerService } from "./browserManagerService.js";
import { decideScam } from "./scamDecision.js";
import { logHunterEvent } from "./hunterEventLogger.js";
import { aiClassifierService } from "./aiClassifierService.js";
import {
  hunterService,
  ProcessAdResult,
} from "./hunterService.js";
import { sendAlert, sendCloakerAddedAlert } from "./alertService.js";
import { trySightingAdd } from "./redirectAddService.js";
import pool from "../dbPool.js";

export interface AdsenseTarget {
  name: string;
  url: string;
  /** Present with a data-google-query-id attribute only once GPT filled the slot. */
  filledSlotSelector: string;
  /** Consent control to dismiss before waiting for fill, when the target shows one. */
  consentSelector?: string;
  /**
   * Selector for the ad iframes to inspect. When present, only these frames
   * and their descendants are scanned; the rest of the page is usually a
   * forest of cookie-sync/tracking frames.
   */
  adFrameSelector?: string;
  /** Navigation wait strategy. Defaults to "load" for older targets. */
  waitUntil?: "load" | "domcontentloaded";
  /** Extra time after a slot fills so sibling slots can fill too. */
  postFillSettleMs?: number;
}

export const IZITO_TARGET: AdsenseTarget = {
  name: "izito",
  url: "https://www.izito.com/",
  filledSlotSelector: "div#slot-1[data-google-query-id]",
  consentSelector: "#cookie-consent__accept",
};

/**
 * 123greetings uses Google Ad Manager slots with AdPushup header bidding.
 * The GPT slot divs receive data-google-query-id when filled, and the
 * creatives expose Google click URLs with the landing page in `adurl`.
 */
export const GREETINGS_123_TARGET: AdsenseTarget = {
  name: "123greetings",
  url: "https://www.123greetings.com/",
  filledSlotSelector: [
    "div#div-gpt-mrec1[data-google-query-id]",
    "div#div-gpt-mrec2[data-google-query-id]",
    "div#div-gpt-topbanner[data-google-query-id]",
    'iframe[name*="/Anchor_"][data-load-complete="true"]',
  ].join(", "),
  adFrameSelector: [
    'div[id^="div-gpt"] iframe',
    'iframe[name^="google_ads_iframe_"]',
    'iframe[id^="google_ads_iframe_"]',
  ].join(", "),
  waitUntil: "domcontentloaded",
  postFillSettleMs: 1_500,
};

/** Default target used by the scheduled hunter. */
export const DEFAULT_ADSENSE_TARGET = GREETINGS_123_TARGET;

export type AdsenseHuntStatus = "no_fill" | "processed" | "skipped" | "failed";

export interface AdsenseHuntOptions {
  target?: AdsenseTarget;
  /** Classify and log only; skip database writes, alerts, and redirect adds. */
  dryRun?: boolean;
}

export interface AdsenseHuntResult {
  status: AdsenseHuntStatus;
  target: string;
  initialUrl?: string;
  finalUrl?: string;
  redirectionPath?: string[];
  isScam?: boolean;
  confidenceScore?: number;
  reason?: string;
}

export interface ExtractedAdLink {
  url: string;
  source: "adurl" | "ds_dest_url" | "maxdest" | "redir" | "raw";
  text: string;
}

export interface AdClickCandidate {
  text: string;
  href: string | null;
  area: number;
  hasImage: boolean;
  visible: boolean;
}

const AD_FILL_TIMEOUT_MS = 20_000;
const PAGE_LOAD_TIMEOUT_MS = 30_000;
const CONSENT_CLICK_TIMEOUT_MS = 5_000;
const MAX_ADS_PER_CYCLE = 1;
/** Navigation + classification budget for one hunt, under the scheduler's 150s cap. */
const CYCLE_BUDGET_MS = 60_000;
const ANCHOR_SELECTOR = "a[href]";

const CTA_TEXT_PATTERN = /c[o0]ntinue|download|learn more|click here|visit/i;
const UTILITY_HREF_PATTERN =
  /adssettings\.google|google\.com\/settings\/ads|myadcenter|support\.google|\/privacy/i;
const MIN_CANDIDATE_AREA = 400;

function isUtilityHref(href: string | null): boolean {
  return href != null && UTILITY_HREF_PATTERN.test(href);
}

/**
 * Orders eligible creative anchors most-likely-to-be-a-link first: CTA text,
 * then image-bearing, then largest. Utility links (AdChoices, ad settings,
 * privacy) are excluded so they are never extracted as destinations.
 */
export function rankAdCandidatesOrdered(
  candidates: AdClickCandidate[],
): number[] {
  const eligible = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.visible)
    .filter(({ candidate }) => candidate.area >= MIN_CANDIDATE_AREA)
    .filter(({ candidate }) => !isUtilityHref(candidate.href));

  eligible.sort((a, b) => {
    const ctaA = CTA_TEXT_PATTERN.test(a.candidate.text) ? 1 : 0;
    const ctaB = CTA_TEXT_PATTERN.test(b.candidate.text) ? 1 : 0;
    if (ctaA !== ctaB) return ctaB - ctaA;

    const imageA = a.candidate.hasImage ? 1 : 0;
    const imageB = b.candidate.hasImage ? 1 : 0;
    if (imageA !== imageB) return imageB - imageA;

    return b.candidate.area - a.candidate.area;
  });

  return eligible.map(({ index }) => index);
}

/**
 * Picks the index of the element most likely to be the creative's call to
 * action. Kept for ranking unit coverage; extraction uses the ordered list.
 */
export function rankAdCandidates(candidates: AdClickCandidate[]): number | null {
  const ordered = rankAdCandidatesOrdered(candidates);
  return ordered.length > 0 ? ordered[0] : null;
}

/**
 * Returns the visible area of a frame. Some creatives (notably 123greetings'
 * bottom anchor and side rails) have anchors with a 0x0 rect even though the
 * containing iframe is visible, so the frame area is the useful fallback.
 */
async function getFrameArea(frame: Frame): Promise<number> {
  try {
    const element = await frame.frameElement();
    const box = await element.boundingBox();
    if (box != null && box.width > 0 && box.height > 0) {
      return box.width * box.height;
    }
  } catch {
    // Frame element can disappear while the page is refreshing its ads.
  }

  try {
    const viewport = await frame.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    return Math.max(0, viewport.width * viewport.height);
  } catch {
    return 0;
  }
}

/**
 * Collects the ad-slot frames to scan. When a target supplies an ad-frame
 * selector, only those frames and their descendants are used; scanning every
 * frame on an ad-heavy page mostly finds cookie-sync and tracking iframes.
 */
async function collectAdFrames(
  page: Page,
  target?: AdsenseTarget,
): Promise<Frame[]> {
  const mainFrame = page.mainFrame();
  const roots: Frame[] = [];

  if (target?.adFrameSelector != null) {
    const handles = await page.$$(target.adFrameSelector);
    for (const handle of handles) {
      try {
        const frame = await handle.contentFrame();
        if (frame != null) {
          roots.push(frame);
        }
      } catch {
        // The iframe may be detached while the ad slot refreshes.
      }
    }
  }

  if (roots.length === 0) {
    return page.frames().filter((frame) => frame !== mainFrame);
  }

  const seen = new Set<Frame>();
  const frames: Frame[] = [];
  const walk = (frame: Frame) => {
    if (frame === mainFrame || seen.has(frame)) {
      return;
    }
    seen.add(frame);
    frames.push(frame);
    for (const child of frame.childFrames()) {
      walk(child);
    }
  };

  for (const root of roots) {
    walk(root);
  }

  return frames;
}

async function collectAdCandidates(
  page: Page,
  target?: AdsenseTarget,
): Promise<AdClickCandidate[]> {
  const candidates: AdClickCandidate[] = [];
  const frames = await collectAdFrames(page, target);

  for (const frame of frames) {
    const frameArea = await getFrameArea(frame);
    if (frameArea <= 0) {
      continue;
    }

    try {
      const frameCandidates = await frame.evaluate((selector) => {
        return Array.from(document.querySelectorAll(selector)).map((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return {
            text: (element.textContent ?? "").trim().slice(0, 120),
            href: (element as HTMLAnchorElement).href,
            area: rect.width * rect.height,
            hasImage: element.querySelector("img, svg, picture") != null,
            visible:
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              style.opacity !== "0",
          };
        });
      }, ANCHOR_SELECTOR);

      for (const candidate of frameCandidates) {
        candidates.push({
          ...candidate,
          // A 0x0 anchor inside a visible ad iframe is still a real ad link.
          area: candidate.area > 0 ? candidate.area : frameArea,
        });
      }
    } catch (error) {
      console.warn(`Failed to read ad candidates from frame: ${error}`);
    }
  }

  return candidates;
}

/**
 * Extracts the destinations advertised in the creative frames, ranked best
 * first and deduplicated by a stable destination key. No clicking: the anchor
 * href is the exact URL the browser would have opened.
 */
export async function extractAdLinks(
  page: Page,
  target?: AdsenseTarget,
): Promise<ExtractedAdLink[]> {
  const candidates = await collectAdCandidates(page, target);
  const ordered = rankAdCandidatesOrdered(candidates);
  const links: ExtractedAdLink[] = [];
  const seen = new Set<string>();

  for (const index of ordered) {
    const { href, text } = candidates[index];
    if (href == null) {
      continue;
    }

    const extracted = extractAdDestinationUrl(href, {
      fallbackToRawHref: true,
      stripTrackingParams: true,
    });
    if (extracted == null) {
      continue;
    }

    const dedupeKey = canonicalizeAdDestinationForDedupe(extracted.url);
    if (seen.has(dedupeKey)) {
      continue;
    }

    seen.add(dedupeKey);
    links.push({ url: extracted.url, source: extracted.source, text });
  }

  // Prefer destinations we could unwrap; raw tracker URLs are the fallback.
  const sourcePriority: Record<ExtractedAdLink["source"], number> = {
    adurl: 0,
    ds_dest_url: 0,
    maxdest: 0,
    redir: 0,
    raw: 1,
  };
  links.sort((a, b) => sourcePriority[a.source] - sourcePriority[b.source]);

  return links;
}

export async function isSlotFilled(
  page: Page,
  target: AdsenseTarget,
): Promise<boolean> {
  return (await page.$(target.filledSlotSelector)) != null;
}

export async function waitForSlotFill(
  page: Page,
  target: AdsenseTarget,
  timeoutMs: number = AD_FILL_TIMEOUT_MS,
): Promise<boolean> {
  try {
    await page.waitForSelector(target.filledSlotSelector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export class AdsenseHunter {
  private browser: Browser | null = null;
  private browserInitializing: boolean = false;

  async init(): Promise<void> {
    await this.ensureBrowserIsHealthy();
  }

  async restartBrowser(): Promise<void> {
    console.log("Restarting AdsenseHunter browser...");
    try {
      this.browserInitializing = true;
      this.browser = await BrowserManagerService.forceRestartBrowser(
        this.browser,
        false,
      );
    } finally {
      this.browserInitializing = false;
    }
  }

  private async ensureBrowserIsHealthy(): Promise<void> {
    await BrowserManagerService.ensureBrowserHealth(
      this.browser,
      this.browserInitializing,
      async () => {
        try {
          this.browserInitializing = true;
          await BrowserManagerService.closeBrowser(this.browser);
          this.browser = await BrowserManagerService.createBrowser(false);
          console.log("AdsenseHunter initialized new browser");
        } finally {
          this.browserInitializing = false;
        }
      },
    );
  }

  async close(): Promise<void> {
    await BrowserManagerService.closeBrowser(this.browser);
    this.browser = null;
  }

  async cancel(): Promise<void> {
    console.warn("Cancelling AdsenseHunter browser...");
    await BrowserManagerService.cancelBrowser(this.browser, "AdsenseHunter");
    this.browser = null;
  }

  async huntAdsenseAds(options: AdsenseHuntOptions = {}) {
    return this.huntAdsenseAdsInternal(options);
  }

  private async huntAdsenseAdsInternal(
    options: AdsenseHuntOptions,
  ): Promise<AdsenseHuntResult> {
    const target = options.target ?? DEFAULT_ADSENSE_TARGET;

    await this.ensureBrowserIsHealthy();

    if (this.browser == null || !this.browser.isConnected()) {
      console.error("Browser has not been initialized or crashed - adsense hunter failed");
      await logHunterEvent("adsense", "error", "Browser not initialized or crashed");
      return { status: "failed", target: target.name, reason: "browser unavailable" };
    }

    const context = await this.browser.newContext({
      proxy: await parseProxy("hunter"),
      viewport: null,
    });
    const page = await context.newPage();

    try {
      await spoofWindowsChrome(context, page);
      await blockGoogleAnalytics(page);

      console.log(`Adsense hunter visiting ${target.url}`);
      await logHunterEvent("adsense", "cycle_start", `Visiting ${target.name}`, {
        target: target.name,
        url: target.url,
      });

      await page.goto(target.url, {
        waitUntil: target.waitUntil ?? "load",
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });
      await this.acceptConsent(page, target);

      if (!(await waitForSlotFill(page, target))) {
        console.log(`Adsense hunter: no fill on ${target.name}`);
        await logHunterEvent("adsense", "ad_skipped", "no_fill", {
          target: target.name,
        });
        return { status: "no_fill", target: target.name };
      }

      // Let the other slots on the page fill after the first one appears.
      await page.waitForTimeout(target.postFillSettleMs ?? 3_000);

      const links = await extractAdLinks(page, target);
      console.log(
        `Adsense hunter extracted ${links.length} ad link(s) from ${target.name}`,
      );
      await logHunterEvent("adsense", "ads_found", `Extracted ${links.length} ad link(s)`, {
        target: target.name,
        count: links.length,
        urls: links.slice(0, MAX_ADS_PER_CYCLE).map((link) => link.url),
      });

      if (links.length === 0) {
        await logHunterEvent("adsense", "ad_skipped", "no ad links extracted", {
          target: target.name,
        });
        return { status: "skipped", target: target.name, reason: "no ad links extracted" };
      }

      const deadline = Date.now() + CYCLE_BUDGET_MS;
      let lastResult: AdsenseHuntResult | null = null;

      for (const link of links.slice(0, MAX_ADS_PER_CYCLE)) {
        if (Date.now() >= deadline) {
          await logHunterEvent("adsense", "ad_skipped", "cycle budget exhausted", {
            target: target.name,
            url: link.url,
          });
          break;
        }

        await logHunterEvent("adsense", "link_extracted", "Extracted ad link", {
          target: target.name,
          source: link.source,
          url: link.url,
          text: link.text,
        });

        if (await this.isKnownScamAd(link.url)) {
          console.log(`Skipping already known scam ad: ${link.url}`);
          await logHunterEvent("adsense", "ad_skipped", "known scam", {
            target: target.name,
            url: link.url,
          });
          continue;
        }

        const result = await hunterService.processAd(link.url, target.url);
        if (result == null) {
          console.log(`Adsense hunter failed to process ${link.url}`);
          await logHunterEvent("adsense", "ad_skipped", "navigation failed", {
            target: target.name,
            url: link.url,
          });
          continue;
        }

        lastResult = await this.processAdResult(
          target,
          link.url,
          result,
          options.dryRun ?? false,
        );
      }

      return (
        lastResult ?? {
          status: "skipped",
          target: target.name,
          reason: "no ads processed",
        }
      );
    } catch (error) {
      console.error(`Adsense hunter error: ${error}`);
      await logHunterEvent("adsense", "error", `Hunt failed: ${error}`, {
        target: target.name,
      });
      return { status: "failed", target: target.name, reason: String(error) };
    } finally {
      await page.close();
      await context.close();
    }
  }

  private async processAdResult(
    target: AdsenseTarget,
    adUrl: string,
    result: ProcessAdResult,
    dryRun: boolean,
  ): Promise<AdsenseHuntResult> {
    const { screenshot, html, redirectionPath, signals } = result;
    const finalUrl = redirectionPath[redirectionPath.length - 1] || adUrl;

    if (aiClassifierService.isWhitelisted(finalUrl)) {
      console.log(`✅ Whitelisted domain detected: ${finalUrl} - Skipping adsense processing`);
      await logHunterEvent("adsense", "whitelisted", `Whitelisted: ${finalUrl}`, {
        target: target.name,
        url: adUrl,
        final_url: finalUrl,
      });
      return { status: "skipped", target: target.name, initialUrl: adUrl, finalUrl, reason: "whitelisted" };
    }

    const { isScam: rawIsScam, confidenceScore } = await aiClassifierService.runInference(screenshot);
    const decision = decideScam(rawIsScam, confidenceScore, signals);
    const isScam = decision.isScam;

    await logHunterEvent("adsense", "classification", `Classified ${finalUrl}`, {
      target: target.name,
      url: adUrl,
      final_url: finalUrl,
      classifier_is_scam: rawIsScam,
      confidence: confidenceScore,
      has_signal: decision.hasSignal,
      has_strong_signals: decision.hasStrongSignals,
      active_signal_count: decision.activeSignalCount,
      decision_reason: decision.reason,
      effective_is_scam: isScam,
      redirect_hops: redirectionPath.length,
    });

    if (dryRun) {
      console.log(
        `[adsense dry-run] ${adUrl} -> ${finalUrl} ` +
          `(isScam=${isScam}, confidence=${confidenceScore.toFixed(3)}, ` +
          `signals=${decision.hasSignal}, reason=${decision.reason ?? "none"})`,
      );
      return {
        status: "processed",
        target: target.name,
        initialUrl: adUrl,
        finalUrl,
        redirectionPath,
        isScam,
        confidenceScore,
        reason: "dry run",
      };
    }

    await aiClassifierService.saveData(finalUrl, screenshot, html, rawIsScam, confidenceScore);

    let isNewDestination = false;
    let isStatusChange = false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const canonicalAdUrl = canonicalizeAdDestinationForDedupe(adUrl);
      const existingResult = await client.query(
        `SELECT id, is_scam
         FROM ads
         WHERE ad_type = 'adsense'
           AND (
             initial_url = $1
             OR regexp_replace(initial_url, '\\?.*$', '')
                = regexp_replace($1, '\\?.*$', '')
           )
         ORDER BY last_seen DESC
         LIMIT 1`,
        [canonicalAdUrl],
      );
      const existingAd = existingResult.rows[0];

      if (existingAd) {
        await client.query(
          `UPDATE ads SET
             last_seen = CURRENT_TIMESTAMP,
             last_updated = CURRENT_TIMESTAMP,
             final_url = $1,
             redirect_path = $2,
             classifier_is_scam = $3,
             confidence_score = $4,
             signal_fullscreen = $5,
             signal_keyboard_lock = $6,
             signal_pointer_lock = $7,
             signal_third_party_hosting = $8,
             signal_ip_address = $9,
             signal_page_frozen = $10,
             signal_worker_bomb = $11
           WHERE id = $12`,
          [
            finalUrl,
            hunterService.pgArray(redirectionPath),
            rawIsScam,
            confidenceScore,
            signals.fullscreenRequested,
            signals.keyboardLockRequested,
            signals.pointerLockRequested,
            signals.isThirdPartyHosting,
            signals.isIpAddress,
            signals.pageLoadFrozen,
            signals.workerBombDetected,
            existingAd.id,
          ],
        );

        if (existingAd.is_scam !== isScam) {
          isStatusChange = true;
          await client.query(`UPDATE ads SET is_scam = $1 WHERE id = $2`, [
            isScam,
            existingAd.id,
          ]);

          const reason = isScam
            ? `Changed to scam with confidence ${(confidenceScore * 100).toFixed(1)}%`
            : `No longer classified as scam (confidence: ${(confidenceScore * 100).toFixed(1)}%)`;

          await client.query(
            `INSERT INTO ad_status_history
               (ad_id, previous_status, new_status, classifier_is_scam, confidence_score, reason)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [existingAd.id, existingAd.is_scam, isScam, rawIsScam, confidenceScore, reason],
          );
        }

        console.log(`Updated existing adsense ad: ${existingAd.id}`);
      } else {
        isNewDestination = true;
        const adId = crypto.randomUUID();
        await client.query(
          `INSERT INTO ads
           (id, ad_type, initial_url, final_url, redirect_path, classifier_is_scam, confidence_score, is_scam,
            signal_fullscreen, signal_keyboard_lock, signal_pointer_lock, signal_third_party_hosting, signal_ip_address, signal_page_frozen, signal_worker_bomb)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            adId,
            "adsense",
            adUrl,
            finalUrl,
            hunterService.pgArray(redirectionPath),
            rawIsScam,
            confidenceScore,
            isScam,
            signals.fullscreenRequested,
            signals.keyboardLockRequested,
            signals.pointerLockRequested,
            signals.isThirdPartyHosting,
            signals.isIpAddress,
            signals.pageLoadFrozen,
            signals.workerBombDetected,
          ],
        );

        console.log(`New adsense record: ${adUrl} -> ${finalUrl}`);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`Adsense database error: ${error}`);
      await logHunterEvent("adsense", "error", `Database error: ${error}`, {
        target: target.name,
        url: adUrl,
      });
      return {
        status: "failed",
        target: target.name,
        initialUrl: adUrl,
        finalUrl,
        reason: String(error),
      };
    } finally {
      client.release();
    }

    if (isNewDestination) {
      await logHunterEvent("adsense", "ad_processed", `New ad: ${isScam ? "SCAM" : "clean"}`, {
        target: target.name,
        url: adUrl,
        final_url: finalUrl,
        is_scam: isScam,
        confidence: confidenceScore,
      });
    }

    if (isStatusChange) {
      await logHunterEvent("adsense", "status_changed", `Status changed to ${isScam}`, {
        target: target.name,
        url: adUrl,
        final_url: finalUrl,
        confidence: confidenceScore,
      });
    }

    // Alerting and adding happen outside the transaction: adding involves
    // browser work that can take minutes and must not hold database locks.
    if (isScam) {
      const cloakerCandidate = hunterService.findCloakerCandidate(redirectionPath, finalUrl);

      if (isNewDestination) {
        await logHunterEvent("adsense", "scam_detected", `New scam: ${finalUrl}`, {
          target: target.name,
          url: adUrl,
          final_url: finalUrl,
          confidence: confidenceScore,
          cloaker: cloakerCandidate,
        });
        await sendAlert({
          type: "adsense",
          initialUrl: adUrl,
          finalUrl,
          isNew: true,
          confidenceScore,
          redirectionPath,
          cloakerCandidate,
          decisionReason: decision.reason,
        });
      } else if (isStatusChange) {
        await sendAlert({
          type: "adsense",
          initialUrl: adUrl,
          finalUrl,
          isNew: false,
          confidenceScore,
          redirectionPath,
          cloakerCandidate,
          decisionReason: decision.reason,
        });
      }

      if (cloakerCandidate != null) {
        const { attempted, added, strategy } = await trySightingAdd(cloakerCandidate);
        if (added) {
          await sendCloakerAddedAlert(cloakerCandidate, "AdSense", strategy);
          await logHunterEvent("adsense", "added_to_checker", `Added ${cloakerCandidate} to redirect checker`, {
            target: target.name,
            url: cloakerCandidate,
          });
          console.log(`Auto-add to redirect checker for scam: Success`);
        } else if (attempted) {
          console.log(
            `Auto-add to redirect checker failed, will retry on a later sighting`,
          );
        }
      }
    }

    return { status: "processed", target: target.name, initialUrl: adUrl, finalUrl, redirectionPath };
  }

  /**
   * Returns true when this destination was already confirmed as a scam.
   * The query-stripped fallback matches rows written before rotating click
   * identifiers were removed from the dedupe key.
   */
  private async isKnownScamAd(adUrl: string): Promise<boolean> {
    const canonicalAdUrl = canonicalizeAdDestinationForDedupe(adUrl);
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id
         FROM ads
         WHERE ad_type = 'adsense'
           AND is_scam = true
           AND (
             initial_url = $1
             OR regexp_replace(initial_url, '\\?.*$', '')
                = regexp_replace($1, '\\?.*$', '')
           )
         ORDER BY last_seen DESC
         LIMIT 1`,
        [canonicalAdUrl],
      );
      if (result.rowCount === 0) {
        return false;
      }

      await client.query(`UPDATE ads SET last_seen = CURRENT_TIMESTAMP WHERE id = $1`, [
        result.rows[0].id,
      ]);
      return true;
    } finally {
      client.release();
    }
  }

  private async acceptConsent(page: Page, target: AdsenseTarget): Promise<void> {
    if (target.consentSelector == null) {
      return;
    }

    try {
      await page.click(target.consentSelector, { timeout: CONSENT_CLICK_TIMEOUT_MS });
      console.log(`Adsense hunter dismissed consent on ${target.name}`);
    } catch {
      // No consent banner on this visit.
    }
  }
}

export const adsenseHunter = new AdsenseHunter();
