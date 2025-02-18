import PQueue from "p-queue";

import {reportToCrdfLabs} from "./reportService";

// Create a queue that allows 2 jobs every 60000ms (1 minute)
export const crdfLabsQueue = new PQueue({
  interval: 60000,       // interval of 1 minute
  intervalCap: 2,        // allowed 2 tasks per interval
});

// Wrap the report method to use the queue
export function queueCrdfLabsReport(site: string): Promise<void> {
  return crdfLabsQueue.add(() => reportToCrdfLabs(site));
}