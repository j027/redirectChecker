import crypto from "crypto";
import { setTimeout as sleep } from "timers/promises";
import { Browser, Frame, Page } from "patchright";
import {
  blockGoogleAnalytics,
  parseProxy,
  redactIpAddressesFromPage,
  simulateRandomMouseMovements,
  spoofWindowsChrome,
  trackRedirectionPath,
} from "../utils/playwrightUtilities.js";
import { BrowserManagerService } from "./browserManagerService.js";
import { createSignalService, DetectedSignals, hasWeightedSignal } from "./signalService.js";
import { logHunterEvent } from "./hunterEventLogger.js";
import { aiClassifierService } from "./aiClassifierService.js";
import { CONFIDENCE_THRESHOLD, hunterService } from "./hunterService.js";
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
}

export const IZITO_TARGET: AdsenseTarget = {
  name: "izito",
  url: "https://www.izito.com/",
  filledSlotSelector: "div#slot-1[data-google-query-id]",
  consentSelector: "#cookie-consent__accept",
};

export type AdsenseHuntStatus = "no_fill" | "processed" | "skipped" | "failed";

export interface AdsenseHuntOptions {
  /** Detection only: no alerts, DB writes, or redirect checker additions. */
  dryRun?: boolean;
  target?: AdsenseTarget;
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

export interface AdsensePopupCapture {
  initialUrl: string;
  finalUrl: string;
  redirectionPath: string[];
  screenshot: Buffer;
  html: string;
  signals: DetectedSignals;
}

const AD_FILL_TIMEOUT_MS = 30_000;
const PAGE_LOAD_TIMEOUT_MS = 60_000;
const CONSENT_CLICK_TIMEOUT_MS = 5_000;
const POPUP_TIMEOUT_MS = 15_000;
const POPUP_DWELL_MS = 5_000;
const ELEMENT_CLICK_TIMEOUT_MS = 5_000;
/**
 * GPT sets data-google-query-id before the creative inside the safeframe is
 * interactive; clicking immediately hits an inert frame and no popup opens.
 */
const CREATIVE_SETTLE_MS = 3_000;
/** Time to wait for a popup after an element click before retrying by coordinates. */
const POPUP_AFTER_ELEMENT_CLICK_MS = 6_000;
const CLICKABLE_SELECTOR = 'a[href], button, [role="button"]';

const CTA_TEXT_PATTERN = /c[o0]ntinue|download|learn more|click here|visit/i;
const UTILITY_HREF_PATTERN =
  /adssettings\.google|google\.com\/settings\/ads|myadcenter|support\.google|\/privacy/i;
const MIN_CANDIDATE_AREA = 400;

export interface AdClickCandidate {
  text: string;
  href: string | null;
  area: number;
  hasImage: boolean;
  visible: boolean;
}

function isUtilityHref(href: string | null): boolean {
  return href != null && UTILITY_HREF_PATTERN.test(href);
}

/**
 * Picks the index of the element most likely to be the creative's call to
 * action: CTA text first, then image-bearing elements, then the largest
 * visible one. Utility links (AdChoices, ad settings, privacy) never win.
 */
export function rankAdCandidates(
  candidates: AdClickCandidate[],
): number | null {
  const eligible = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => candidate.visible)
    .filter(({ candidate }) => candidate.area >= MIN_CANDIDATE_AREA)
    .filter(({ candidate }) => !isUtilityHref(candidate.href));

  if (eligible.length === 0) {
    return null;
  }

  const ctaCandidates = eligible.filter(({ candidate }) =>
    CTA_TEXT_PATTERN.test(candidate.text),
  );
  const textPool = ctaCandidates.length > 0 ? ctaCandidates : eligible;

  const imageCandidates = textPool.filter(({ candidate }) => candidate.hasImage);
  const finalPool = imageCandidates.length > 0 ? imageCandidates : textPool;

  return finalPool.reduce((best, entry) =>
    entry.candidate.area > best.candidate.area ? entry : best,
  ).index;
}

async function collectClickCandidates(
  page: Page,
): Promise<{ frame: Frame; candidates: AdClickCandidate[] }[]> {
  const mainFrame = page.mainFrame();
  const result: { frame: Frame; candidates: AdClickCandidate[] }[] = [];

  for (const frame of page.frames()) {
    if (frame === mainFrame) {
      continue;
    }

    try {
      const candidates = await frame.evaluate((selector) => {
        return Array.from(document.querySelectorAll(selector)).map((element) => {
          const rect = element.getBoundingClientRect();
          const style = window.getComputedStyle(element);
          return {
            text: (element.textContent ?? "").trim().slice(0, 120),
            href: element.tagName === "A" ? (element as HTMLAnchorElement).href : null,
            area: rect.width * rect.height,
            hasImage: element.querySelector("img, svg, picture") != null,
            visible:
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              rect.width > 0 &&
              rect.height > 0,
          };
        });
      }, CLICKABLE_SELECTOR);
      result.push({ frame, candidates });
    } catch (error) {
      console.warn(`Failed to read click candidates from frame: ${error}`);
    }
  }

  return result;
}

async function clickBestCandidate(
  frames: { frame: Frame; candidates: AdClickCandidate[] }[],
): Promise<boolean> {
  const flat = frames.flatMap(({ frame, candidates }) =>
    candidates.map((candidate, localIndex) => ({
      ...candidate,
      frame,
      localIndex,
    })),
  );

  const bestIndex = rankAdCandidates(flat);
  if (bestIndex == null) {
    console.log(
      `No ad click candidate found in ${frames.length} frame(s); using slot center click`,
    );
    return false;
  }

  const best = flat[bestIndex];
  try {
    await best.frame
      .locator(CLICKABLE_SELECTOR)
      .nth(best.localIndex)
      .click({ timeout: ELEMENT_CLICK_TIMEOUT_MS });
    console.log(
      `Clicked ad candidate: text="${best.text}" href=${best.href ?? "none"}`,
    );
    return true;
  } catch (error) {
    console.warn(`Element click failed: ${error}`);
    return false;
  }
}

async function clickSlotCenter(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  await page.mouse.move(centerX, centerY, { steps: 5 });
  await page.waitForTimeout(500);
  await page.mouse.click(centerX, centerY);
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

/**
 * Clicks the filled GPT slot and captures the popup it opens. GPT creatives on
 * iZito open their landing page in a new tab; the popup is where the redirect
 * chain, screenshot, and signals are collected.
 */
export async function clickSlotAndCapturePopup(
  page: Page,
  slotSelector: string,
  dwellMs: number = POPUP_DWELL_MS,
  popupTimeoutMs: number = POPUP_TIMEOUT_MS,
): Promise<AdsensePopupCapture | null> {
  const slot = await page.$(slotSelector);
  const box = await slot?.boundingBox();
  if (box == null) {
    return null;
  }

  const popupPromise = page
    .context()
    .waitForEvent("page", { timeout: popupTimeoutMs })
    .catch(() => null);

  const frames = await collectClickCandidates(page);
  const clickedCandidate = await clickBestCandidate(frames);

  let popup: Page | null = null;
  if (clickedCandidate) {
    popup = await Promise.race([
      popupPromise,
      sleep(POPUP_AFTER_ELEMENT_CLICK_MS).then(() => null),
    ]);
  }

  if (popup == null) {
    // Creatives without a usable link (canvas, plain overlay) only respond to
    // a real pointer press inside the slot.
    await clickSlotCenter(page, box);
    popup = await popupPromise;
  }

  if (popup == null) {
    return null;
  }

  const initialUrl = popup.url();
  const redirectTracker = await trackRedirectionPath(popup, initialUrl);
  const signalService = createSignalService();

  try {
    await spoofWindowsChrome(popup.context(), popup);
    await blockGoogleAnalytics(popup);
    await signalService.attachApiListeners(popup);

    await popup.waitForLoadState("load").catch(() => undefined);
    await simulateRandomMouseMovements(popup);
    await popup.waitForTimeout(dwellMs);
    await redactIpAddressesFromPage(popup);

    const screenshot = await popup.screenshot();
    const html = await popup.content();
    const redirectionPath = redirectTracker.getPath();
    const finalUrl = redirectionPath[redirectionPath.length - 1] || popup.url();

    await signalService.detectAllSignals(popup, finalUrl);

    return {
      initialUrl,
      finalUrl,
      redirectionPath,
      screenshot,
      html,
      signals: signalService.getSignals(),
    };
  } catch (error) {
    console.warn(`Failed to capture ad popup: ${error}`);
    return null;
  } finally {
    await popup.close().catch(() => undefined);
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

  async huntAdsenseAds(options: AdsenseHuntOptions = {}) {
    return this.huntAdsenseAdsInternal(options);
  }

  private async huntAdsenseAdsInternal(
    options: AdsenseHuntOptions,
  ): Promise<AdsenseHuntResult> {
    const target = options.target ?? IZITO_TARGET;
    const dryRun = options.dryRun ?? false;

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
        waitUntil: "load",
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

      await page.waitForTimeout(CREATIVE_SETTLE_MS);

      const capture = await clickSlotAndCapturePopup(
        page,
        target.filledSlotSelector,
      );
      if (capture == null) {
        console.log(`Adsense hunter: filled slot opened no popup on ${target.name}`);
        await logHunterEvent("adsense", "ad_skipped", "no popup opened", {
          target: target.name,
        });
        return { status: "skipped", target: target.name, reason: "no popup opened" };
      }

      console.log(
        `Adsense hunter captured popup (dryRun=${dryRun}): ${capture.initialUrl} -> ${capture.finalUrl}`,
      );
      await logHunterEvent("adsense", "ads_found", `Captured ad popup`, {
        target: target.name,
        initial_url: capture.initialUrl,
        final_url: capture.finalUrl,
        redirection_path: capture.redirectionPath,
      });

      if (dryRun) {
        const verdict = await this.classifyCapture(capture);
        if (verdict == null) {
          return {
            status: "skipped",
            target: target.name,
            initialUrl: capture.initialUrl,
            finalUrl: capture.finalUrl,
            reason: "whitelisted",
          };
        }

        console.log(
          `Adsense dry-run verdict: ${verdict.isScam ? "SCAM" : "clean"} (raw ${verdict.rawIsScam ? "scam" : "clean"}, confidence ${verdict.confidenceScore.toFixed(2)})`,
        );
        return {
          status: "processed",
          target: target.name,
          initialUrl: capture.initialUrl,
          finalUrl: capture.finalUrl,
          redirectionPath: capture.redirectionPath,
          isScam: verdict.isScam,
          confidenceScore: verdict.confidenceScore,
        };
      }

      return this.processCapturedAd(target, capture);
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

  private async classifyCapture(capture: AdsensePopupCapture): Promise<{
    rawIsScam: boolean;
    confidenceScore: number;
    hasSignal: boolean;
    isScam: boolean;
  } | null> {
    if (aiClassifierService.isWhitelisted(capture.finalUrl)) {
      return null;
    }

    const { isScam: rawIsScam, confidenceScore } = await aiClassifierService.runInference(
      capture.screenshot,
    );
    const hasSignal = hasWeightedSignal(capture.signals);
    const isScam = rawIsScam && confidenceScore >= CONFIDENCE_THRESHOLD && hasSignal;

    return { rawIsScam, confidenceScore, hasSignal, isScam };
  }

  private async processCapturedAd(
    target: AdsenseTarget,
    capture: AdsensePopupCapture,
  ): Promise<AdsenseHuntResult> {
    const { initialUrl, finalUrl, redirectionPath, screenshot, html, signals } = capture;

    const verdict = await this.classifyCapture(capture);
    if (verdict == null) {
      console.log(`✅ Whitelisted domain detected: ${finalUrl} - Skipping adsense processing`);
      await logHunterEvent("adsense", "whitelisted", `Whitelisted: ${finalUrl}`, {
        target: target.name,
        final_url: finalUrl,
      });
      return { status: "skipped", target: target.name, initialUrl, finalUrl, reason: "whitelisted" };
    }

    const { rawIsScam, confidenceScore, hasSignal, isScam } = verdict;

    await logHunterEvent("adsense", "classification", `Classified ${finalUrl}`, {
      target: target.name,
      initial_url: initialUrl,
      final_url: finalUrl,
      classifier_is_scam: rawIsScam,
      confidence: confidenceScore,
      has_signal: hasSignal,
      effective_is_scam: isScam,
      redirect_hops: redirectionPath.length,
    });

    await aiClassifierService.saveData(finalUrl, screenshot, html, rawIsScam, confidenceScore);

    let isNewDestination = false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const existingDestId = await hunterService.findExistingDestination(
        finalUrl,
        "adsense",
        client,
      );
      isNewDestination = existingDestId === null;

      if (isNewDestination) {
        const adId = crypto.randomUUID();
        await client.query(
          `INSERT INTO ads
           (id, ad_type, initial_url, final_url, redirect_path, classifier_is_scam, confidence_score, is_scam,
            signal_fullscreen, signal_keyboard_lock, signal_pointer_lock, signal_third_party_hosting, signal_ip_address, signal_page_frozen, signal_worker_bomb)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            adId,
            "adsense",
            initialUrl,
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

        console.log(`New adsense record: ${initialUrl} -> ${finalUrl}`);
        await logHunterEvent("adsense", "ad_processed", `New ad: ${isScam ? "SCAM" : "clean"}`, {
          target: target.name,
          ad_id: adId,
          initial_url: initialUrl,
          final_url: finalUrl,
          is_scam: isScam,
          confidence: confidenceScore,
        });
      } else {
        await client.query(
          `UPDATE ads SET last_seen = CURRENT_TIMESTAMP WHERE id = $1`,
          [existingDestId],
        );
        console.log(`Updated last_seen for existing destination: ${finalUrl}`);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`Adsense database error: ${error}`);
      await logHunterEvent("adsense", "error", `Database error: ${error}`, {
        target: target.name,
      });
      return {
        status: "failed",
        target: target.name,
        initialUrl,
        finalUrl,
        reason: String(error),
      };
    } finally {
      client.release();
    }

    // Alerting and adding happen outside the transaction: adding involves
    // browser work that can take minutes and must not hold database locks.
    if (isScam) {
      const cloakerCandidate = hunterService.findCloakerCandidate(redirectionPath, finalUrl);

      if (isNewDestination) {
        await logHunterEvent("adsense", "scam_detected", `New scam: ${finalUrl}`, {
          target: target.name,
          initial_url: initialUrl,
          final_url: finalUrl,
          confidence: confidenceScore,
          cloaker: cloakerCandidate,
        });
        await sendAlert({
          type: "adsense",
          initialUrl,
          finalUrl,
          isNew: true,
          confidenceScore,
          redirectionPath,
          cloakerCandidate,
        });
      }

      if (cloakerCandidate != null) {
        const { attempted, added, strategy } = await trySightingAdd(cloakerCandidate);
        if (added) {
          await sendCloakerAddedAlert(cloakerCandidate, "AdSense", strategy);
          await logHunterEvent(
            "adsense",
            "added_to_checker",
            `Added ${cloakerCandidate} to redirect checker`,
            { target: target.name, url: cloakerCandidate },
          );
          console.log(`Auto-add to redirect checker for scam: Success`);
        } else if (attempted) {
          console.log(
            `Auto-add to redirect checker failed, will retry on a later sighting`,
          );
        }
      }
    }

    return { status: "processed", target: target.name, initialUrl, finalUrl, redirectionPath };
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
