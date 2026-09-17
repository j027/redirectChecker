import { checkRedirects } from "./redirectMonitorService.js";
import { monitorTakedownStatus } from "./takedownMonitorService.js";
import { searchAdHunter, typosquatHunter, pornhubAdHunter, adSpyGlassHunter, adsenseHunter } from "./hunterService.js";
import { pruneOldRedirects } from "./redirectPruningService.js";
import { browserRedirectService } from "./browserRedirectService.js";
import { logHunterEvent, pruneHunterEvents, HunterType } from "./hunterEventLogger.js";
import { pruneRedirectEvents } from "./redirectEventLogger.js";
import { pruneProxyEvents } from "./proxyEventLogger.js";
import { urlscanHunter } from "./urlscanHunter.js";
import { syncHashLists } from "./safeBrowsingV5Service.js";
import { hunterProxyService } from "./hunterProxyService.js";
import { HUNTER_NAMES, HunterName } from "../config.js";

let checkInterval: NodeJS.Timeout | null = null;
let takedownInterval: NodeJS.Timeout | null = null;
let adHunterInterval: NodeJS.Timeout | null = null;
let pruningInterval: NodeJS.Timeout | null = null;
let urlscanInterval: NodeJS.Timeout | null = null;
let hashListSyncInterval: NodeJS.Timeout | null = null;
let eventLogPrunerTimeout: NodeJS.Timeout | null = null;

let redirectCheckerAbortController: AbortController | null = null;
let adHunterAbortController: AbortController | null = null;
let takedownMonitorAbortController: AbortController | null = null;

let isRunning = {
  redirectChecker: false,
  takedownMonitor: false,
  adHunter: false,
  redirectPruner: false,
  urlscanHunter: false,
  hashListSync: false,
};

/** Returns a random delay between min and max milliseconds */
function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string,
  abortController?: AbortController
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        abortController?.abort();
        reject(
          new Error(`Operation ${operationName} timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      signal?.addEventListener("abort", () => {
        reject(new Error("AbortError"));
      });
    }),
  ]);
}

export function startRedirectChecker() {
  isRunning.redirectChecker = true;
  redirectCheckerAbortController = new AbortController();

  let isRedirectCheckInProgress = false;

  async function runRedirectCheck() {
    if (!isRunning.redirectChecker) {
      console.log("Redirect checker no longer running, stopping scheduler");
      return;
    }

    // Wait if previous cycle is still running
    if (isRedirectCheckInProgress) {
      console.log("Previous redirect check cycle still in progress, waiting...");
      checkInterval = setTimeout(runRedirectCheck, 10 * 1000);
      return;
    }

    isRedirectCheckInProgress = true;
    const cycleStartTime = Date.now();

    // Each cycle gets its own controller so a cycle timeout can abort that
    // cycle's operations without poisoning the long-lived service controller.
    const cycleAbortController = new AbortController();
    const serviceStopSignal = redirectCheckerAbortController?.signal;
    const onServiceStop = () => cycleAbortController.abort();
    serviceStopSignal?.addEventListener("abort", onServiceStop, { once: true });

    try {
      if (serviceStopSignal?.aborted) {
        cycleAbortController.abort();
      }
      cycleAbortController.signal.throwIfAborted();

      // Restart browser before each run to clear lingering state. The service
      // drains in-flight redirect operations first (bounded internally).
      console.log("Restarting redirect checker browser before cycle...");
      try {
        await browserRedirectService.restartBrowser();
      } catch (error) {
        console.error("Error restarting redirect checker browser:", error);
      }

      if (!isRunning.redirectChecker) {
        console.log("Redirect checking was cancelled");
        return;
      }

      const REDIRECT_CHECK_TIMEOUT_MS = 180000; // 3 minutes
      await withTimeout(
        checkRedirects(cycleAbortController.signal),
        REDIRECT_CHECK_TIMEOUT_MS,
        "Redirect check cycle",
        cycleAbortController
      );

      const cycleDurationMs = Date.now() - cycleStartTime;
      console.log(`Completed redirect check cycle in ${(cycleDurationMs / 1000).toFixed(1)}s`);
    } catch (error) {
      const cycleDurationMs = Date.now() - cycleStartTime;
      if (isAbortError(error) && !isRunning.redirectChecker) {
        console.log("Redirect checking was cancelled");
        return; // finally won't schedule because the service is stopped
      }
      console.error(`Error checking redirects after ${(cycleDurationMs / 1000).toFixed(1)}s:`, error);
    } finally {
      serviceStopSignal?.removeEventListener("abort", onServiceStop);
      isRedirectCheckInProgress = false;
      // ALWAYS schedule the next run, regardless of success or failure
      if (isRunning.redirectChecker) {
        console.log("Scheduling next redirect check in 60 seconds");
        checkInterval = setTimeout(runRedirectCheck, 60 * 1000);
      } else {
        console.log("Redirect checker marked as stopped, not scheduling next run");
      }
    }
  }

  // Start the first check immediately
  console.log("Running initial redirect check cycle");
  runRedirectCheck();
}

export function stopRedirectChecker() {
  isRunning.redirectChecker = false;

  // Abort current operations immediately
  if (redirectCheckerAbortController) {
    redirectCheckerAbortController.abort();
    redirectCheckerAbortController = null;
  }

  if (checkInterval) {
    clearTimeout(checkInterval);
    checkInterval = null;
  }
}

export function startTakedownMonitor(): void {
  isRunning.takedownMonitor = true;
  takedownMonitorAbortController = new AbortController();

  async function runTakedownMonitor() {
    if (!isRunning.takedownMonitor) return;

    try {
      await withAbort(monitorTakedownStatus(), takedownMonitorAbortController?.signal);
    } catch (error) {
      console.error("Error during takedown monitoring:", error);
    }

    if (!isRunning.takedownMonitor) return;

    // Schedule next run only after this one completes
    takedownInterval = setTimeout(runTakedownMonitor, 60 * 1000);
  }

  // Start the first monitoring immediately
  runTakedownMonitor();
}

export function stopTakedownMonitor(): void {
  isRunning.takedownMonitor = false;
  if (takedownInterval) {
    clearTimeout(takedownInterval);
    takedownInterval = null;
  }
  if (takedownMonitorAbortController) {
    takedownMonitorAbortController.abort();
    takedownMonitorAbortController = null;
  }
}

export function startAdHunter(enabledHunters: HunterName[] = [...HUNTER_NAMES]): void {
  if (isRunning.adHunter) return;
  isRunning.adHunter = true;
  adHunterAbortController = new AbortController();
  console.log(`Starting ad hunter service (enabled: ${enabledHunters.join(", ") || "none"})`);

  let isHuntingInProgress = false;

  async function runAdHunter() {
    // Double-check that we're still supposed to be running
    if (!isRunning.adHunter) {
      console.log("Ad hunter no longer running, stopping scheduler");
      return;
    }

    // Wait if previous cycle is still running
    if (isHuntingInProgress) {
      console.log("Previous hunt cycle still in progress, waiting...");
      adHunterInterval = setTimeout(runAdHunter, 10 * 1000);
      return;
    }

    isHuntingInProgress = true;

    try {
      adHunterAbortController?.signal.throwIfAborted();

      await logHunterEvent("scheduler", "cycle_start", "Starting hunting cycle", { enabled_hunters: enabledHunters });

      // Restart each enabled hunter's browser before the cycle
      console.log("Restarting enabled hunter browsers before cycle...");
      await logHunterEvent("scheduler", "browser_restart", "Restarting enabled hunter browsers", { enabled_hunters: enabledHunters });
      const browserRestarts: Promise<unknown>[] = [];
      if (enabledHunters.includes("search")) {
        browserRestarts.push(searchAdHunter.restartBrowser().catch(e => console.error("Error restarting SearchAdHunter browser:", e)));
      }
      if (enabledHunters.includes("typosquat")) {
        browserRestarts.push(typosquatHunter.restartBrowser().catch(e => console.error("Error restarting TyposquatHunter browser:", e)));
      }
      if (enabledHunters.includes("pornhub")) {
        browserRestarts.push(pornhubAdHunter.restartBrowser().catch(e => console.error("Error restarting PornhubAdHunter browser:", e)));
      }
      if (enabledHunters.includes("adspyglass")) {
        browserRestarts.push(adSpyGlassHunter.restartBrowser().catch(e => console.error("Error restarting AdSpyGlassHunter browser:", e)));
      }
      if (enabledHunters.includes("adsense")) {
        browserRestarts.push(adsenseHunter.restartBrowser().catch(e => console.error("Error restarting AdsenseHunter browser:", e)));
      }
      await Promise.allSettled(browserRestarts);

      console.log("Starting hunting cycle...");

      const TIMEOUT_MS = 120000; // 2 minutes
      const cycleStartTime = Date.now();

      // Log current hunter proxy IP at the start of each cycle
      await hunterProxyService.refreshIpAndLog();

      // Run hunt operations sequentially with staggered delays (2-8s between each)
      // This looks more realistic than parallel requests from the same IP
      const allHunters: {
        hunterName: HunterName;
        name: string;
        type: HunterType;
        fn: (signal: AbortSignal) => Promise<unknown>;
      }[] = [
        { hunterName: "search" as const, name: "Search ad hunting", type: "search" as const, fn: (signal: AbortSignal) => searchAdHunter.huntSearchAds(signal) },
        { hunterName: "typosquat" as const, name: "Typosquat hunting", type: "typosquat" as const, fn: (signal: AbortSignal) => typosquatHunter.huntTyposquat(signal) },
        { hunterName: "pornhub" as const, name: "Pornhub ad hunting", type: "pornhub" as const, fn: (signal: AbortSignal) => pornhubAdHunter.huntPornhubAds(signal) },
        { hunterName: "adspyglass" as const, name: "AdSpyGlass ad hunting", type: "adspyglass" as const, fn: (signal: AbortSignal) => adSpyGlassHunter.huntAdSpyGlassAds(signal) },
        { hunterName: "adsense" as const, name: "AdSense ad hunting", type: "adsense" as const, fn: (signal: AbortSignal) => adsenseHunter.huntAdsenseAds(signal) },
      ];
      const hunters = allHunters.filter(hunter => enabledHunters.includes(hunter.hunterName));

      for (let i = 0; i < hunters.length; i++) {
        const hunter = hunters[i];
        const hunterAbortController = new AbortController();
        const huntStopSignal = adHunterAbortController?.signal;
        const onHuntStop = () => hunterAbortController.abort();
        huntStopSignal?.addEventListener("abort", onHuntStop, { once: true });

        try {
          huntStopSignal?.throwIfAborted();
          await withTimeout(hunter.fn(hunterAbortController.signal), TIMEOUT_MS, hunter.name, hunterAbortController);
        } catch (error) {
          if (isAbortError(error) && !isRunning.adHunter) throw error;
          console.error(`Error during ${hunter.name}: ${(error as Error).message}`);
          logHunterEvent(hunter.type, "error", `Hunt failed: ${(error as Error).message}`);
        } finally {
          huntStopSignal?.removeEventListener("abort", onHuntStop);
        }

        // Stagger between hunters (skip delay after the last one)
        if (i < hunters.length - 1) {
          await randomDelay(2000, 8000);
        }
      }

      const cycleDurationMs = Date.now() - cycleStartTime;
      console.log("Completed ad hunting cycle");
      await logHunterEvent("scheduler", "cycle_end", `Hunting cycle completed in ${(cycleDurationMs / 1000).toFixed(1)}s`, { duration_ms: cycleDurationMs });
    } catch (error) {
      if (isAbortError(error) && !isRunning.adHunter) {
        console.log("Ad hunting cycle was cancelled");
        isHuntingInProgress = false;
        return; // Don't schedule next run
      }
      console.error("Unexpected error in ad hunter:", error);
      await logHunterEvent("scheduler", "error", `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      isHuntingInProgress = false;
      // ALWAYS schedule the next run, regardless of success or failure
      // This ensures the scheduler keeps running even if something fails
      if (isRunning.adHunter) {
        await hunterProxyService.rotate("ad hunter cycle complete");
        console.log("Scheduling next ad hunter run in 60 seconds");
        adHunterInterval = setTimeout(runAdHunter, 60 * 1000);
      } else {
        console.log("Ad hunter marked as stopped, not scheduling next run");
      }
    }
  }

  // Start the first hunt immediately
  console.log("Running initial ad hunter cycle");
  runAdHunter();
}

export function stopAdHunter() {
    isRunning.adHunter = false;

    // Abort current operations immediately
    if (adHunterAbortController) {
      adHunterAbortController.abort();
      adHunterAbortController = null;
    }

    if (adHunterInterval) {
      clearTimeout(adHunterInterval);
      adHunterInterval = null;
    }
    console.log("Ad hunter service stopped");
  }

export function startRedirectPruner(): void {
  isRunning.redirectPruner = true;

  async function runRedirectPruning() {
    if (!isRunning.redirectPruner) return;

    try {
      await pruneOldRedirects();
    } catch (error) {
      console.error("Error during redirect pruning:", error);
    }

    // Run pruning once per day (86400000 ms)
    if (isRunning.redirectPruner) {
      pruningInterval = setTimeout(runRedirectPruning, 24 * 60 * 60 * 1000);
    }
  }

  // Start the first pruning cycle immediately
  runRedirectPruning();
}

export function startEventLogPruner(): void {
  async function runEventPruning() {
    try {
      const hunterPruned = await pruneHunterEvents(7);
      const redirectPruned = await pruneRedirectEvents(7);
      const proxyPruned = await pruneProxyEvents(365);
      if (hunterPruned > 0 || redirectPruned > 0 || proxyPruned > 0) {
        console.log(`Pruned ${hunterPruned} hunter events, ${redirectPruned} redirect events, and ${proxyPruned} proxy events`);
      }
    } catch (error) {
      console.error("Error during event log pruning:", error);
    }

    // Run pruning once per day
    eventLogPrunerTimeout = setTimeout(runEventPruning, 24 * 60 * 60 * 1000);
  }

  runEventPruning();
}

export function stopEventLogPruner(): void {
  if (eventLogPrunerTimeout) {
    clearTimeout(eventLogPrunerTimeout);
    eventLogPrunerTimeout = null;
  }
}

export function stopRedirectPruner(): void {
  isRunning.redirectPruner = false;
  if (pruningInterval) {
    clearTimeout(pruningInterval);
    pruningInterval = null;
  }
}

export function startUrlscanHunter(): void {
  if (isRunning.urlscanHunter) return;
  isRunning.urlscanHunter = true;
  console.log("Starting URLScan hunter service");

  async function runUrlscanCycle() {
    if (!isRunning.urlscanHunter) return;

    try {
      await urlscanHunter.runCycle();
    } catch (error) {
      console.error("[urlscan-hunter] Scheduler error:", error);
    }

    if (isRunning.urlscanHunter) {
      urlscanInterval = setTimeout(runUrlscanCycle, 5 * 1000);
    }
  }

  runUrlscanCycle();
}

export function stopUrlscanHunter(): void {
  isRunning.urlscanHunter = false;
  if (urlscanInterval) {
    clearTimeout(urlscanInterval);
    urlscanInterval = null;
  }
  console.log("URLScan hunter service stopped");
}

export function startHashListSync(): void {
  isRunning.hashListSync = true;

  async function runHashListSync() {
    if (!isRunning.hashListSync) return;

    try {
      await syncHashLists();
    } catch (error) {
      console.error("Error syncing SafeBrowsing v5 hash lists:", error);
    }

    // Sync every 5 minutes (the service itself respects minimumWaitDuration per list)
    if (isRunning.hashListSync) {
      hashListSyncInterval = setTimeout(runHashListSync, 5 * 60 * 1000);
    }
  }

  runHashListSync();
}

export function stopHashListSync(): void {
  isRunning.hashListSync = false;
  if (hashListSyncInterval) {
    clearTimeout(hashListSyncInterval);
    hashListSyncInterval = null;
  }
}
