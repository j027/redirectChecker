import { Browser, BrowserContext, Locator, Page } from "patchright";
import { promises as fs } from "fs";
import { setTimeout } from "timers/promises";
import path from "path";
import { readConfig } from "../config.js";
import { parseProxy, spoofWindowsChrome } from "../utils/playwrightUtilities.js";
import { BrowserManagerService } from './browserManagerService.js';
import {
  ReportContext,
  abandonStaleReports,
  finishReport,
  logSkippedReport,
  markReportStarted,
  reportInput,
  startReport,
  trackReport,
  updateReportProgress,
} from "./reportLogService.js";

const SMARTSCREEN_REPORT_URL =
  "https://www.microsoft.com/en-us/wdsi/support/report-unsafe-site";

const SAFE_BROWSING_REPORT_URL =
  "https://safebrowsing.google.com/safebrowsing/report-url";

const SAFE_BROWSING_MAX_ATTEMPTS = 3;
const SAFE_BROWSING_RETRY_BASE_DELAY_MS = 30_000;
const SAFE_BROWSING_SUCCESS_TIMEOUT_MS = 60_000;

// Cookies for the reporting account. Git-ignored with the rest of data/.
const SESSION_FILE = path.join(process.cwd(), "data", "smartscreen", "session.json");
const FAILURE_SCREENSHOT_DIR = path.join(process.cwd(), "data", "smartscreen");
const SAFE_BROWSING_SCREENSHOT_DIR = path.join(process.cwd(), "data", "safebrowsing");

type StorageState = NonNullable<
  Parameters<Browser["newContext"]>[0]
>["storageState"];

// How long to keep clearing optional Microsoft login prompts before giving up.
const LOGIN_SETTLE_TIMEOUT_MS = 25000;

export type SafeBrowsingReportStatus = "success" | "captcha" | "blocked" | "error";

interface SafeBrowsingReportTask {
  url: string;
  details: string;
  attempts: number;
  submissionId: number | null;
}

export class BrowserReportService {
  private browser: Browser | null;
  private context: BrowserContext | null;
  private browserInitializing: boolean;
  private safeBrowsingContext: BrowserContext | null;
  private safeBrowsingQueue: SafeBrowsingReportTask[];
  private safeBrowsingPendingUrls: Set<string>;
  private safeBrowsingProcessing: boolean;
  private safeBrowsingInFlight: Promise<void> | null;
  private safeBrowsingActiveTask: SafeBrowsingReportTask | null;
  private safeBrowsingStopped: boolean;
  private safeBrowsingPaused: boolean;
  private safeBrowsingCounters: {
    submitted: number;
    captcha: number;
    blocked: number;
    gaveUp: number;
  };

  constructor() {
    this.browser = null;
    this.context = null;
    this.browserInitializing = false;
    this.safeBrowsingContext = null;
    this.safeBrowsingQueue = [];
    this.safeBrowsingPendingUrls = new Set();
    this.safeBrowsingProcessing = false;
    this.safeBrowsingInFlight = null;
    this.safeBrowsingActiveTask = null;
    this.safeBrowsingStopped = false;
    this.safeBrowsingPaused = false;
    this.safeBrowsingCounters = { submitted: 0, captcha: 0, blocked: 0, gaveUp: 0 };
  }

  async init() {
    await this.ensureBrowserIsHealthy();
  }

  private async ensureBrowserIsHealthy(): Promise<void> {
    await BrowserManagerService.ensureBrowserHealth(
      this.browser,
      this.browserInitializing,
      async () => {
        try {
          this.browserInitializing = true;

          // Close existing browser if any
          await BrowserManagerService.closeBrowser(this.browser);
          this.context = null;

          // Create new browser
          this.browser = await BrowserManagerService.createBrowser(false);
          console.log("Browser report service initialized new browser");
        } finally {
          this.browserInitializing = false;
        }
      }
    );
  }

  /**
   * Reuses the single browser context so a signed-in session survives across
   * reports. The context is recreated if the browser was restarted.
   */
  private async getContext(): Promise<BrowserContext> {
    if (this.context != null) {
      return this.context;
    }

    const browser = this.browser;
    if (browser == null) {
      throw new Error("Browser has not been initialized - reporting to smartscreen failed");
    }

    this.context = await browser.newContext({
      storageState: await this.loadStoredSession(),
    });
    return this.context;
  }

  async reportToSmartScreen(
    url: string,
    reportContext?: ReportContext
  ): Promise<boolean> {
    const outcome = await trackReport(
      reportInput("smartscreen", "threat_intel", url, reportContext),
      async () => {
        await this.ensureBrowserIsHealthy();

        if (this.browser == null) {
          console.error(
            "Browser has not been initialized - reporting to smartscreen failed",
          );
          return { status: "error", errorMessage: "Browser not initialized" };
        }

        const browserContext = await this.getContext();
        const page = await browserContext.newPage();

        try {
          await spoofWindowsChrome(browserContext, page);
          await page.goto(SMARTSCREEN_REPORT_URL);

          if (!(await this.isReportFormAvailable(page))) {
            const signedIn = await this.signIn(page);
            if (signedIn) {
              await this.saveSession(browserContext);
            }
          }

          // Fill out the report form. The form fields are custom widgets that only
          // update their model on real keystrokes, so keep pressSequentially here.
          await page.getByLabel("Which site do you want to report?").pressSequentially(url, { delay: 20 });
          await page.getByText("Malware or other threats").check();
          await page.getByRole("button", { name: "Submit" }).click();

          // ensure that the submission was successful
          await page.getByText("Thank you for your submission").waitFor({ timeout: 30000 });
          console.log(`Successfully reported to microsoft smartscreen: ${url}`);
          return { status: "success" };
        } catch (error) {
          console.error(`Error when reporting to microsoft smartscreen (${url}): ${error}`);
          const screenshot = await this.takeFailureScreenshot(page, url);
          return {
            status: "error",
            errorMessage: String(error),
            metadata: screenshot ? { screenshot_path: screenshot } : {},
          };
        } finally {
          await page.close().catch(() => {});
        }
      }
    );

    return outcome.status === "success";
  }

  /**
   * Reports a URL through the Google Safe Browsing web form
   * (https://safebrowsing.google.com/safebrowsing/report-url). The form uses
   * an invisible reCAPTCHA that passes for a normal headful Chrome; a shown
   * challenge or an absent reCAPTCHA token is terminal and not retried.
   */
  async reportToGoogleSafeBrowsing(
    url: string,
    details?: string
  ): Promise<SafeBrowsingReportStatus> {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null) {
      console.error(
        "[safe-browsing] browser has not been initialized - report failed",
      );
      return "error";
    }

    const context = await this.getSafeBrowsingContext();
    const page = await context.newPage();

    try {
      await spoofWindowsChrome(context, page);
      await page.goto(SAFE_BROWSING_REPORT_URL);

      await this.selectSafeBrowsingOption(page, "Report Type", "This page is not safe");
      await this.selectSafeBrowsingOption(page, "Threat Type", "Social Engineering");
      await this.selectSafeBrowsingOption(page, "Threat Category", "Fake Support Scam");

      await page.getByLabel("URL to report").pressSequentially(url, { delay: 10 });
      if (details) {
        await page.getByLabel("Additional details").pressSequentially(details.slice(0, 800), { delay: 2 });
      }

      await page.getByRole("button", { name: "Submit" }).click();

      const outcome = await this.waitForSafeBrowsingOutcome(page);

      if (outcome === "captcha") {
        const screenshot = await this.takeFailureScreenshot(page, url, "safebrowsing_captcha", SAFE_BROWSING_SCREENSHOT_DIR);
        console.error(
          `[safe-browsing] reCAPTCHA CHALLENGE for ${url} - not retrying (unsolvable)` +
            (screenshot ? `; screenshot: ${screenshot}` : ""),
        );
        return "captcha";
      }

      if (outcome === "blocked") {
        const screenshot = await this.takeFailureScreenshot(page, url, "safebrowsing_captcha", SAFE_BROWSING_SCREENSHOT_DIR);
        console.error(
          `[safe-browsing] reCAPTCHA did not issue a token for ${url} - not retrying` +
            (screenshot ? `; screenshot: ${screenshot}` : ""),
        );
        return "blocked";
      }

      if (outcome === "rejected") {
        const screenshot = await this.takeFailureScreenshot(page, url, "safebrowsing_failure", SAFE_BROWSING_SCREENSHOT_DIR);
        console.error(
          `[safe-browsing] submission was rejected for ${url} (retryable)` +
            (screenshot ? `; screenshot: ${screenshot}` : ""),
        );
        return "error";
      }

      if (outcome === "error") {
        const screenshot = await this.takeFailureScreenshot(page, url, "safebrowsing_failure", SAFE_BROWSING_SCREENSHOT_DIR);
        console.error(
          `[safe-browsing] submission timed out for ${url}` +
            (screenshot ? ` (screenshot: ${screenshot})` : ""),
        );
        return "error";
      }

      return "success";
    } catch (error) {
      const screenshot = await this.takeFailureScreenshot(page, url, "safebrowsing_failure", SAFE_BROWSING_SCREENSHOT_DIR);
      console.error(
        `[safe-browsing] error while reporting ${url}: ${error}` +
          (screenshot ? ` (screenshot: ${screenshot})` : ""),
      );
      return "error";
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Waits for the Safe Browsing form to resolve. Resolves "success" on the
   * confirmation banner and "captcha" when the challenge iframe appears. On
   * timeout an absent reCAPTCHA token means the invisible challenge never
   * resolved ("blocked"); anything else is a retryable "error".
   */
  private async waitForSafeBrowsingOutcome(
    page: Page
  ): Promise<"success" | "captcha" | "blocked" | "rejected" | "error"> {
    const success = page
      .getByText("Submission was successful")
      .first()
      .waitFor({ state: "visible", timeout: SAFE_BROWSING_SUCCESS_TIMEOUT_MS })
      .then(() => "success" as const);

    const challenge = page
      .locator('iframe[src*="bframe"], iframe[title*="challenge" i]')
      .first()
      .waitFor({ state: "visible", timeout: SAFE_BROWSING_SUCCESS_TIMEOUT_MS })
      .then(() => "captcha" as const);

    const rejected = page
      .getByText("Something went wrong")
      .first()
      .waitFor({ state: "visible", timeout: SAFE_BROWSING_SUCCESS_TIMEOUT_MS })
      .then(() => "rejected" as const);

    const outcome = await Promise.race([success, challenge, rejected]).catch(
      () => "timeout" as const
    );

    if (outcome !== "timeout") {
      return outcome;
    }

    const tokenLength = await page
      .evaluate(() => {
        const el = document.querySelector<HTMLTextAreaElement>(
          'textarea[name="g-recaptcha-response"]'
        );
        return el ? el.value.length : -1;
      })
      .catch(() => -1);

    return tokenLength > 0 ? "error" : "blocked";
  }

  private async selectSafeBrowsingOption(
    page: Page,
    fieldLabel: string,
    optionName: string
  ): Promise<void> {
    const field = page.getByLabel(fieldLabel);
    await field.waitFor({ state: "visible" });
    await field.click();
    await page.locator("mat-option").filter({ hasText: optionName }).first().click();
  }

  /**
   * Reuses the Safe Browsing context across reports so cookies and reCAPTCHA
   * state survive, recreating it when the shared browser has been restarted.
   */
  private async getSafeBrowsingContext(): Promise<BrowserContext> {
    const browser = this.browser;
    if (browser == null) {
      throw new Error(
        "Browser has not been initialized - reporting to safe browsing failed",
      );
    }

    if (this.safeBrowsingContext != null && this.safeBrowsingContext.browser() === browser) {
      return this.safeBrowsingContext;
    }

    if (this.safeBrowsingContext != null) {
      await this.safeBrowsingContext.close().catch(() => {});
      this.safeBrowsingContext = null;
    }

    this.safeBrowsingContext = await browser.newContext({
      proxy: await parseProxy("hunter"),
    });
    console.log("Safe browsing report context created (hunter proxy)");
    return this.safeBrowsingContext;
  }

  /**
   * Waits for the in-flight Safe Browsing report (if any) to finish so the
   * hunter proxy can rotate without cutting a submission mid-flight.
   */
  async pauseForRotation(timeoutMs: number = 60000): Promise<void> {
    this.safeBrowsingPaused = true;

    const inFlight = this.safeBrowsingInFlight;
    if (inFlight != null) {
      await Promise.race([inFlight, setTimeout(timeoutMs)]).catch(() => {});
    }
  }

  resume(): void {
    this.safeBrowsingPaused = false;
  }

  private async waitWhileSafeBrowsingPaused(): Promise<void> {
    while (this.safeBrowsingPaused && !this.safeBrowsingStopped) {
      await setTimeout(500);
    }
  }

  /**
   * Queues a Google Safe Browsing browser report. A single worker submits
   * reports sequentially; transient failures are retried with backoff while
   * captcha blocks are terminal and logged for visibility.
   */
  async enqueueSafeBrowsingReport(
    url: string,
    details: string,
    reportContext?: ReportContext
  ): Promise<void> {
    const input = reportInput(
      "safe_browsing_web_form",
      "threat_intel",
      url,
      reportContext
    );

    if (this.safeBrowsingStopped) {
      await logSkippedReport(input, "service_stopped");
      return;
    }

    if (this.safeBrowsingPendingUrls.has(url)) {
      console.log(`[safe-browsing] ${url} is already queued, skipping duplicate`);
      await logSkippedReport(input, "already_queued");
      return;
    }

    const submissionId = await startReport(input, { startedAt: null });

    this.safeBrowsingPendingUrls.add(url);
    this.safeBrowsingQueue.push({ url, details, attempts: 0, submissionId });
    console.log(`[safe-browsing] queued report for ${url} (${this.safeBrowsingQueue.length} in queue)`);
    void this.processSafeBrowsingQueue();
  }

  private async processSafeBrowsingQueue(): Promise<void> {
    if (this.safeBrowsingProcessing || this.safeBrowsingStopped) {
      return;
    }

    this.safeBrowsingProcessing = true;
    try {
      while (this.safeBrowsingQueue.length > 0 && !this.safeBrowsingStopped) {
        await this.waitWhileSafeBrowsingPaused();
        if (this.safeBrowsingStopped) {
          break;
        }

        const task = this.safeBrowsingQueue.shift()!;
        task.attempts++;
        this.safeBrowsingActiveTask = task;
        await markReportStarted(task.submissionId);

        const run = (async () => {
          const status = await this.reportToGoogleSafeBrowsing(task.url, task.details);
          await this.handleSafeBrowsingResult(task, status);
        })();

        this.safeBrowsingInFlight = run;
        try {
          await run;
        } finally {
          this.safeBrowsingInFlight = null;
          this.safeBrowsingActiveTask = null;
        }
      }
    } finally {
      this.safeBrowsingProcessing = false;
    }
  }

  private async handleSafeBrowsingResult(
    task: SafeBrowsingReportTask,
    status: SafeBrowsingReportStatus
  ): Promise<void> {
    if (status === "success") {
      this.safeBrowsingPendingUrls.delete(task.url);
      this.safeBrowsingCounters.submitted++;
      await finishReport(task.submissionId, {
        status: "success",
        metadata: { attempts: task.attempts },
      });
      console.log(
        `[safe-browsing] report succeeded for ${task.url} (attempt ${task.attempts}/${SAFE_BROWSING_MAX_ATTEMPTS})`,
      );
    } else if (status === "captcha" || status === "blocked") {
      this.safeBrowsingPendingUrls.delete(task.url);
      if (status === "captcha") {
        this.safeBrowsingCounters.captcha++;
      } else {
        this.safeBrowsingCounters.blocked++;
      }
      await finishReport(task.submissionId, {
        status,
        metadata: { attempts: task.attempts },
      });
    } else if (task.attempts < SAFE_BROWSING_MAX_ATTEMPTS && !this.safeBrowsingStopped) {
      const delayMs = SAFE_BROWSING_RETRY_BASE_DELAY_MS * task.attempts;
      console.warn(
        `[safe-browsing] report failed for ${task.url} (attempt ${task.attempts}/${SAFE_BROWSING_MAX_ATTEMPTS}); retrying in ${delayMs / 1000}s`,
      );
      await updateReportProgress(task.submissionId, {
        attempts: task.attempts,
        last_status: status,
        last_attempt_at: new Date().toISOString(),
      });
      await setTimeout(delayMs);
      if (this.safeBrowsingStopped) {
        this.safeBrowsingPendingUrls.delete(task.url);
        await finishReport(task.submissionId, {
          status: "abandoned",
          errorMessage: "service stopped during retry delay",
          metadata: { attempts: task.attempts, reason: "shutdown" },
        });
      } else {
        this.safeBrowsingQueue.push(task);
      }
    } else {
      this.safeBrowsingPendingUrls.delete(task.url);
      this.safeBrowsingCounters.gaveUp++;
      await finishReport(task.submissionId, {
        status: "error",
        errorMessage: `gave up after ${task.attempts} attempt(s)`,
        metadata: { attempts: task.attempts, gave_up: true },
      });
      console.error(
        `[safe-browsing] gave up on ${task.url} after ${task.attempts} attempt(s)`,
      );
    }

    const counters = this.safeBrowsingCounters;
    console.log(
      `[safe-browsing] lifetime: ${counters.submitted} submitted, ${counters.captcha} captcha, ${counters.blocked} blocked, ${counters.gaveUp} gave up`,
    );
  }

  /** Returns true when the report form is already available (signed in). */
  private async isReportFormAvailable(page: Page): Promise<boolean> {
    return await page
      .getByLabel("Which site do you want to report?")
      .isVisible()
      .catch(() => false);
  }

  /**
   * Signs in to the Microsoft account used for reporting. Sign-in is only
   * needed when the stored session is missing or expired.
   * Returns true when a fresh sign-in has to be persisted.
   */
  private async signIn(page: Page): Promise<boolean> {
    const signInButton = page.getByRole("button", { name: "Sign In" });

    if (!(await signInButton.isVisible().catch(() => false))) {
      throw new Error(
        `Unable to sign in to report to smartscreen (page: "${await this.pageTitle(page)}")`,
      );
    }

    await signInButton.click();

    const loginField = page.getByPlaceholder("Email, phone, or Skype");
    await loginField.fill((await readConfig()).microsoftUsername);
    await loginField.press("Enter");

    // Microsoft may show a sign-in method picker - use the password instead
    const usePasswordButton = page.getByRole("button", { name: "Use your password" });
    const passwordField = page.getByPlaceholder("Password");
    await Promise.race([
      usePasswordButton.waitFor({ state: "visible", timeout: 15000 }).then(() => usePasswordButton.click()),
      passwordField.waitFor({ state: "visible", timeout: 15000 }),
    ]).catch(() => {});

    const activePasswordField = await Promise.any([
      page
        .getByRole('textbox', { name: 'Password' })
        .waitFor({ state: "visible", timeout: 10000 })
        .then(() => page.getByRole('textbox', { name: 'Password' })),
      page
        .getByPlaceholder("Password")
        .waitFor({ state: "visible", timeout: 10000 })
        .then(() => page.getByPlaceholder("Password")),
    ]);

    await activePasswordField.fill((await readConfig()).microsoftPassword);
    await activePasswordField.press("Enter");

    await this.clearLoginInterruptions(page);

    // Microsoft may ask whether the report is about this account
    const confirmation = page.getByRole("button", { name: "Yes" });
    if (await confirmation.isVisible().catch(() => false)) {
      await confirmation.click();
    }

    return true;
  }

  /**
   * After the password is submitted, Microsoft may show prompts that need to
   * be cleared before the report form appears. Instead of waiting for each
   * one in turn, poll them together and click whichever shows up first.
   */
  private async clearLoginInterruptions(page: Page): Promise<void> {
    const deadline = Date.now() + LOGIN_SETTLE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (await this.isReportFormAvailable(page)) {
        return;
      }
      if (await this.clickFirstVisible(page, this.loginInterruptionLocators(page))) {
        continue;
      }
      await setTimeout(500);
    }
  }

  private loginInterruptionLocators(page: Page): Locator[] {
    return [
      // Microsoft may fail to create a passkey and show an error dialog
      page.getByRole("button", { name: "Cancel" }),
      // Microsoft may ask "Is your security info still accurate?"
      page.getByRole("button", { name: "Looks good!" }),
      // Updated terms of use must be acknowledged before the account can be used
      page.getByRole("button", { name: "Next" }),
    ];
  }

  private async clickFirstVisible(page: Page, candidates: Locator[]): Promise<boolean> {
    for (const candidate of candidates) {
      try {
        if (await candidate.isVisible({ timeout: 500 })) {
          await candidate.click();
          return true;
        }
      } catch {
        // Not visible, try the next candidate
      }
    }
    return false;
  }

  private async pageTitle(page: Page): Promise<string> {
    return await page.title().catch(() => "unknown");
  }

  private async takeFailureScreenshot(
    page: Page,
    url: string,
    prefix: string = "smartscreen_failure",
    dir: string = FAILURE_SCREENSHOT_DIR
  ): Promise<string | null> {
    try {
      if (page.isClosed()) return null;

      await fs.mkdir(dir, { recursive: true });
      const hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = path.join(
        dir,
        `${prefix}_${hostname}_${timestamp}.png`
      );

      await page.screenshot({ path: filePath, fullPage: true });
      console.error(`Saved ${prefix} screenshot to ${filePath}`);
      return filePath;
    } catch (error) {
      console.error(`Failed to save ${prefix} screenshot: ${error}`);
      return null;
    }
  }

  private async loadStoredSession(): Promise<StorageState> {
    try {
      const contents = await fs.readFile(SESSION_FILE, "utf8");
      console.log("Loaded stored smartscreen session");
      return JSON.parse(contents) as StorageState;
    } catch {
      console.log("No stored smartscreen session found, a sign-in will be needed");
      return undefined;
    }
  }

  private async saveSession(context: BrowserContext): Promise<void> {
    try {
      await fs.mkdir(path.dirname(SESSION_FILE), { recursive: true });
      await fs.writeFile(SESSION_FILE, JSON.stringify(await context.storageState()));
      console.log("Saved smartscreen session for future reports");
    } catch (error) {
      console.error(`Failed to save smartscreen session: ${error}`);
    }
  }

  /**
   * The Safe Browsing queue is in memory, so any row still queued from a
   * previous process can never be picked up. Mark old rows abandoned at
   * startup to keep the ledger honest.
   */
  async reconcileQueuedReports(): Promise<void> {
    const abandoned = await abandonStaleReports(15, "safe_browsing_web_form");
    if (abandoned > 0) {
      console.log(
        `[safe-browsing] marked ${abandoned} stale queued report(s) abandoned`
      );
    }
  }

  async close() {
    this.safeBrowsingStopped = true;

    const queuedTasks = this.safeBrowsingQueue.splice(0);
    for (const task of queuedTasks) {
      await finishReport(task.submissionId, {
        status: "abandoned",
        errorMessage: "service stopped before submission",
        metadata: { attempts: task.attempts, reason: "shutdown" },
      });
    }
    this.safeBrowsingPendingUrls.clear();

    if (this.safeBrowsingInFlight) {
      await Promise.race([
        this.safeBrowsingInFlight,
        setTimeout(15000),
      ]).catch(() => {});
      this.safeBrowsingInFlight = null;
    }

    if (this.safeBrowsingActiveTask) {
      await finishReport(this.safeBrowsingActiveTask.submissionId, {
        status: "abandoned",
        errorMessage: "service stopped while submission was in flight",
        metadata: {
          attempts: this.safeBrowsingActiveTask.attempts,
          reason: "shutdown",
        },
      });
      this.safeBrowsingActiveTask = null;
    }

    if (this.safeBrowsingContext) {
      await this.safeBrowsingContext.close().catch(() => {});
      this.safeBrowsingContext = null;
    }

    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    if (this.browser) {
      await BrowserManagerService.closeBrowser(this.browser);
      this.browser = null;
    }
  }
}

export const browserReportService = new BrowserReportService();
