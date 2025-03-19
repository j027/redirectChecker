import { chromium, Browser } from "patchright";
import { readConfig } from "../config.js";
import {
  blockGoogleAnalytics,
  spoofWindowsChrome,
  parseProxy,
} from "../utils/playwrightUtilities.js";
export class BrowserReportService {
  private browser: Browser | null;

  constructor() {
    this.browser = null;
  }

  async init() {
    this.browser = await chromium.launch({
      headless: false,
      executablePath: "/snap/bin/chromium",
      chromiumSandbox: true,
    });
  }

  async reportToSmartScreen(url: string): Promise<boolean> {
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - reporting to smartscreen failed",
      );
      return false;
    }

    const context = await this.browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(
        "https://www.microsoft.com/en-us/wdsi/support/report-unsafe-site",
      );

      // log in to the microsoft account
      // this allows reporting to smartscreen without a captcha
      const { microsoftUsername, microsoftPassword } = await readConfig();
      await page.getByRole("button", { name: "Sign In" }).click();

      const loginField = page.getByPlaceholder("Email, phone, or Skype");
      await loginField.fill(microsoftUsername);
      await loginField.press('Enter');

      const passwordField = page.getByPlaceholder("Password");
      await passwordField.fill(microsoftPassword);
      await passwordField.press('Enter');

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

  async collectSafeBrowsingReportDetails(url: string) {
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - getting safebrowsing report data failed",
      );
      return null;
    }

    // setup page and block google analytics
    const context = await this.browser.newContext({
      proxy: await parseProxy(),
      viewport: null,
    });
    const page = await context.newPage();
    await spoofWindowsChrome(context, page);
    await blockGoogleAnalytics(page);

    try {
      await page.goto(url);

      // click on the top left, to ensure that the popup is fully activated
      await page.mouse.click(0, 0);
      const screenshot: Buffer = await page.screenshot();
      const pageContent = await page.content();
      await page.screenshot({ path: `scam_screenshots/${crypto.randomUUID()}.png`})

      return [screenshot.toString("base64"), pageContent];
    }
    catch (error) {
      console.log(`Error while attempting to get google safe browsing report details: ${error}`);
      await page.screenshot({ path: 'safebrowsing_report_screenshot_failure.png' });
      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }

  async collectNonPopupWebsiteScreenshot(url: string) {
    if (this.browser == null) {
      console.error(
        "Browser has not been initialized - getting non-popup website screenshot failed",
      );
      return null;
    }

    // setup page and block google analytics
    const context = await this.browser.newContext({
      proxy: await parseProxy(),
      viewport: null,
    });
    const page = await context.newPage(); 
    await spoofWindowsChrome(context, page);
    await blockGoogleAnalytics(page);

    try {
      await page.goto(url);
      await page.screenshot({ path: `non_scam_screenshots/${crypto.randomUUID()}_${new URL(url).hostname}.png`});
    }
    catch (error) {
      console.log(`Error while attempting to get non-popup website screenshot: ${error}`);
      return null;
    } finally {
      await page.close();
      await context.close();
    }
  }

  async close() {
    if (this.browser == null) {
      return;
    }

    await this.browser.close();
  }
}

export const browserReportService = new BrowserReportService();