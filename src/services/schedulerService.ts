import { checkRedirects } from "./redirectMonitorService.js";
import { flushQueues } from "./batchReportService.js";
import { monitorTakedownStatus } from "./takedownMonitorService.js";
import { searchAdHunter, typosquatHunter, pornhubAdHunter, adSpyGlassHunter } from "./hunterService.js";
import { pruneOldRedirects } from "./redirectPruningService.js";
import { browserRedirectService } from "./browserRedirectService.js";
import { logHunterEvent, pruneHunterEvents } from "./hunterEventLogger.js";
import { pruneRedirectEvents } from "./redirectEventLogger.js";
import { urlscanHunter } from "./urlscanHunter.js";
import { syncHashLists } from "./safeBrowsingV5Service.js";

let checkInterval: NodeJS.Timeout | null = null;
let batchInterval: NodeJS.Timeout | null = null;
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
  batchProcessor: false,
  takedownMonitor: false,
  adHunter: false,
  redirectPruner: false,
  urlscanHunter: false,
  hashListSync: false,
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(`Operation ${operationName} timed out after ${timeoutMs}ms`)
        );
      }, timeoutMs);
    }),
  ]);
}

async function withAbort<T>(
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

    try {
      redirectCheckerAbortController?.signal.throwIfAborted();
      
      // Restart browser before each run to clear lingering state
      console.log("Restarting redirect checker browser before cycle...");
      try {
        await withTimeout(
          browserRedirectService.restartBrowser(),
          30000,
          "Redirect checker browser restart"
        );
      } catch (error) {
        console.error("Error restarting redirect checker browser:", error);
      }
      
      const REDIRECT_CHECK_TIMEOUT_MS = 180000; // 3 minutes
      await withAbort(
        withTimeout(checkRedirects(), REDIRECT_CHECK_TIMEOUT_MS, "Redirect check cycle"),
        redirectCheckerAbortController?.signal
      );

      const cycleDurationMs = Date.now() - cycleStartTime;
      console.log(`Completed redirect check cycle in ${(cycleDurationMs / 1000).toFixed(1)}s`);
    } catch (error) {
      if (error instanceof Error && error.message === "AbortError") {
        console.log("Redirect checking was cancelled");
        isRedirectCheckInProgress = false;
        return; // Don't schedule next run
      }
      const cycleDurationMs = Date.now() - cycleStartTime;
      console.error(`Error checking redirects after ${(cycleDurationMs / 1000).toFixed(1)}s:`, error);
    } finally {
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

export function startBatchReportProcessor(): void {
  isRunning.batchProcessor = true;

  async function runBatchProcess() {
    if (!isRunning.batchProcessor) return;

    try {
      await flushQueues();
    } catch (error) {
      console.error("Error flushing queues:", error);
    }

    // Schedule next run only after this one completes
    if (isRunning.batchProcessor) {
      batchInterval = setTimeout(runBatchProcess, 60 * 1000);
    }
  }

  // Start the first batch process immediately
  runBatchProcess();
}

export async function stopBatchReportProcessor(): Promise<void> {
  isRunning.batchProcessor = false;
  if (batchInterval) {
    clearTimeout(batchInterval);
    batchInterval = null;
  }

  try {
    await flushQueues();
    console.info("Batch queues flushed successfully during shutdown.");
  } catch (error) {
    console.error("Error while flushing batch queues during shutdown:", error);
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

export function startAdHunter(): void {
  if (isRunning.adHunter) return;
  isRunning.adHunter = true;
  adHunterAbortController = new AbortController();
  console.log("Starting ad hunter service");

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

      await logHunterEvent("scheduler", "cycle_start", "Starting hunting cycle");

      // Restart each hunter's browser before the cycle
      console.log("Restarting all hunter browsers before cycle...");
      await logHunterEvent("scheduler", "browser_restart", "Restarting all hunter browsers");
      await Promise.allSettled([
        searchAdHunter.restartBrowser().catch(e => console.error("Error restarting SearchAdHunter browser:", e)),
        typosquatHunter.restartBrowser().catch(e => console.error("Error restarting TyposquatHunter browser:", e)),
        pornhubAdHunter.restartBrowser().catch(e => console.error("Error restarting PornhubAdHunter browser:", e)),
        adSpyGlassHunter.restartBrowser().catch(e => console.error("Error restarting AdSpyGlassHunter browser:", e)),
      ]);

      console.log("Starting hunting cycle...");

      const TIMEOUT_MS = 120000; // 2 minutes
      const cycleStartTime = Date.now();

      // Run all hunt operations in parallel with timeouts - each with their own browser
      const huntPromises = [
        withTimeout(
          searchAdHunter.huntSearchAds(),
          TIMEOUT_MS,
          "Search ad hunting"
        ).catch((error) => {
          console.error(`Error during search ad hunting: ${error.message}`);
          logHunterEvent("search", "error", `Hunt failed: ${error.message}`);
          return null;
        }),
        withTimeout(
          typosquatHunter.huntTyposquat(),
          TIMEOUT_MS,
          "Typosquat hunting"
        ).catch((error) => {
          console.error(`Error during typosquat hunting: ${error.message}`);
          logHunterEvent("typosquat", "error", `Hunt failed: ${error.message}`);
          return null;
        }),
        withTimeout(
          pornhubAdHunter.huntPornhubAds(),
          TIMEOUT_MS,
          "Pornhub ad hunting"
        ).catch((error) => {
          console.error(`Error during pornhub ad hunting: ${error.message}`);
          logHunterEvent("pornhub", "error", `Hunt failed: ${error.message}`);
          return null;
        }),
        withTimeout(
          adSpyGlassHunter.huntAdSpyGlassAds(),
          TIMEOUT_MS,
          "AdSpyGlass ad hunting"
        ).catch((error) => {
          console.error(`Error during AdSpyGlass ad hunting: ${error.message}`);
          logHunterEvent("adspyglass", "error", `Hunt failed: ${error.message}`);
          return null;
        }),
        // Future hunt types can be added here
      ];

      // Race all hunt operations against abort signal
      await withAbort(
        Promise.allSettled(huntPromises),
        adHunterAbortController?.signal
      );

      const cycleDurationMs = Date.now() - cycleStartTime;
      console.log("Completed ad hunting cycle");
      await logHunterEvent("scheduler", "cycle_end", `Hunting cycle completed in ${(cycleDurationMs / 1000).toFixed(1)}s`, { duration_ms: cycleDurationMs });
    } catch (error) {
      if (error instanceof Error && error.message === "AbortError") {
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
      if (hunterPruned > 0 || redirectPruned > 0) {
        console.log(`Pruned ${hunterPruned} hunter events and ${redirectPruned} redirect events`);
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
