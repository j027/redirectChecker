import { checkRedirects } from './redirectMonitorService.js';
import { flushQueues } from './batchReportService.js';
import { monitorTakedownStatus } from './takedownMonitorService.js';

let checkInterval: NodeJS.Timeout | null = null;
let batchInterval: NodeJS.Timeout | null = null;
let takedownInterval: NodeJS.Timeout | null = null;
let isRunning = {
  redirectChecker: false,
  batchProcessor: false,
  takedownMonitor: false
};

export function startRedirectChecker() {
  isRunning.redirectChecker = true;
  
  async function runRedirectCheck() {
    if (!isRunning.redirectChecker) return;
    
    try {
      await checkRedirects();
    } catch (error) {
      console.error("Error checking redirects:", error);
    }
    
    // Schedule next run only after this one completes
    checkInterval = setTimeout(runRedirectCheck, 60 * 1000);
  }
  
  // Start the first check immediately
  runRedirectCheck();
}

export function stopRedirectChecker() {
  isRunning.redirectChecker = false;
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
      await monitorTakedownStatus();
    } catch (error) {
      console.error("Error during takedown monitoring:", error);
    }
    
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
}