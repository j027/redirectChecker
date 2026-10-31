import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import { Browser, BrowserContext, Locator, Page, Response } from "patchright";
import {
  blockGoogleAnalytics,
  parseProxy,
  spoofWindowsChrome,
} from "../utils/playwrightUtilities.js";
import {
  extractAdDestinationUrl,
  unwrapYahooClickUrl,
} from "../utils/urlUtils.js";
import { BrowserManagerService } from "./browserManagerService.js";
import { hasWeightedSignal } from "./signalService.js";
import { logHunterEvent } from "./hunterEventLogger.js";
import { aiClassifierService } from "./aiClassifierService.js";
import {
  CONFIDENCE_THRESHOLD,
  hunterService,
  ProcessAdResult,
} from "./hunterService.js";
import { sendAlert, sendCloakerAddedAlert } from "./alertService.js";
import { trySightingAdd } from "./redirectAddService.js";
import pool from "../dbPool.js";
import { readConfig } from "../config.js";
import { generateTotp } from "../utils/totp.js";
import {
  captureStorageState,
  StorageState,
} from "../utils/storageState.js";

const YAHOO_MAIL_URL = "https://mail.yahoo.com/";
const TABOOLA_AUCTION_PATTERN =
  /display\.bidder\.taboola\.com\/OpenRTB\/TaboolaHB\/auction/i;
const TABOOLA_RECOMMENDATIONS_PATTERN =
  /api\.taboola\.com\/2\.0\/json\/[^/]+\/recommendations\.get/i;
const TABOOLA_REFERER = "https://gpt.mail.yahoo.net/";

const SESSION_FILE = path.join(process.cwd(), "data", "yahoo", "session.json");
const FAILURE_SCREENSHOT_DIR = path.join(process.cwd(), "data", "yahoo");

const PAGE_LOAD_TIMEOUT_MS = 45_000;
const LOGIN_TIMEOUT_MS = 45_000;
const CAPTURE_WINDOW_MS = 35_000;
const CYCLE_BUDGET_MS = 90_000;
const MAX_ADS_PER_CYCLE = 3;
const LOGIN_SETTLE_TIMEOUT_MS = 30_000;

/** Hosts that are ad delivery/click infrastructure, never a cloaker candidate. */
const AD_INFRA_HOST_SUFFIXES = [
  "taboola.com",
  "taboola-display.com",
  "tblcontent.com",
  "ybp.yahoo.com",
  "yahoo.com",
  "yimg.com",
  "doubleclick.net",
  "google.com",
  "googlesyndication.com",
  "googleadservices.com",
  "criteo.com",
  "criteo.net",
  "doubleverify.com",
  "agkn.com",
];

export interface TaboolaHuntOptions {
  /** Parse/classify one ad but skip DB writes, alerts, redirect adds, and reports. */
  dryRun?: boolean;
  /** Capture and parse only, with no navigation at all. */
  patternOnly?: boolean;
  maxAds?: number;
  captureWindowMs?: number;
}

export type TaboolaHuntStatus =
  | "no_fill"
  | "processed"
  | "skipped"
  | "failed"
  | "pattern_only";

export interface TaboolaDestination {
  url: string;
  source:
    | "maxdest"
    | "adurl"
    | "ds_dest_url"
    | "redir"
    | "unwrapped_click"
    | "click"
    | "raw";
  requiresClick: boolean;
}

export interface TaboolaCreative {
  clickUrl: string;
  title?: string;
  description?: string;
  brandingText?: string;
  ctaText?: string;
  advertiserDomain?: string;
  thumbnailUrl?: string;
  itemId?: string;
}

export interface TaboolaBid {
  bidId: string;
  impressionId: string;
  price: number;
  adId?: string;
  campaignId?: string;
  creativeId?: string;
  advertiserDomains: string[];
  width?: number;
  height?: number;
  placement?: string;
  bidfloor?: number;
  creative: TaboolaCreative | null;
  destination: TaboolaDestination | null;
}

export interface TaboolaRequestContext {
  impressions: Map<
    string,
    { tagid?: string; bidfloor?: number; gpid?: string }
  >;
}

export interface TaboolaAuctionCapture {
  url: string;
  responseBody: string;
  requestPostData: string | null;
  capturedAt: number;
}

export interface TaboolaHuntResult {
  status: TaboolaHuntStatus;
  target: "yahoo_mail";
  bids?: TaboolaBid[];
  processed?: number;
  reason?: string;
}

const EMPTY_REQUEST_CONTEXT: TaboolaRequestContext = {
  impressions: new Map(),
};

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(#x?[0-9a-f]+|[a-z]+);/gi,
    (match, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower === "amp") return "&";
      if (lower === "lt") return "<";
      if (lower === "gt") return ">";
      if (lower === "quot") return '"';
      if (lower === "apos") return "'";
      if (lower.startsWith("#x")) {
        const code = Number.parseInt(lower.slice(2), 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      if (lower.startsWith("#")) {
        const code = Number.parseInt(lower.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    }
  );
}

/**
 * Extracts a balanced JSON object starting at `start`. Taboola's `adm` embeds
 * a large JSON object inside a JavaScript push call, so a regular expression
 * cannot reliably find its end.
 */
export function extractBalancedObject(
  text: string,
  start: number
): string | null {
  if (text[start] !== "{") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

/** Pulls the `rec` object out of Taboola's `adm` markup without rendering it. */
export function extractTaboolaRec(adm: string): Record<string, unknown> | null {
  const marker = "rec:";
  let searchFrom = 0;

  while (searchFrom < adm.length) {
    const markerIndex = adm.indexOf(marker, searchFrom);
    if (markerIndex === -1) {
      return null;
    }

    const braceStart = adm.indexOf("{", markerIndex + marker.length);
    if (braceStart === -1) {
      return null;
    }

    const json = extractBalancedObject(adm, braceStart);
    if (json != null) {
      try {
        const parsed = JSON.parse(json) as unknown;
        if (parsed != null && typeof parsed === "object") {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Try the next `rec:` occurrence.
      }
    }

    searchFrom = markerIndex + marker.length;
  }

  return null;
}

/**
 * Extracts the creative metadata and click URL from a bid's `adm`. The hidden
 * win-notice image in `adm` is deliberately ignored; only `rec.vl[].url` is
 * used.
 */
export function extractTaboolaCreative(adm: string): TaboolaCreative | null {
  const rec = extractTaboolaRec(adm);
  if (rec == null) {
    return null;
  }

  // Some responses place the item list at rec.vl, others nest it under
  // rec.trc.vl. Support both shapes.
  const trc =
    rec.trc != null && typeof rec.trc === "object"
      ? (rec.trc as Record<string, unknown>)
      : null;
  const items = Array.isArray(rec.vl)
    ? rec.vl
    : trc != null && Array.isArray(trc.vl)
      ? trc.vl
      : null;

  if (items == null) {
    return null;
  }

  for (const item of items) {
    if (item == null || typeof item !== "object") {
      continue;
    }

    const value = item as Record<string, unknown>;
    if (typeof value.url !== "string" || value.url.trim() === "") {
      continue;
    }

    const readString = (key: string): string | undefined => {
      const raw = value[key];
      return typeof raw === "string" ? decodeHtmlEntities(raw) : undefined;
    };

    return {
      clickUrl: value.url,
      title: readString("title"),
      description: readString("description"),
      brandingText: readString("branding-text"),
      ctaText: readString("cta-text"),
      advertiserDomain: readString("adomain"),
      thumbnailUrl: readString("thumbnail"),
      itemId: readString("item-id"),
    };
  }

  return null;
}

function hostMatchesSuffix(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase();
  const normalized = suffix.toLowerCase();
  return host === normalized || host.endsWith(`.${normalized}`);
}

export function isKnownAdTrackerHost(hostname: string): boolean {
  return AD_INFRA_HOST_SUFFIXES.some((suffix) =>
    hostMatchesSuffix(hostname, suffix)
  );
}

/** Taboola creative assets/loaders are not click destinations. */
function isTaboolaAssetUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      hostMatchesSuffix(url.hostname, "cdn.taboola.com") ||
      hostMatchesSuffix(url.hostname, "taboola-display.com") ||
      hostMatchesSuffix(url.hostname, "images.taboola.com")
    );
  } catch {
    return false;
  }
}

/**
 * Resolves the best destination we can get without making a click. Direct
 * destination parameters (maxdest/adurl/ds_dest_url) win; otherwise Yahoo
 * wrappers are unwrapped and the resulting click URL is returned.
 */
export function resolveTaboolaDestination(
  clickUrl: string
): TaboolaDestination | null {
  const direct = extractAdDestinationUrl(clickUrl, {
    fallbackToRawHref: false,
    stripTrackingParams: true,
  });
  if (direct != null) {
    // A direct-destination parameter can still point at a click tracker (for
    // example, a native `redir` that wraps a DoubleClick trackclk URL).
    let requiresClick = false;
    try {
      requiresClick = isKnownAdTrackerHost(new URL(direct.url).hostname);
    } catch {
      requiresClick = false;
    }

    return {
      url: direct.url,
      source: direct.source,
      requiresClick,
    };
  }

  const unwrapped = unwrapYahooClickUrl(clickUrl);
  if (unwrapped != null) {
    const unwrappedDirect = extractAdDestinationUrl(unwrapped, {
      fallbackToRawHref: false,
      stripTrackingParams: true,
    });
    if (unwrappedDirect != null) {
      return {
        url: unwrappedDirect.url,
        source: unwrappedDirect.source,
        requiresClick: false,
      };
    }

    return {
      url: unwrapped,
      source: "unwrapped_click",
      requiresClick: true,
    };
  }

  if (isTaboolaAssetUrl(clickUrl)) {
    return null;
  }

  try {
    const parsed = new URL(clickUrl);
    if (!isKnownAdTrackerHost(parsed.hostname)) {
      return {
        url: clickUrl,
        source: "raw",
        requiresClick: false,
      };
    }
  } catch {
    return null;
  }

  return {
    url: clickUrl,
    source: "click",
    requiresClick: true,
  };
}

export function parseTaboolaRequestContext(
  postData: string | null
): TaboolaRequestContext {
  if (postData == null || postData.trim() === "") {
    return EMPTY_REQUEST_CONTEXT;
  }

  try {
    const parsed = JSON.parse(postData) as {
      imp?: Array<{
        id?: unknown;
        tagid?: unknown;
        bidfloor?: unknown;
        gpid?: unknown;
        ext?: { prebid?: { storedrequest?: { id?: unknown } } };
        data?: { pbadslot?: unknown };
      }>;
    };

    const impressions = new Map<
      string,
      { tagid?: string; bidfloor?: number; gpid?: string }
    >();

    for (const imp of parsed.imp ?? []) {
      if (typeof imp.id !== "string") {
        continue;
      }

      impressions.set(imp.id, {
        tagid: typeof imp.tagid === "string" ? imp.tagid : undefined,
        bidfloor:
          typeof imp.bidfloor === "number" ? imp.bidfloor : undefined,
        gpid:
          typeof imp.gpid === "string"
            ? imp.gpid
            : typeof imp.ext?.prebid?.storedrequest?.id === "string"
              ? imp.ext.prebid.storedrequest.id
              : typeof imp.data?.pbadslot === "string"
                ? imp.data.pbadslot
                : undefined,
      });
    }

    return { impressions };
  } catch {
    return EMPTY_REQUEST_CONTEXT;
  }
}

/** Parses a Taboola OpenRTB auction response into flat bid objects. */
export function parseTaboolaAuctionResponse(
  json: unknown,
  requestContext: TaboolaRequestContext = EMPTY_REQUEST_CONTEXT
): TaboolaBid[] {
  if (json == null || typeof json !== "object") {
    return [];
  }

  const seatbid = (json as { seatbid?: unknown }).seatbid;
  if (!Array.isArray(seatbid)) {
    return [];
  }

  const bids: TaboolaBid[] = [];

  for (const seat of seatbid) {
    if (seat == null || typeof seat !== "object") {
      continue;
    }

    const seatBids = (seat as { bid?: unknown }).bid;
    if (!Array.isArray(seatBids)) {
      continue;
    }

    for (const rawBid of seatBids) {
      if (rawBid == null || typeof rawBid !== "object") {
        continue;
      }

      const bid = rawBid as Record<string, unknown>;
      const adm = typeof bid.adm === "string" ? bid.adm : "";
      const creative = adm === "" ? null : extractTaboolaCreative(adm);
      const destination =
        creative == null ? null : resolveTaboolaDestination(creative.clickUrl);

      // Bids without a usable creative/destination are not actionable.
      if (creative == null || destination == null) {
        continue;
      }

      const advertiserDomains = Array.isArray(bid.adomain)
        ? bid.adomain.filter(
            (domain): domain is string => typeof domain === "string"
          )
        : creative?.advertiserDomain != null
          ? [creative.advertiserDomain]
          : [];

      const impressionId =
        typeof bid.impid === "string" ? bid.impid : "";
      const placementInfo = requestContext.impressions.get(impressionId);

      bids.push({
        bidId: typeof bid.id === "string" ? bid.id : crypto.randomUUID(),
        impressionId,
        price: typeof bid.price === "number" ? bid.price : 0,
        adId: typeof bid.adid === "string" ? bid.adid : undefined,
        campaignId: typeof bid.cid === "string" ? bid.cid : undefined,
        creativeId: typeof bid.crid === "string" ? bid.crid : undefined,
        advertiserDomains,
        width: typeof bid.w === "number" ? bid.w : undefined,
        height: typeof bid.h === "number" ? bid.h : undefined,
        placement: placementInfo?.tagid,
        bidfloor: placementInfo?.bidfloor,
        creative,
        destination,
      });
    }
  }

  return bids;
}

function nativeCreativeId(itemId: unknown): string | undefined {
  if (typeof itemId !== "string" || itemId === "") {
    return undefined;
  }

  // Native item IDs look like "~~V1~~1234567890~~<long token>".
  // The numeric segment is the stable creative identifier.
  const parts = itemId.split("~~");
  return parts[2] != null && parts[2] !== "" ? parts[2] : itemId;
}

function firstThumbnailUrl(item: Record<string, unknown>): string | undefined {
  if (!Array.isArray(item.thumbnail)) {
    return undefined;
  }
  for (const thumbnail of item.thumbnail) {
    if (
      thumbnail != null &&
      typeof thumbnail === "object" &&
      typeof (thumbnail as { url?: unknown }).url === "string"
    ) {
      return (thumbnail as { url: string }).url;
    }
  }
  return undefined;
}

/**
 * Parses the Taboola recommendations API used for the native ad rows in the
 * Yahoo Mail inbox. Each placement contains a list of items whose click URL
 * carries a `redir` parameter with the landing page.
 */
export function parseTaboolaRecommendationsResponse(
  json: unknown
): TaboolaBid[] {
  if (json == null || typeof json !== "object") {
    return [];
  }

  const placements = (json as { placements?: unknown }).placements;
  if (!Array.isArray(placements)) {
    return [];
  }

  const bids: TaboolaBid[] = [];

  for (const rawPlacement of placements) {
    if (rawPlacement == null || typeof rawPlacement !== "object") {
      continue;
    }

    const placement = rawPlacement as Record<string, unknown>;
    const items = placement.list;
    if (!Array.isArray(items)) {
      continue;
    }

    for (const rawItem of items) {
      if (rawItem == null || typeof rawItem !== "object") {
        continue;
      }

      const item = rawItem as Record<string, unknown>;
      const clickUrl = item.url;
      if (typeof clickUrl !== "string" || clickUrl.trim() === "") {
        continue;
      }

      const destination = resolveTaboolaDestination(clickUrl);
      if (destination == null) {
        continue;
      }

      let destinationHost: string | undefined;
      try {
        destinationHost = new URL(destination.url).hostname.toLowerCase();
      } catch {
        destinationHost = undefined;
      }

      // A redir can point at a tracker (DoubleClick, etc.); in that case the
      // branding text is more useful for dedupe/alerts than the tracker host.
      const advertiserDomain =
        destinationHost != null &&
        !isKnownAdTrackerHost(destinationHost)
          ? destinationHost
          : typeof item.branding === "string" && item.branding.trim() !== ""
            ? item.branding
            : destinationHost;

      const creativeId = nativeCreativeId(item.id);
      const title = typeof item.name === "string" ? item.name : undefined;
      const branding =
        typeof item.branding === "string" ? item.branding : undefined;
      const ctaText =
        typeof item["cta-text"] === "string" ? item["cta-text"] : undefined;

      bids.push({
        bidId: typeof item.id === "string" ? item.id : crypto.randomUUID(),
        impressionId:
          typeof placement.id === "string" ? placement.id : "",
        price: 0,
        adId: creativeId,
        campaignId: undefined,
        creativeId,
        advertiserDomains: advertiserDomain != null ? [advertiserDomain] : [],
        placement:
          typeof placement.name === "string" ? placement.name : undefined,
        bidfloor: undefined,
        creative: {
          clickUrl,
          title,
          description: title,
          brandingText: branding,
          ctaText,
          advertiserDomain,
          thumbnailUrl: firstThumbnailUrl(item),
          itemId: typeof item.id === "string" ? item.id : undefined,
        },
        destination,
      });
    }
  }

  return bids;
}

export function taboolaCreativeKey(bid: TaboolaBid): string {
  const advertiser =
    bid.advertiserDomains[0] ?? bid.creative?.advertiserDomain ?? "";
  return `${advertiser.toLowerCase()}|${bid.campaignId ?? ""}|${bid.creativeId ?? ""}`;
}

/**
 * Finds the last redirect hop that is not known ad infrastructure. Yahoo,
 * Taboola, DoubleClick and Criteo hops are never cloaker candidates.
 */
export function findTaboolaCloakerCandidate(
  redirectionPath: string[],
  finalUrl: string
): string | null {
  if (redirectionPath.length < 2) {
    return null;
  }

  let finalHostname: string;
  try {
    finalHostname = new URL(finalUrl).hostname;
  } catch {
    return null;
  }

  for (let i = redirectionPath.length - 2; i >= 0; i--) {
    try {
      const hostname = new URL(redirectionPath[i]).hostname;
      if (hostname === finalHostname || isKnownAdTrackerHost(hostname)) {
        continue;
      }
      return redirectionPath[i];
    } catch {
      continue;
    }
  }

  return null;
}

export class TaboolaHunter {
  private browser: Browser | null = null;
  private browserInitializing = false;

  async init(): Promise<void> {
    await this.ensureBrowserIsHealthy();
  }

  async restartBrowser(): Promise<void> {
    console.log("Restarting TaboolaHunter browser...");
    try {
      this.browserInitializing = true;
      this.browser = await BrowserManagerService.forceRestartBrowser(
        this.browser,
        false
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
          console.log("TaboolaHunter initialized new browser");
        } finally {
          this.browserInitializing = false;
        }
      }
    );
  }

  async close(): Promise<void> {
    await BrowserManagerService.closeBrowser(this.browser);
    this.browser = null;
  }

  async huntTaboolaAds(
    options: TaboolaHuntOptions = {}
  ): Promise<TaboolaHuntResult> {
    return this.huntTaboolaAdsInternal(options);
  }

  private async huntTaboolaAdsInternal(
    options: TaboolaHuntOptions
  ): Promise<TaboolaHuntResult> {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null || !this.browser.isConnected()) {
      console.error(
        "Browser has not been initialized or crashed - Taboola hunter failed"
      );
      await logHunterEvent("taboola", "error", "Browser not initialized or crashed");
      return { status: "failed", target: "yahoo_mail", reason: "browser unavailable" };
    }

    const captureWindowMs = options.captureWindowMs ?? CAPTURE_WINDOW_MS;
    const context = await this.browser.newContext({
      proxy: await parseProxy("hunter"),
      storageState: await this.loadStoredSession(),
      viewport: null,
    });
    const page = await context.newPage();
    const captures: TaboolaAuctionCapture[] = [];

    const onResponse = (response: Response) => {
      void this.captureAuctionResponse(response, captures);
    };

    try {
      await spoofWindowsChrome(context, page);
      await blockGoogleAnalytics(page);
      page.on("response", onResponse);

      await logHunterEvent(
        "taboola",
        "cycle_start",
        "Starting Taboola hunt on Yahoo Mail",
        { url: YAHOO_MAIL_URL, pattern_only: options.patternOnly ?? false }
      );

      await page.goto(YAHOO_MAIL_URL, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_LOAD_TIMEOUT_MS,
      });

      let authenticated = await this.waitForLoggedIn(page, 20_000);
      if (!authenticated) {
        console.log("Taboola hunter: Yahoo session missing or expired, logging in");
        authenticated = await this.login(page);
        if (authenticated) {
          await this.saveSession(context);
        }
      }

      if (!authenticated) {
        await logHunterEvent("taboola", "error", "Yahoo Mail login failed");
        await this.takeFailureScreenshot(page, "taboola_login_failure");
        return {
          status: "failed",
          target: "yahoo_mail",
          reason: "Yahoo Mail login failed",
        };
      }

      await this.waitForInbox(page);

      // Give the top-right/top-rail and inbox slots time to request and refresh ads.
      await page.mouse.move(900, 400).catch(() => {});
      await page.waitForTimeout(3_000);
      await page.mouse.wheel(0, 700).catch(() => {});
      await page.waitForTimeout(1_500);
      await page.mouse.wheel(0, -700).catch(() => {});
      await page.waitForTimeout(Math.max(0, captureWindowMs - 4_500));

      page.off("response", onResponse);

      if (captures.length === 0) {
        console.log("Taboola hunter: no Taboola responses captured");
        await logHunterEvent("taboola", "ad_skipped", "no Taboola responses captured");
        return { status: "no_fill", target: "yahoo_mail" };
      }

      const bids = this.parseCaptures(captures);
      // Prefer destinations that do not require a billable click.
      bids.sort(
        (a, b) =>
          Number(a.destination?.requiresClick ?? true) -
          Number(b.destination?.requiresClick ?? true)
      );
      console.log(
        `Taboola hunter: ${captures.length} Taboola response(s), ${bids.length} bid(s)`
      );
      await logHunterEvent("taboola", "ads_found", `Found ${bids.length} Taboola bids`, {
        response_count: captures.length,
        bid_count: bids.length,
        bids: bids.slice(0, 10).map((bid) => ({
          adomain: bid.advertiserDomains.join(","),
          cid: bid.campaignId,
          crid: bid.creativeId,
          placement: bid.placement,
          bidfloor: bid.bidfloor,
          destination: bid.destination?.url,
          destination_source: bid.destination?.source,
          requires_click: bid.destination?.requiresClick,
        })),
      });

      if (options.patternOnly) {
        await this.saveSession(context);
        return { status: "pattern_only", target: "yahoo_mail", bids };
      }

      const deadline = Date.now() + CYCLE_BUDGET_MS;
      const maxAds = options.maxAds ?? MAX_ADS_PER_CYCLE;
      let processed = 0;

      for (const bid of bids.slice(0, maxAds)) {
        if (Date.now() >= deadline) {
          await logHunterEvent("taboola", "ad_skipped", "cycle budget exhausted");
          break;
        }

        if (await this.shouldSkipBid(bid, options)) {
          continue;
        }

        const didProcess = await this.processBid(bid, context, options);
        if (didProcess) {
          processed++;
        }
      }

      await this.saveSession(context);

      return {
        status: processed > 0 ? "processed" : "skipped",
        target: "yahoo_mail",
        bids,
        processed,
      };
    } catch (error) {
      console.error(`Taboola hunter error: ${error}`);
      await logHunterEvent("taboola", "error", `Hunt failed: ${error}`);
      await this.takeFailureScreenshot(page, "taboola_hunt_failure");
      return {
        status: "failed",
        target: "yahoo_mail",
        reason: String(error),
      };
    } finally {
      page.off("response", onResponse);
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  }

  private async captureAuctionResponse(
    response: Response,
    captures: TaboolaAuctionCapture[]
  ): Promise<void> {
    if (
      !TABOOLA_AUCTION_PATTERN.test(response.url()) &&
      !TABOOLA_RECOMMENDATIONS_PATTERN.test(response.url())
    ) {
      return;
    }

    if (response.status() !== 200) {
      return;
    }

    const contentType = response.headers()["content-type"] ?? "";
    if (!/json|text/i.test(contentType)) {
      return;
    }

    try {
      const responseBody = await response.text();
      if (!responseBody.trim().startsWith("{")) {
        return;
      }

      let requestPostData: string | null = null;
      try {
        requestPostData = response.request().postData();
      } catch {
        // The request body is best effort; the response is still useful.
      }

      captures.push({
        url: response.url(),
        responseBody,
        requestPostData,
        capturedAt: Date.now(),
      });
    } catch (error) {
      console.log(`Taboola hunter: failed to read Taboola response: ${error}`);
    }
  }

  private parseCaptures(captures: TaboolaAuctionCapture[]): TaboolaBid[] {
    const bids: TaboolaBid[] = [];
    const seenBids = new Set<string>();
    const seenCreatives = new Set<string>();

    for (const capture of captures) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(capture.responseBody);
      } catch {
        continue;
      }

      const requestContext = parseTaboolaRequestContext(
        capture.requestPostData
      );
      const parsedBids = TABOOLA_RECOMMENDATIONS_PATTERN.test(capture.url)
        ? parseTaboolaRecommendationsResponse(parsed)
        : parseTaboolaAuctionResponse(parsed, requestContext);

      for (const bid of parsedBids) {
        if (bid.destination == null) {
          continue;
        }
        if (seenBids.has(bid.bidId)) {
          continue;
        }

        const creativeKey = taboolaCreativeKey(bid);
        if (seenCreatives.has(creativeKey)) {
          continue;
        }

        seenBids.add(bid.bidId);
        seenCreatives.add(creativeKey);
        bids.push(bid);
      }
    }

    return bids;
  }

  private async shouldSkipBid(
    bid: TaboolaBid,
    options: TaboolaHuntOptions
  ): Promise<boolean> {
    const config = await readConfig();
    const skipDomains = (config.taboolaSkipAdvertiserDomains ?? []).map(
      (domain) => domain.toLowerCase()
    );
    const advertiserDomains = bid.advertiserDomains.map((domain) =>
      domain.toLowerCase()
    );

    if (advertiserDomains.some((domain) => skipDomains.includes(domain))) {
      console.log(
        `Skipping Taboola advertiser domain on skip list: ${advertiserDomains.join(", ")}`
      );
      await logHunterEvent("taboola", "ad_skipped", "advertiser domain on skip list", {
        url: bid.destination?.url,
        adomain: advertiserDomains,
      });
      return true;
    }

    if (options.dryRun) {
      return false;
    }

    if (await this.isKnownScamCreative(bid)) {
      console.log(`Skipping already known Taboola scam creative: ${taboolaCreativeKey(bid)}`);
      await logHunterEvent("taboola", "ad_skipped", "known scam creative", {
        creative_key: taboolaCreativeKey(bid),
        url: bid.destination?.url,
      });
      return true;
    }

    if (
      bid.destination != null &&
      !bid.destination.requiresClick &&
      (await this.isKnownScamDestination(bid.destination.url))
    ) {
      console.log(`Skipping already known scam destination: ${bid.destination.url}`);
      await logHunterEvent("taboola", "ad_skipped", "known scam destination", {
        url: bid.destination.url,
      });
      return true;
    }

    return false;
  }

  private async processBid(
    bid: TaboolaBid,
    sessionContext: BrowserContext,
    options: TaboolaHuntOptions
  ): Promise<boolean> {
    const destination = bid.destination;
    if (destination == null) {
      return false;
    }

    await logHunterEvent("taboola", "link_extracted", "Extracted Taboola destination", {
      adomain: bid.advertiserDomains.join(","),
      cid: bid.campaignId,
      crid: bid.creativeId,
      placement: bid.placement,
      bidfloor: bid.bidfloor,
      source: destination.source,
      requires_click: destination.requiresClick,
      url: destination.url,
    });

    let result: ProcessAdResult | null = null;

    if (destination.requiresClick) {
      // Try the shortest form first. A fresh context is cheaper than reusing
      // the logged-in Yahoo context, but some click tokens are session-bound.
      result = await hunterService.processAd(destination.url, TABOOLA_REFERER);
      if (result == null || this.isStuckOnTracker(result, destination.url)) {
        console.log(
          "Taboola hunter: click did not resolve in a fresh context, retrying in Yahoo context"
        );
        result = await hunterService.processAd(
          bid.creative?.clickUrl ?? destination.url,
          TABOOLA_REFERER,
          { context: sessionContext }
        );
      }
    } else {
      result = await hunterService.processAd(destination.url, TABOOLA_REFERER);
    }

    if (result == null) {
      await logHunterEvent("taboola", "error", "Failed to process Taboola destination", {
        url: destination.url,
      });
      return false;
    }

    return await this.processAdResult(bid, result, options);
  }

  private isStuckOnTracker(
    result: ProcessAdResult,
    originalUrl: string
  ): boolean {
    const finalUrl =
      result.redirectionPath[result.redirectionPath.length - 1] ?? originalUrl;

    try {
      const originalHost = new URL(originalUrl).hostname;
      const finalHost = new URL(finalUrl).hostname;
      if (finalUrl === originalUrl) {
        return isKnownAdTrackerHost(finalHost);
      }
      return isKnownAdTrackerHost(finalHost) && finalHost !== originalHost;
    } catch {
      return false;
    }
  }

  private async processAdResult(
    bid: TaboolaBid,
    result: ProcessAdResult,
    options: TaboolaHuntOptions
  ): Promise<boolean> {
    const destination = bid.destination;
    if (destination == null) {
      return false;
    }

    const finalUrl =
      result.redirectionPath[result.redirectionPath.length - 1] ??
      destination.url;

    if (aiClassifierService.isWhitelisted(finalUrl)) {
      console.log(
        `✅ Whitelisted domain detected: ${finalUrl} - Skipping Taboola processing`
      );
      await logHunterEvent("taboola", "whitelisted", `Whitelisted: ${finalUrl}`, {
        url: destination.url,
        final_url: finalUrl,
      });
      return false;
    }

    const classifierResult = await aiClassifierService.runInference(
      result.screenshot
    );
    const hasSignal = hasWeightedSignal(result.signals);
    const isScam =
      classifierResult.isScam &&
      classifierResult.confidenceScore >= CONFIDENCE_THRESHOLD &&
      hasSignal;

    await logHunterEvent("taboola", "classification", `Classified ${finalUrl}`, {
      url: destination.url,
      final_url: finalUrl,
      classifier_is_scam: classifierResult.isScam,
      confidence: classifierResult.confidenceScore,
      has_signal: hasSignal,
      effective_is_scam: isScam,
      redirect_hops: result.redirectionPath.length,
      destination_source: destination.source,
    });

    if (options.dryRun) {
      console.log(
        `[taboola dry-run] ${destination.url} -> ${finalUrl} ` +
          `(isScam=${isScam}, confidence=${classifierResult.confidenceScore.toFixed(3)}, ` +
          `signals=${hasSignal}, source=${destination.source})`
      );
      return true;
    }

    await aiClassifierService.saveData(
      finalUrl,
      result.screenshot,
      result.html,
      classifierResult.isScam,
      classifierResult.confidenceScore
    );

    let isNewDestination = false;
    let isStatusChange = false;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const advertiserDomain =
        bid.advertiserDomains[0] ?? bid.creative?.advertiserDomain ?? "";
      const creativeId = bid.creativeId ?? bid.bidId;

      const existingResult = await client.query(
        `SELECT a.id, a.is_scam
         FROM ads a
         JOIN taboola_ads t ON t.ad_id = a.id
         WHERE lower(t.advertiser_domain) = lower($1)
           AND t.creative_id = $2
         ORDER BY a.last_seen DESC
         LIMIT 1`,
        [advertiserDomain, creativeId]
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
            hunterService.pgArray(result.redirectionPath),
            classifierResult.isScam,
            classifierResult.confidenceScore,
            result.signals.fullscreenRequested,
            result.signals.keyboardLockRequested,
            result.signals.pointerLockRequested,
            result.signals.isThirdPartyHosting,
            result.signals.isIpAddress,
            result.signals.pageLoadFrozen,
            result.signals.workerBombDetected,
            existingAd.id,
          ]
        );

        await client.query(
          `UPDATE taboola_ads SET
             last_seen = CURRENT_TIMESTAMP,
             bid_id = $1,
             impression_id = $2,
             campaign_id = $3,
             advertiser_domain = $4,
             title = $5,
             description = $6,
             branding_text = $7,
             cta_text = $8,
             thumbnail_url = $9,
             click_url = $10,
             placement = $11,
             bidfloor = $12,
             destination_source = $13
           WHERE ad_id = $14`,
          [
            bid.bidId,
            bid.impressionId,
            bid.campaignId ?? null,
            advertiserDomain || null,
            bid.creative?.title ?? null,
            bid.creative?.description ?? null,
            bid.creative?.brandingText ?? null,
            bid.creative?.ctaText ?? null,
            bid.creative?.thumbnailUrl ?? null,
            bid.creative?.clickUrl ?? null,
            bid.placement ?? null,
            bid.bidfloor ?? null,
            destination.source,
            existingAd.id,
          ]
        );

        if (existingAd.is_scam !== isScam) {
          isStatusChange = true;
          await client.query(`UPDATE ads SET is_scam = $1 WHERE id = $2`, [
            isScam,
            existingAd.id,
          ]);

          const reason = isScam
            ? `Changed to scam with confidence ${(classifierResult.confidenceScore * 100).toFixed(1)}%`
            : `No longer classified as scam (confidence: ${(classifierResult.confidenceScore * 100).toFixed(1)}%)`;

          await client.query(
            `INSERT INTO ad_status_history
               (ad_id, previous_status, new_status, classifier_is_scam, confidence_score, reason)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              existingAd.id,
              existingAd.is_scam,
              isScam,
              classifierResult.isScam,
              classifierResult.confidenceScore,
              reason,
            ]
          );
        }

        console.log(`Updated existing Taboola ad: ${existingAd.id}`);
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
            "taboola",
            destination.url,
            finalUrl,
            hunterService.pgArray(result.redirectionPath),
            classifierResult.isScam,
            classifierResult.confidenceScore,
            isScam,
            result.signals.fullscreenRequested,
            result.signals.keyboardLockRequested,
            result.signals.pointerLockRequested,
            result.signals.isThirdPartyHosting,
            result.signals.isIpAddress,
            result.signals.pageLoadFrozen,
            result.signals.workerBombDetected,
          ]
        );

        await client.query(
          `INSERT INTO taboola_ads
           (ad_id, bid_id, impression_id, campaign_id, creative_id, advertiser_domain,
            title, description, branding_text, cta_text, thumbnail_url, click_url,
            placement, bidfloor, destination_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            adId,
            bid.bidId,
            bid.impressionId,
            bid.campaignId ?? null,
            creativeId,
            advertiserDomain || null,
            bid.creative?.title ?? null,
            bid.creative?.description ?? null,
            bid.creative?.brandingText ?? null,
            bid.creative?.ctaText ?? null,
            bid.creative?.thumbnailUrl ?? null,
            bid.creative?.clickUrl ?? null,
            bid.placement ?? null,
            bid.bidfloor ?? null,
            destination.source,
          ]
        );

        console.log(`New Taboola ad: ${destination.url} -> ${finalUrl}`);
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      console.error(`Taboola database error: ${error}`);
      await logHunterEvent("taboola", "error", `Database error: ${error}`, {
        url: destination.url,
      });
      return false;
    } finally {
      client.release();
    }

    if (isNewDestination) {
      await logHunterEvent(
        "taboola",
        "ad_processed",
        `New ad: ${isScam ? "SCAM" : "clean"}`,
        {
          url: destination.url,
          final_url: finalUrl,
          is_scam: isScam,
          confidence: classifierResult.confidenceScore,
          destination_source: destination.source,
        }
      );
    }

    if (isStatusChange) {
      await logHunterEvent(
        "taboola",
        "status_changed",
        `Status changed to ${isScam}`,
        {
          url: destination.url,
          final_url: finalUrl,
          confidence: classifierResult.confidenceScore,
        }
      );
    }

    if (isScam) {
      const cloakerCandidate = findTaboolaCloakerCandidate(
        result.redirectionPath,
        finalUrl
      );

      if (isNewDestination || isStatusChange) {
        if (isNewDestination) {
          await logHunterEvent("taboola", "scam_detected", `New scam: ${finalUrl}`, {
            url: destination.url,
            final_url: finalUrl,
            confidence: classifierResult.confidenceScore,
            cloaker: cloakerCandidate,
          });
        }

        await sendAlert({
          type: "taboola",
          initialUrl: destination.url,
          finalUrl,
          adText: bid.creative?.title,
          isNew: isNewDestination,
          confidenceScore: classifierResult.confidenceScore,
          redirectionPath: result.redirectionPath,
          cloakerCandidate,
        });
      }

      if (cloakerCandidate != null) {
        const { attempted, added, strategy } =
          await trySightingAdd(cloakerCandidate);
        if (added) {
          await sendCloakerAddedAlert(cloakerCandidate, "Taboola", strategy);
          await logHunterEvent(
            "taboola",
            "added_to_checker",
            `Added ${cloakerCandidate} to redirect checker`,
            { url: cloakerCandidate }
          );
        } else if (attempted) {
          console.log(
            "Auto-add to redirect checker failed, will retry on a later sighting"
          );
        }
      }
    }

    return true;
  }

  private async isKnownScamCreative(bid: TaboolaBid): Promise<boolean> {
    const advertiserDomain =
      bid.advertiserDomains[0] ?? bid.creative?.advertiserDomain ?? "";
    const creativeId = bid.creativeId ?? bid.bidId;

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT a.id
         FROM ads a
         JOIN taboola_ads t ON t.ad_id = a.id
         WHERE lower(t.advertiser_domain) = lower($1)
           AND t.creative_id = $2
           AND a.is_scam = true
         ORDER BY a.last_seen DESC
         LIMIT 1`,
        [advertiserDomain, creativeId]
      );

      if (result.rowCount === 0) {
        return false;
      }

      await client.query(
        `UPDATE ads SET last_seen = CURRENT_TIMESTAMP WHERE id = $1`,
        [result.rows[0].id]
      );
      await client.query(
        `UPDATE taboola_ads SET last_seen = CURRENT_TIMESTAMP WHERE ad_id = $1`,
        [result.rows[0].id]
      );
      return true;
    } finally {
      client.release();
    }
  }

  private async isKnownScamDestination(url: string): Promise<boolean> {
    let hostname: string;
    try {
      hostname = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id
         FROM ads
         WHERE is_scam = true
           AND (
             regexp_replace(final_url, '\\?.*$', '') = regexp_replace($1, '\\?.*$', '')
             OR lower(regexp_replace(final_url, '^https?://([^/]+)/?.*$', '\\1')) = $2
           )
         ORDER BY last_seen DESC
         LIMIT 1`,
        [url, hostname]
      );

      if (result.rowCount === 0) {
        return false;
      }

      await client.query(
        `UPDATE ads SET last_seen = CURRENT_TIMESTAMP WHERE id = $1`,
        [result.rows[0].id]
      );
      return true;
    } finally {
      client.release();
    }
  }

  private async isLoggedIn(page: Page): Promise<boolean> {
    if (!page.url().includes("mail.yahoo.com")) {
      return false;
    }
    if (page.url().includes("login.yahoo.com")) {
      return false;
    }

    const usernameFields = await page
      .locator('input[name="username"], #login-username')
      .count()
      .catch(() => 0);
    if (usernameFields > 0) {
      return false;
    }

    // The inbox URL is the most reliable signal; Yahoo uses paths such as
    // /n/inbox/priority after login.
    if (/mail\.yahoo\.com\/(?:n\/)?inbox/i.test(page.url())) {
      return true;
    }

    const appSelectors =
      '#mail-app, [data-test-id="mail-app"], [data-test-id="mail-search"], ' +
      '[data-test-id="mail-left-nav"], [data-test-id="mail-search-input"]';
    if ((await page.locator(appSelectors).count().catch(() => 0)) > 0) {
      return true;
    }

    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 5_000 })
      .catch(() => "");

    // The logged-out mail.yahoo.com marketing page contains phrases such as
    // "inbox" and "AI compose"; require the actual app controls instead.
    if (/Sign in to Yahoo Mail|Designed to simplify your life/i.test(bodyText)) {
      return false;
    }

    return /New message|Search your mail|Compose|Search mail/.test(bodyText);
  }

  private async waitForLoggedIn(page: Page, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.isLoggedIn(page)) {
        return true;
      }
      if (page.url().includes("login.yahoo.com")) {
        return false;
      }
      await page.waitForTimeout(1_000);
    }
    return false;
  }

  private async login(page: Page): Promise<boolean> {
    try {
      const config = await readConfig();
      if (
        typeof config.yahooUsername !== "string" ||
        config.yahooUsername.trim() === "" ||
        typeof config.yahooPassword !== "string" ||
        config.yahooPassword === ""
      ) {
        console.error(
          "Taboola hunter: yahooUsername/yahooPassword missing from config.json"
        );
        return false;
      }

      if (!page.url().includes("login.yahoo.com")) {
        await page.goto("https://login.yahoo.com/", {
          waitUntil: "domcontentloaded",
          timeout: PAGE_LOAD_TIMEOUT_MS,
        });
      }

      await page.waitForTimeout(2_000);

      // Keep the session alive as long as Yahoo allows. This is a dedicated
      // container, so a persistent sign-in cookie is desirable.
      const persistent = page.locator("#persistent");
      if (await persistent.isVisible().catch(() => false)) {
        if (!(await persistent.isChecked().catch(() => false))) {
          await persistent.check().catch(() => {});
        }
      }

      const usernameField = page
        .locator('input[name="username"], #login-username')
        .first();
      await usernameField.waitFor({ state: "visible", timeout: 15_000 });
      await usernameField.fill(config.yahooUsername);
      await usernameField.press("Enter");

      const passwordField = page
        .locator('input[name="password"], #login-passwd')
        .first();
      await passwordField.waitFor({ state: "visible", timeout: 15_000 });
      await passwordField.fill(config.yahooPassword);
      await passwordField.press("Enter");

      await page.waitForTimeout(3_000);
      await this.solveTotpChallenge(page);
      await this.clearLoginInterruptions(page);

      // Yahoo's login flow often lands on www.yahoo.com rather than Mail.
      if (
        !page.url().includes("mail.yahoo.com") &&
        page.url().includes("yahoo.com") &&
        !page.url().includes("login.yahoo.com")
      ) {
        console.log("Taboola hunter: navigating to Yahoo Mail after sign-in");
        await page.goto(YAHOO_MAIL_URL, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_LOAD_TIMEOUT_MS,
        });
        await this.waitForInbox(page);
      }

      const loggedIn = await this.waitForLoggedIn(page, LOGIN_TIMEOUT_MS);
      if (!loggedIn) {
        console.error(
          "Taboola hunter: Yahoo login did not reach the inbox; a manual noVNC login may be required"
        );
      }
      return loggedIn;
    } catch (error) {
      console.error(`Taboola hunter: Yahoo login failed: ${error}`);
      return false;
    }
  }

  private async clearLoginInterruptions(page: Page): Promise<void> {
    const deadline = Date.now() + LOGIN_SETTLE_TIMEOUT_MS;
    let challengeAttempts = 0;

    while (Date.now() < deadline) {
      if (await this.isLoggedIn(page)) {
        return;
      }

      if (await this.isChallengePage(page)) {
        if (challengeAttempts >= 2) {
          console.error(
            "Taboola hunter: Yahoo verification still unresolved; use noVNC to finish login manually"
          );
          return;
        }

        challengeAttempts++;
        const solved = await this.solveTotpChallenge(page);
        if (!solved) {
          console.error(
            "Taboola hunter: Yahoo verification requires manual intervention; use noVNC to finish login"
          );
          return;
        }

        await page.waitForTimeout(3_000);
        continue;
      }

      const clicked = await this.clickFirstVisible(page, [
        page.getByRole("button", { name: /accept all/i }),
        page.getByRole("button", { name: /^agree$/i }),
        page.getByRole("button", { name: /stay signed in/i }),
        page.getByRole("button", { name: /^next$/i }),
        page.getByRole("button", { name: /^continue$/i }),
        page.getByRole("button", { name: /not now/i }),
        page.getByRole("button", { name: /maybe later/i }),
      ]);

      if (!clicked) {
        await page.waitForTimeout(750);
      }
    }
  }

  private async isChallengePage(page: Page): Promise<boolean> {
    const challengeSelectors = [
      'iframe[src*="captcha"]',
      'iframe[title*="challenge" i]',
      "#captcha",
      '[data-test-id*="captcha" i]',
    ];

    for (const selector of challengeSelectors) {
      if (await page.locator(selector).count().catch(() => 0)) {
        return true;
      }
    }

    // The password step is also under /account/challenge/; it is handled by
    // the password fill above, not by the TOTP solver.
    if (/\/account\/challenge\/password/.test(page.url())) {
      return false;
    }

    if (/\/account\/challenge\//.test(page.url())) {
      return true;
    }

    const body = await page
      .locator("body")
      .innerText({ timeout: 2_000 })
      .catch(() => "");
    return /select a verification method|authenticator app|verification code|enter the code|verify your identity|unusual activity|enter the characters/i.test(
      body
    );
  }

  private async getCodeField(page: Page): Promise<Locator | null> {
    const selectors = [
      'input[autocomplete="one-time-code"]:visible',
      '#verify-code-0:visible',
      'input[name="code"]:not([type="hidden"]):visible',
      'input[name="verificationCode"]:visible',
      'input[name="verifyCode"]:visible',
      'input[name="otp"]:visible',
      '#verification-code:visible',
      'input[id*="verification" i]:visible',
      'input[inputmode="numeric"]:visible',
      'input[type="tel"]:visible',
    ];

    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.isVisible().catch(() => false)) {
        return locator;
      }
    }

    return null;
  }

  private async waitForCodeField(
    page: Page,
    timeoutMs: number = 10_000
  ): Promise<Locator | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const field = await this.getCodeField(page);
      if (field != null) {
        return field;
      }
      await page.waitForTimeout(500);
    }
    return null;
  }

  private async isCodeFieldVisible(page: Page): Promise<boolean> {
    return (await this.getCodeField(page)) != null;
  }

  private async selectAuthenticatorMethod(page: Page): Promise<void> {
    const authenticatorCandidates = [
      page.getByRole("button", { name: /authenticator app/i }),
      page.getByRole("link", { name: /authenticator app/i }),
      page.getByText(/authenticator app/i),
    ];

    if (await this.clickFirstVisible(page, authenticatorCandidates)) {
      await page.waitForTimeout(1_500);
      return;
    }

    const moreOptions = [
      page.getByRole("button", { name: /more options/i }),
      page.getByRole("link", { name: /more options/i }),
    ];

    if (await this.clickFirstVisible(page, moreOptions)) {
      await page.waitForTimeout(1_500);
      await this.clickFirstVisible(page, authenticatorCandidates);
      await page.waitForTimeout(1_500);
    }
  }

  private async solveTotpChallenge(page: Page): Promise<boolean> {
    if (!(await this.isChallengePage(page))) {
      return false;
    }

    const config = await readConfig();
    if (
      typeof config.yahooTotpSecret !== "string" ||
      config.yahooTotpSecret.trim() === ""
    ) {
      console.error(
        "Taboola hunter: Yahoo asked for verification but yahooTotpSecret is missing"
      );
      return false;
    }

    if (!(await this.isCodeFieldVisible(page))) {
      await this.selectAuthenticatorMethod(page);
    }

    const codeField = await this.waitForCodeField(page, 12_000);
    if (codeField == null) {
      console.error(
        "Taboola hunter: could not find the authenticator code field"
      );
      await this.logChallengeHtml(page);
      return false;
    }

    const enterCode = async (code: string): Promise<void> => {
      // Yahoo uses a segmented six-box code input. Typing into the first box
      // lets its own key handler distribute the digits; a single fill works
      // for the simpler one-box variants.
      const segmented = page.locator('input[id^="verify-code-"]:visible');
      const boxCount = await segmented.count().catch(() => 0);
      if (boxCount > 1) {
        await segmented.first().click();
        await page.keyboard.type(code, { delay: 50 });
      } else {
        await codeField.fill(code);
      }
    };

    const submitCode = async (code: string): Promise<void> => {
      await enterCode(code);
      const clicked = await this.clickFirstVisible(page, [
        page.getByRole("button", { name: /^next$/i }),
        page.getByRole("button", { name: /^verify$/i }),
        page.getByRole("button", { name: /^submit$/i }),
        page.getByRole("button", { name: /^continue$/i }),
      ]);
      if (!clicked) {
        await page.keyboard.press("Enter");
      }
    };

    try {
      await submitCode(generateTotp(config.yahooTotpSecret));
      // Give the challenge time to resolve before deciding the code was wrong.
      const settleDeadline = Date.now() + 8_000;
      while (Date.now() < settleDeadline) {
        if (!(await this.isChallengePage(page))) {
          return true;
        }
        if (!(await this.isCodeFieldVisible(page))) {
          return true;
        }
        await page.waitForTimeout(500);
      }

      // Clock skew is rare but cheap to handle: try the previous window once.
      console.log("TOTP: first code did not resolve, trying previous window");
      await submitCode(
        generateTotp(config.yahooTotpSecret, {
          timestamp: Date.now() - 30_000,
        })
      );
      await page.waitForTimeout(4_000);
      return true;
    } catch (error) {
      console.error(`TOTP challenge failed: ${error}`);
      await this.logChallengeHtml(page);
      return false;
    }
  }

  private async logChallengeHtml(page: Page): Promise<void> {
    try {
      const html = await page
        .locator("form")
        .first()
        .evaluate((element) => element.outerHTML);
      console.error(`Challenge form HTML: ${html.slice(0, 4_000)}`);
    } catch {
      // Best effort only.
    }
  }

  private async clickFirstVisible(
    _page: Page,
    candidates: Locator[]
  ): Promise<boolean> {
    for (const candidate of candidates) {
      try {
        if (await candidate.first().isVisible({ timeout: 400 })) {
          await candidate.first().click({ timeout: 2_000 });
          return true;
        }
      } catch {
        // Try the next candidate.
      }
    }
    return false;
  }

  private async waitForInbox(page: Page): Promise<void> {
    await page
      .waitForFunction(
        () => {
          const hasApp =
            document.querySelector(
              '#mail-app, [data-test-id="mail-app"], [data-test-id="mail-search"], [data-test-id="mail-left-nav"]'
            ) != null;
          return (
            hasApp || /Compose|Search mail/.test(document.body?.innerText ?? "")
          );
        },
        undefined,
        { timeout: 20_000 }
      )
      .catch(() => {});
    await page.waitForTimeout(3_000);
  }

  private async loadStoredSession(): Promise<StorageState | undefined> {
    try {
      const contents = await fs.readFile(SESSION_FILE, "utf8");
      console.log("Loaded stored Yahoo session");
      return JSON.parse(contents) as StorageState;
    } catch {
      console.log("No stored Yahoo session found, a sign-in will be needed");
      return undefined;
    }
  }

  private async saveSession(context: BrowserContext): Promise<void> {
    try {
      await fs.mkdir(path.dirname(SESSION_FILE), { recursive: true });
      await fs.writeFile(
        SESSION_FILE,
        JSON.stringify(await captureStorageState(context)),
        { mode: 0o600 }
      );
      console.log("Saved Yahoo session for future hunts");
    } catch (error) {
      console.error(`Failed to save Yahoo session: ${error}`);
    }
  }

  private async takeFailureScreenshot(
    page: Page,
    prefix: string
  ): Promise<string | null> {
    try {
      if (page.isClosed()) {
        return null;
      }

      await fs.mkdir(FAILURE_SCREENSHOT_DIR, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = path.join(
        FAILURE_SCREENSHOT_DIR,
        `${prefix}_${timestamp}.png`
      );
      await page.screenshot({ path: filePath, fullPage: true, timeout: 5_000 });
      console.error(`Saved ${prefix} screenshot to ${filePath}`);
      return filePath;
    } catch (error) {
      console.error(`Failed to save ${prefix} screenshot: ${error}`);
      return null;
    }
  }
}

export const taboolaHunter = new TaboolaHunter();
