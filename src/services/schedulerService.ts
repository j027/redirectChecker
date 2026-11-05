import { checkRedirects } from "./redirectMonitorService.js";
import { monitorTakedownStatus } from "./takedownMonitorService.js";
import { searchAdHunter, typosquatHunter, pornhubAdHunter, adSpyGlassHunter, adsenseHunter, taboolaHunter, hunterService } from "./hunterService.js";
import { pruneOldRedirects } from "./redirectPruningService.js";
import { browserRedirectService } from "./browserRedirectService.js";
import { browserReportService } from "./browserReportService.js";
import { logHunterEvent, pruneHunterEvents, HunterType } from "./hunterEventLogger.js";
import { pruneRedirectEvents } from "./redirectEventLogger.js";
import { logProxyEvent, pruneProxyEvents } from "./proxyEventLogger.js";
import { urlscanHunter } from "./urlscanHunter.js";
import { syncHashLists } from "./safeBrowsingV5Service.js";
import { retryFailedMsrcReports } from "./msrcReportService.js";
import { readConfig, HUNTER_NAMES, HunterName } from "../config.js";
import { runHuntWithTimeout } from "../utils/huntLifecycle.js";
import { fetch, ProxyAgent } from "undici";

let checkInterval: NodeJS.Timeout | null = null;
let takedownInterval: NodeJS.Timeout | null = null;
let adHunterInterval: NodeJS.Timeout | null = null;
let pruningInterval: NodeJS.Timeout | null = null;
let urlscanInterval: NodeJS.Timeout | null = null;
let hashListSyncInterval: NodeJS.Timeout | null = null;
let eventLogPrunerTimeout: NodeJS.Timeout | null = null;
let msrcRetryTimeout: NodeJS.Timeout | null = null;

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
  msrcRetrySweep: false,
};

/** Returns a random delay between min and max milliseconds */
function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, delay));
}

/** Logs the current IP seen through the hunter proxy */
async function logHunterProxyIp(): Promise<void> {
  try {
    const config = await readConfig();
    const response = await fetch("https://api.ipify.org?format=json", {
      dispatcher: new ProxyAgent(config.hunterProxy),
      signal: AbortSignal.timeout(60000),
    });

    const data = (await response.json()) as { ip?: string };
    if (!data.ip) {
      console.error("Failed to log hunter proxy IP");
      await logProxyEvent("error", "Failed to reach hunter proxy during IP check");
      return;
    }

    console.log(`Hunter proxy IP: ${data.ip}`);
    await logProxyEvent("ip_check", `Hunter proxy IP: ${data.ip}`, { ipAddress: data.ip });
  } catch (error) {
    console.error(`Failed to log hunter proxy IP: ${error}`);
    await logProxyEvent("error", `Failed to reach hunter proxy during IP check`);
  }
}

/** Triggers hunter proxy IP rotation if a rotation URL is configured */
async function rotateHunterProxyIp(reason: string): Promise<void> {
  // Let any in-flight Safe Browsing report finish before the oroxy rotates,
  // otherwise the submission is cut mid-flight.
  await browserReportService.pauseForRotation();

  try {
    const config = await readConfig();
    if (!config.hunterProxyRotationUrl) return;

    const response = await fetch(config.hunterProxyRotationUrl, {
      signal: AbortSignal.timeout(300000),
    });
    console.log(`Hunter proxy rotation triggered: ${response.status}`);
    await logProxyEvent("rotation", `Proxy rotation triggered (${reason})`, {
      statusCode: response.status,
    });
  } catch (error) {
    console.error(`Failed to rotate hunter proxy IP: ${error}`);
    await logProxyEvent("error", `Proxy rotation failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    browserReportService.resume();
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
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
        checkRedirects(),
        REDIRECT_CHECK_TIMEOUT_MS,
        "Redirect check cycle"
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
  const activeHunts = new Set<Promise<unknown>>();

  const hunterBrowsers: Partial<
    Record<HunterName, { name: string; restart: () => Promise<void> }>
  > = {
    search: { name: "SearchAdHunter", restart: () => searchAdHunter.restartBrowser() },
    typosquat: { name: "TyposquatHunter", restart: () => typosquatHunter.restartBrowser() },
    pornhub: { name: "PornhubAdHunter", restart: () => pornhubAdHunter.restartBrowser() },
    adspyglass: { name: "AdSpyGlassHunter", restart: () => adSpyGlassHunter.restartBrowser() },
    adsense: { name: "AdsenseHunter", restart: () => adsenseHunter.restartBrowser() },
    taboola: { name: "TaboolaHunter", restart: () => taboolaHunter.restartBrowser() },
  };

  /**
   * Closes the browsers used by a timed-out hunt. Closing the browser aborts
   * pending page operations, which lets the original hunt promise reject and
   * settle instead of continuing in the background.
   */
  async function cancelHunt(hunterName: HunterName): Promise<void> {
    const cancellations: Promise<void>[] = [hunterService.cancel()];

    switch (hunterName) {
      case "search":
        cancellations.push(searchAdHunter.cancel());
        break;
      case "typosquat":
        cancellations.push(typosquatHunter.cancel());
        break;
      case "pornhub":
        cancellations.push(pornhubAdHunter.cancel());
        break;
      case "adspyglass":
        cancellations.push(adSpyGlassHunter.cancel());
        break;
      case "adsense":
        cancellations.push(adsenseHunter.cancel());
        break;
      case "taboola":
        cancellations.push(taboolaHunter.cancel());
        break;
    }

    await Promise.allSettled(cancellations);
  }

  /**
   * Restarts browsers only after all hunts have settled. This keeps the
   * proactive "fresh browser every cycle" behavior without closing a browser
   * underneath an in-flight hunt.
   */
  async function restartEnabledHunterBrowsers(): Promise<void> {
    if (!isRunning.adHunter) {
      return;
    }

    if (activeHunts.size > 0) {
      console.warn(
        `Skipping browser restart while ${activeHunts.size} hunt(s) are still active`
      );
      return;
    }

    console.log("Restarting hunter browsers after cycle...");
    await logHunterEvent(
      "scheduler",
      "browser_restart",
      "Restarting hunter browsers after cycle",
      { enabled_hunters: enabledHunters }
    );

    // Shared browser used by hunterService.processAd().
    try {
      await hunterService.restartBrowser();
    } catch (error) {
      console.error("Error restarting shared hunter service browser:", error);
    }

    for (const hunterName of enabledHunters) {
      const entry = hunterBrowsers[hunterName];
      if (entry == null) {
        continue;
      }

      try {
        await entry.restart();
      } catch (error) {
        console.error(`Error restarting ${entry.name} browser:`, error);
      }

      await randomDelay(500, 1500);
    }

    console.log("Hunter browser restart complete");
  }

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

    // A timed-out hunt may still be settling after cancellation. Do not start
    // another cycle on top of it.
    if (activeHunts.size > 0) {
      console.log(
        `Waiting for ${activeHunts.size} previous hunt(s) to settle before starting another cycle...`
      );
      adHunterInterval = setTimeout(runAdHunter, 10 * 1000);
      return;
    }

    isHuntingInProgress = true;

    try {
      adHunterAbortController?.signal.throwIfAborted();

      await logHunterEvent("scheduler", "cycle_start", "Starting hunting cycle", { enabled_hunters: enabledHunters });

      console.log("Starting hunting cycle...");

      const TIMEOUT_MS = 120000; // 2 minutes
      const cycleStartTime = Date.now();

      // Log current hunter proxy IP at the start of each cycle
      await logHunterProxyIp();

      // Run hunt operations sequentially with staggered delays (2-8s between each)
      // This looks more realistic than parallel requests from the same IP
      const allHunters: {
        hunterName: HunterName;
        name: string;
        type: HunterType;
        fn: () => Promise<unknown>;
        cancel: () => Promise<void>;
        timeoutMs?: number;
      }[] = [
        { hunterName: "search" as const, name: "Search ad hunting", type: "search" as const, fn: () => searchAdHunter.huntSearchAds(), cancel: () => cancelHunt("search") },
        { hunterName: "typosquat" as const, name: "Typosquat hunting", type: "typosquat" as const, fn: () => typosquatHunter.huntTyposquat(), cancel: () => cancelHunt("typosquat") },
        { hunterName: "pornhub" as const, name: "Pornhub ad hunting", type: "pornhub" as const, fn: () => pornhubAdHunter.huntPornhubAds(), cancel: () => cancelHunt("pornhub") },
        { hunterName: "adspyglass" as const, name: "AdSpyGlass ad hunting", type: "adspyglass" as const, fn: () => adSpyGlassHunter.huntAdSpyGlassAds(), cancel: () => cancelHunt("adspyglass") },
        { hunterName: "adsense" as const, name: "AdSense ad hunting", type: "adsense" as const, fn: () => adsenseHunter.huntAdsenseAds(), cancel: () => cancelHunt("adsense"), timeoutMs: 150000 },
        { hunterName: "taboola" as const, name: "Taboola ad hunting", type: "taboola" as const, fn: () => taboolaHunter.huntTaboolaAds(), cancel: () => cancelHunt("taboola"), timeoutMs: 180000 },
      ];
      const hunters = allHunters.filter(hunter => enabledHunters.includes(hunter.hunterName));

      for (let i = 0; i < hunters.length; i++) {
        const hunter = hunters[i];

        try {
          adHunterAbortController?.signal.throwIfAborted();

          const huntPromise = Promise.resolve().then(() => hunter.fn());
          activeHunts.add(huntPromise);
          const removeHunt = () => activeHunts.delete(huntPromise);
          huntPromise.then(removeHunt, removeHunt);

          const hunterStartTime = Date.now();
          await runHuntWithTimeout(() => huntPromise, {
            name: hunter.name,
            timeoutMs: hunter.timeoutMs ?? TIMEOUT_MS,
            cancel: hunter.cancel,
          });
          console.log(
            `Completed ${hunter.name} in ${((Date.now() - hunterStartTime) / 1000).toFixed(1)}s`
          );
        } catch (error) {
          if (isAbortError(error) && !isRunning.adHunter) throw error;
          console.error(`Error during ${hunter.name}: ${(error as Error).message}`);
          await logHunterEvent(hunter.type, "error", `Hunt failed: ${(error as Error).message}`);

          // A cancellation that never settled means the abandoned hunt is
          // still using a browser. Do not start another hunter on top of it.
          if (activeHunts.size > 0) {
            console.error(
              "A hunt is still active after cancellation; stopping this cycle before starting the next hunter"
            );
            break;
          }
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
        await restartEnabledHunterBrowsers();
        await rotateHunterProxyIp("ad hunter cycle complete");
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

export function startMsrcRetrySweep(): void {
  isRunning.msrcRetrySweep = true;

  async function runMsrcRetrySweep() {
    if (!isRunning.msrcRetrySweep) return;

    try {
      await retryFailedMsrcReports();
    } catch (error) {
      console.error("Error during MSRC retry sweep:", error);
    }

    if (isRunning.msrcRetrySweep) {
      msrcRetryTimeout = setTimeout(runMsrcRetrySweep, 10 * 60 * 1000);
    }
  }

  runMsrcRetrySweep();
}

export function stopMsrcRetrySweep(): void {
  isRunning.msrcRetrySweep = false;
  if (msrcRetryTimeout) {
    clearTimeout(msrcRetryTimeout);
    msrcRetryTimeout = null;
  }
}
