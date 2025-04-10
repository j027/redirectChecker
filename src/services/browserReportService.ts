import { Browser } from "patchright";
import { readConfig } from "../config.js";
import { spoofWindowsChrome } from "../utils/playwrightUtilities.js";
import { BrowserManagerService } from './browserManagerService.js';

export class BrowserReportService {
  private browser: Browser | null;
  private browserInitializing: boolean;

  constructor() {
    this.browser = null;
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
          
          // Create new browser
          this.browser = await BrowserManagerService.createBrowser(true);
          console.log("Browser report service initialized new browser");
        } finally {
          this.browserInitializing = false;
        }
      }
    );
  }

  async reportToSmartScreen(url: string): Promise<boolean> {
    await this.ensureBrowserIsHealthy();

    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - reporting to smartscreen failed",
      );
      return false;
    }

    const context = await this.browser.newContext();
    const page = await context.newPage();

    try {
      await spoofWindowsChrome(context, page);
      await page.goto(
        "https://www.microsoft.com/en-us/wdsi/support/report-unsafe-site",
      );

      // log in to the microsoft account
      // this allows reporting to smartscreen without a captcha
      const { microsoftUsername, microsoftPassword } = await readConfig();
      await page.getByRole("button", { name: "Sign In" }).click();

      const loginField = page.getByPlaceholder("Email, phone, or Skype");
      await loginField.fill(microsoftUsername);
      await loginField.press("Enter");

      const activePasswordField = await Promise.any([
        page
          .getByRole('textbox', { name: 'Password' })
          .waitFor({ state: "attached", timeout: 5000 })
          .then(() => page.getByRole('textbox', { name: 'Password' })),
        page
          .getByPlaceholder("Password")
          .waitFor({ state: "attached", timeout: 5000 })
          .then(() => page.getByPlaceholder("Password")),
      ]);

      await activePasswordField.fill(microsoftPassword);
      await activePasswordField.press("Enter");

      await page.getByRole("button", { name: "Yes" }).click();

      // Fill out the report form
      await page.getByLabel("Which site do you want to report?").pressSequentially(url);
      await page.getByText("Malware or other threats").check();
      await page.getByRole("button", { name: "Submit" }).click();

      // ensure that the submission was successful
      await page.getByText("Thank you for your submission").waitFor({timeout: 30000});
      console.log("Successfully reported to microsoft smartscreen");
    } catch (error) {
      console.log(`Error when reporting to microsoft smartscreen: ${error}`);
      await page.screenshot({ path: 'smartscreen_report_failure.png', fullPage: true });
      return false;
    } finally {
      await page.close();
      await context.close();
    }

    return true;
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser == null;
    }
  }
}

export const browserReportService = new BrowserReportService();