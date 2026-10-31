/**
 * Capture-only Taboola network discovery for Yahoo Mail.
 *
 * Opens Yahoo Mail with the saved session, records every request/response
 * whose URL mentions Taboola, and saves JSON/text bodies. It never clicks an
 * ad, writes to the database, sends alerts, or reports anything.
 *
 * Usage:
 *   yarn tsx scripts/taboola-network.ts
 *   yarn tsx scripts/taboola-network.ts --seconds=45
 */
import { promises as fs } from "fs";
import path from "path";
import { Browser, Response } from "patchright";
import { BrowserManagerService } from "../src/services/browserManagerService.js";
import {
  parseProxy,
  spoofWindowsChrome,
} from "../src/utils/playwrightUtilities.js";

const SESSION_FILE = path.join(process.cwd(), "data", "yahoo", "session.json");
const OUTPUT_ROOT = path.join(process.cwd(), "data", "taboola", "network");

type StorageState = NonNullable<
  Parameters<Browser["newContext"]>[0]
>["storageState"];

interface CapturedResponse {
  url: string;
  status: number;
  contentType: string;
  bodyFile?: string;
  bodyPreview?: string;
}

function readSeconds(): number {
  const argument = process.argv.find((value) =>
    value.startsWith("--seconds=")
  );
  if (argument == null) {
    return 35;
  }
  const value = Number.parseInt(argument.split("=")[1] ?? "", 10);
  return Number.isFinite(value) && value >= 5 ? value : 35;
}

function isTaboolaUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return (
      hostname.includes("taboola") ||
      hostname.includes("tblcontent") ||
      hostname.endsWith(".tbl")
    );
  } catch {
    return false;
  }
}

async function loadSession(): Promise<StorageState> {
  try {
    return JSON.parse(await fs.readFile(SESSION_FILE, "utf8")) as StorageState;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const seconds = readSeconds();
  const runDir = path.join(
    OUTPUT_ROOT,
    new Date().toISOString().replace(/[:.]/g, "-")
  );
  await fs.mkdir(runDir, { recursive: true });

  const browser = await BrowserManagerService.createBrowser(false);
  const context = await browser.newContext({
    proxy: await parseProxy("hunter"),
    storageState: await loadSession(),
    viewport: null,
  });
  const page = await context.newPage();

  const requests: Array<{
    method: string;
    url: string;
    resourceType: string;
    postData?: string;
  }> = [];
  const responses: CapturedResponse[] = [];
  let index = 0;

  page.on("request", (request) => {
    if (!isTaboolaUrl(request.url())) {
      return;
    }
    requests.push({
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      postData: request.postData() ?? undefined,
    });
    console.log(`REQ ${request.method()} ${request.url()}`);
  });

  page.on("response", (response: Response) => {
    if (!isTaboolaUrl(response.url())) {
      return;
    }
    void (async () => {
      const contentType = response.headers()["content-type"] ?? "";
      const entry: CapturedResponse = {
        url: response.url(),
        status: response.status(),
        contentType,
      };

      try {
        if (/json|text|javascript/i.test(contentType)) {
          const body = await response.text();
          if (body.length <= 2_000_000) {
            const file = path.join(runDir, `response-${index++}.txt`);
            await fs.writeFile(file, body);
            entry.bodyFile = file;
            entry.bodyPreview = body.slice(0, 300);
          }
        }
      } catch {
        // Body may not be available (redirect, stream, etc.).
      }

      responses.push(entry);
      console.log(
        `RES ${response.status()} ${contentType} ${response.url()}` +
          (entry.bodyFile ? ` -> ${entry.bodyFile}` : "")
      );
    })();
  });

  try {
    await spoofWindowsChrome(context, page);
    await page.goto("https://mail.yahoo.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(5_000);
    console.log("URL:", page.url());

    await page.mouse.move(900, 400).catch(() => {});
    await page.waitForTimeout(3_000);
    await page.mouse.wheel(0, 800).catch(() => {});
    await page.waitForTimeout(1_500);
    await page.mouse.wheel(0, -800).catch(() => {});
    await page.waitForTimeout(seconds * 1_000);

    const summary = {
      generatedAt: new Date().toISOString(),
      pageUrl: page.url(),
      requests,
      responses,
    };
    const summaryPath = path.join(runDir, "summary.json");
    await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`\nSaved network capture to ${summaryPath}`);
    console.log(`Requests: ${requests.length}, responses: ${responses.length}`);

    const hosts = new Map<string, number>();
    for (const request of requests) {
      const hostname = new URL(request.url).hostname;
      hosts.set(hostname, (hosts.get(hostname) ?? 0) + 1);
    }
    for (const [hostname, count] of [...hosts.entries()].sort(
      (a, b) => b[1] - a[1]
    )) {
      console.log(`${String(count).padStart(4)}  ${hostname}`);
    }
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
