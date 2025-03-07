import { checkRedirects } from './redirectMonitorService.js';
import { flushQueues } from './batchReportService.js';
import { monitorTakedownStatus } from './takedownMonitorService.js'; // Add this import

let checkInterval: NodeJS.Timeout;
let batchInterval: NodeJS.Timeout;
let takedownInterval: NodeJS.Timeout; // Add this variable

export function startRedirectChecker() {
  checkInterval = setInterval(async () => {
    try {
      await checkRedirects();
    } catch (error) {
      console.error("Error checking redirects:", error);
    }
  }, 60 * 1000);
}

export function stopRedirectChecker() {
  if (checkInterval) {
    clearInterval(checkInterval);
  }
}

// Start a scheduled job to flush queues every minute
export function startBatchReportProcessor(): void {
  batchInterval = setInterval(flushQueues, 60 * 1000);
}

export async function stopBatchReportProcessor(): Promise<void> {
  clearInterval(batchInterval);

  try {
    await flushQueues();
    console.info("Batch queues flushed successfully during shutdown.");
  } catch (error) {
    console.error("Error while flushing batch queues during shutdown:", error);
  }
}

export function startTakedownMonitor(): void {
  takedownInterval = setInterval(async () => {
    try {
      await monitorTakedownStatus();
    } catch (error) {
      console.error("Error during takedown monitoring:", error);
    }
  }, 60 * 1000);
}

export function stopTakedownMonitor(): void {
  if (takedownInterval) {
    clearInterval(takedownInterval);
  }
}