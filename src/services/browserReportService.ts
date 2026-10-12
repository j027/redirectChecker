import { Browser, BrowserContext, Locator, Page } from "patchright";
import { promises as fs } from "fs";
import { setTimeout } from "timers/promises";
import path from "path";
import { readConfig } from "../config.js";
import { spoofWindowsChrome } from "../utils/playwrightUtilities.js";
import { BrowserManagerService } from './browserManagerService.js';

const SMARTSCREEN_REPORT_URL =
  "https://www.microsoft.com/en-us/wdsi/support/report-unsafe-site";

// Cookies for the reporting account. Git-ignored with the rest of data/.
const SESSION_FILE = path.join(process.cwd(), "data", "smartscreen", "session.json");
const FAILURE_SCREENSHOT_DIR = path.join(process.cwd(), "data", "smartscreen");

type StorageState = NonNullable<
  Parameters<Browser["newContext"]>[0]
>["storageState"];

// How long to keep clearing optional Microsoft login prompts before giving up.
const LOGIN_SETTLE_TIMEOUT_MS = 25000;

export class BrowserReportService {
  private browser: Browser | null;
  private context: BrowserContext | null;
  private browserInitializing: boolean;

  constructor() {
    this.browser = null;
    this.context = null;
    this.browserInitializing = false;
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

  async reportToSmartScreen(url: string): Promise<boolean> {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - reporting to smartscreen failed",
      );
      return false;
    }

    const context = await this.getContext();
    const page = await context.newPage();

    try {
      await spoofWindowsChrome(context, page);
      await page.goto(SMARTSCREEN_REPORT_URL);

      if (!(await this.isReportFormAvailable(page))) {
        const signedIn = await this.signIn(page);
        if (signedIn) {
          await this.saveSession(context);
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
    } catch (error) {
      console.error(`Error when reporting to microsoft smartscreen (${url}): ${error}`);
      await this.takeFailureScreenshot(page, url);
      return false;
    } finally {
      await page.close().catch(() => {});
    }

    return true;
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

  private async takeFailureScreenshot(page: Page, url: string): Promise<void> {
    try {
      if (page.isClosed()) return;

      await fs.mkdir(FAILURE_SCREENSHOT_DIR, { recursive: true });
      const hostname = new URL(url).hostname.replace(/[^a-zA-Z0-9.-]/g, "_");
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filePath = path.join(
        FAILURE_SCREENSHOT_DIR,
        `smartscreen_failure_${hostname}_${timestamp}.png`
      );

      await page.screenshot({ path: filePath, fullPage: true });
      console.error(`Saved smartscreen failure screenshot to ${filePath}`);
    } catch (error) {
      console.error(`Failed to save smartscreen failure screenshot: ${error}`);
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

  async close() {
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
