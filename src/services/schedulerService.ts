import { checkRedirects } from "./redirectMonitorService.js";
import { flushQueues } from "./batchReportService.js";
import { monitorTakedownStatus } from "./takedownMonitorService.js";
import { hunterService } from "./hunterService.js";
import { pruneOldRedirects } from "./redirectPruningService.js";

let checkInterval: NodeJS.Timeout | null = null;
let batchInterval: NodeJS.Timeout | null = null;
let takedownInterval: NodeJS.Timeout | null = null;
let adHunterInterval: NodeJS.Timeout | null = null;
let pruningInterval: NodeJS.Timeout | null = null;

let redirectCheckerAbortController: AbortController | null = null;
let adHunterAbortController: AbortController | null = null;
let takedownMonitorAbortController: AbortController | null = null;

let isRunning = {
  redirectChecker: false,
  batchProcessor: false,
  takedownMonitor: false,
  adHunter: false,
  redirectPruner: false,
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

  async function runRedirectCheck() {
    if (!isRunning.redirectChecker) return;

    try {
      redirectCheckerAbortController?.signal.throwIfAborted();
      await withAbort(checkRedirects(), redirectCheckerAbortController?.signal);
    } catch (error) {
      if (error instanceof Error && error.message === "AbortError") {
        console.log("Redirect checking was cancelled");
        return; // Don't schedule next run
      }
      console.error("Error checking redirects:", error);
    }

    // Only schedule next run if not aborted
    if (isRunning.redirectChecker) {
      checkInterval = setTimeout(runRedirectCheck, 60 * 1000);
    }
  }

  // Start the first check immediately
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
    batchInterval = setTimeout(runBatchProcess, 60 * 1000);
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

  async function runAdHunter() {
    // Double-check that we're still supposed to be running
    if (!isRunning.adHunter) {
      console.log("Ad hunter no longer running, stopping scheduler");
      return;
    }

    try {
      adHunterAbortController?.signal.throwIfAborted();

      console.log("Starting hunting cycle...");

      const TIMEOUT_MS = 120000; // 2 minutes

      // Run all hunt operations in parallel with timeouts
      const huntPromises = [
        withTimeout(
          hunterService.huntSearchAds(),
          TIMEOUT_MS,
          "Search ad hunting"
        ).catch((error) => {
          console.error(`Error during search ad hunting: ${error.message}`);
          return null;
        }),
        withTimeout(
          hunterService.huntTyposquat(),
          TIMEOUT_MS,
          "Typosquat hunting"
        ).catch((error) => {
          console.error(`Error during typosquat hunting: ${error.message}`);
          return null;
        }),
        withTimeout(
          hunterService.huntPornhubAds(),
          TIMEOUT_MS,
          "Pornhub ad hunting"
        ).catch((error) => {
          console.error(`Error during pornhub ad hunting: ${error.message}`);
          return null;
        }),
        withTimeout(
          hunterService.huntAdSpyGlassAds(),
          TIMEOUT_MS,
          "AdSpyGlass ad hunting"
        ).catch((error) => {
          console.error(`Error during AdSpyGlass ad hunting: ${error.message}`);
          return null;
        }),
        // Future hunt types can be added here
      ];

      // Race all hunt operations against abort signal
      await withAbort(
        Promise.allSettled(huntPromises),
        adHunterAbortController?.signal
      );

      console.log("Completed ad hunting cycle");
    } catch (error) {
      if (error instanceof Error && error.message === "AbortError") {
        console.log("Ad hunting cycle was cancelled");
        return; // Don't schedule next run
      }
      console.error("Unexpected error in ad hunter:", error);
    } finally {
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
    pruningInterval = setTimeout(runRedirectPruning, 24 * 60 * 60 * 1000);
  }

  // Start the first pruning cycle immediately
  runRedirectPruning();
}

export function stopRedirectPruner(): void {
  isRunning.redirectPruner = false;
  if (pruningInterval) {
    clearTimeout(pruningInterval);
    pruningInterval = null;
  }
}
