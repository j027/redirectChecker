import { checkRedirects } from './redirectMonitorService';
import { flushQueues } from './batchReportService';

let checkInterval: NodeJS.Timeout;
let batchInterval: NodeJS.Timeout;

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