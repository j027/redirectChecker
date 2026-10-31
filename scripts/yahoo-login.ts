/**
 * One-time / automatic Yahoo Mail login.
 *
 * Opens a headful browser under Xvfb, signs in, and automatically fills the
 * authenticator-app TOTP code using yahooTotpSecret from config.json. If Yahoo
 * shows a method picker, it chooses Authenticator app. If anything unexpected
 * appears, the browser stays open for manual completion through noVNC:
 *
 *   http://127.0.0.1:6080/vnc.html
 *
 * On success it saves the browser storage state to data/yahoo/session.json so
 * the hunter does not log in on every cycle.
 */
import { promises as fs } from "fs";
import path from "path";
import { Locator, Page } from "patchright";
import { BrowserManagerService } from "../src/services/browserManagerService.js";
import { readConfig } from "../src/config.js";
import { generateTotp } from "../src/utils/totp.js";
import { captureStorageState } from "../src/utils/storageState.js";
import {
  parseProxy,
  spoofWindowsChrome,
} from "../src/utils/playwrightUtilities.js";

const OUT_DIR = path.join(process.cwd(), "data", "yahoo");
const SESSION_FILE = path.join(OUT_DIR, "session.json");
const WAIT_TIMEOUT_MS = 12 * 60 * 1000;
const SCREENSHOT_INTERVAL_MS = 10_000;

async function screenshot(page: Page, label: string): Promise<void> {
  try {
    await fs.mkdir(OUT_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(OUT_DIR, `login-watch-${label}-${timestamp}.png`);
    await page.screenshot({
      path: file,
      fullPage: false,
      animations: "disabled",
      timeout: 5_000,
    });
    console.log(`SCREENSHOT: ${file}`);
  } catch (error) {
    console.error(`Screenshot failed: ${error}`);
  }
}

async function isLoggedIn(page: Page): Promise<boolean> {
  if (!page.url().includes("mail.yahoo.com")) {
    return false;
  }
  if (page.url().includes("login.yahoo.com")) {
    return false;
  }

  if (/mail\.yahoo\.com\/(?:n\/)?inbox/i.test(page.url())) {
    return true;
  }

  const appSelectors =
    '#mail-app, [data-test-id="mail-app"], [data-test-id="mail-search"], [data-test-id="mail-left-nav"]';
  const count = await page.locator(appSelectors).count().catch(() => 0);
  if (count > 0) {
    return true;
  }

  const body = await page.locator("body").innerText().catch(() => "");
  return (
    /New message|Search your mail|Compose|Search mail/.test(body) &&
    !/Sign in to Yahoo Mail|Designed to simplify your life/i.test(body)
  );
}

async function isChallengePage(page: Page): Promise<boolean> {
  if (/\/account\/challenge\/password/.test(page.url())) {
    return false;
  }
  if (/\/account\/challenge\//.test(page.url())) {
    return true;
  }

  const body = await page.locator("body").innerText().catch(() => "");
  return /select a verification method|authenticator app|verification code|enter the code|verify your identity|unusual activity|enter the characters/i.test(
    body
  );
}

async function getCodeField(page: Page): Promise<Locator | null> {
  const selectors = [
    'input[autocomplete="one-time-code"]:visible',
    '#verify-code-0:visible',
    'input[name="code"]:not([type="hidden"]):visible',
    'input[name="verificationCode"]:visible',
    'input[name="verifyCode"]:visible',
    'input[name="otp"]:visible',
    '#verification-code:visible',
    'input[id*="verification" i]:visible',
    'input[inputmode="numeric"]:visible',
    'input[type="tel"]:visible',
  ];

  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) {
      return locator;
    }
  }

  return null;
}

async function waitForCodeField(
  page: Page,
  timeoutMs: number = 12_000
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const field = await getCodeField(page);
    if (field != null) {
      return field;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function clickFirstVisible(
  candidates: Locator[]
): Promise<boolean> {
  for (const candidate of candidates) {
    try {
      if (await candidate.first().isVisible({ timeout: 500 })) {
        await candidate.first().click({ timeout: 3_000 });
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return false;
}

async function selectAuthenticatorMethod(page: Page): Promise<void> {
  const authenticatorCandidates = [
    page.getByRole("button", { name: /authenticator app/i }),
    page.getByRole("link", { name: /authenticator app/i }),
    page.getByText(/authenticator app/i),
  ];

  if (await clickFirstVisible(authenticatorCandidates)) {
    await page.waitForTimeout(1_500);
    return;
  }

  if (
    await clickFirstVisible([
      page.getByRole("button", { name: /more options/i }),
      page.getByRole("link", { name: /more options/i }),
    ])
  ) {
    await page.waitForTimeout(1_500);
    await clickFirstVisible(authenticatorCandidates);
    await page.waitForTimeout(1_500);
  }
}

async function enableStayVerified(page: Page): Promise<void> {
  try {
    const toggle = page.getByRole("switch").first();
    if (await toggle.isVisible({ timeout: 1_000 })) {
      const checked = await toggle.getAttribute("aria-checked");
      if (checked !== "true") {
        await toggle.click({ timeout: 3_000 });
        console.log("Enabled Stay verified");
      }
    }
  } catch {
    // Optional control; ignore if the widget differs.
  }
}

async function enterCode(page: Page, codeField: Locator, code: string): Promise<void> {
  const segmented = page.locator('input[id^="verify-code-"]:visible');
  const boxCount = await segmented.count().catch(() => 0);
  if (boxCount > 1) {
    await segmented.first().click();
    await page.keyboard.type(code, { delay: 50 });
  } else {
    await codeField.fill(code);
  }
}

async function submitCode(page: Page, codeField: Locator, code: string): Promise<void> {
  await enterCode(page, codeField, code);
  const clicked = await clickFirstVisible([
    page.getByRole("button", { name: /^next$/i }),
    page.getByRole("button", { name: /^verify$/i }),
    page.getByRole("button", { name: /^submit$/i }),
    page.getByRole("button", { name: /^continue$/i }),
  ]);
  if (!clicked) {
    await page.keyboard.press("Enter");
  }
}

async function solveTotp(page: Page, secret: string): Promise<boolean> {
  if (!(await isChallengePage(page))) {
    return false;
  }

  if (!(await getCodeField(page))) {
    console.log("Selecting Authenticator app as the verification method");
    await selectAuthenticatorMethod(page);
  }

  const codeField = await waitForCodeField(page);
  if (codeField == null) {
    console.error("Could not find the authenticator code field");
    return false;
  }

  await enableStayVerified(page);

  console.log("Entering generated TOTP code");
  await submitCode(page, codeField, generateTotp(secret));

  // Wait for the challenge to resolve before trying a clock-skew fallback.
  const settleDeadline = Date.now() + 10_000;
  while (Date.now() < settleDeadline) {
    if (!(await isChallengePage(page))) {
      return true;
    }
    if (!(await getCodeField(page))) {
      return true;
    }
    await page.waitForTimeout(500);
  }

  console.log("First TOTP code did not resolve; trying previous 30s window");
  await submitCode(
    page,
    (await getCodeField(page)) ?? codeField,
    generateTotp(secret, { timestamp: Date.now() - 30_000 })
  );
  await page.waitForTimeout(4_000);
  return true;
}

async function main(): Promise<void> {
  const config = await readConfig();
  if (!config.yahooUsername || !config.yahooPassword) {
    throw new Error("Missing yahooUsername/yahooPassword in config.json");
  }
  if (!config.yahooTotpSecret) {
    console.warn(
      "No yahooTotpSecret configured; authenticator challenges will need manual entry"
    );
  }

  const browser = await BrowserManagerService.createBrowser(false);
  const context = await browser.newContext({
    proxy: await parseProxy("hunter"),
    viewport: null,
  });
  const page = await context.newPage();

  try {
    await spoofWindowsChrome(context, page);
    await page.goto("https://login.yahoo.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(3_000);
    await screenshot(page, "username-page");

    const username = page
      .locator("#username, input[name='username']")
      .first();
    await username.waitFor({ state: "visible", timeout: 15_000 });
    console.log("Filling username");
    await username.fill(config.yahooUsername);
    await screenshot(page, "username-filled");
    console.log("Submitting username");
    await username.press("Enter");

    await page.waitForTimeout(5_000);
    await screenshot(page, "password-page");

    const password = page
      .locator('#password, input[name="password"], input[type="password"]')
      .first();
    await password.waitFor({ state: "visible", timeout: 20_000 });
    console.log("Filling password");
    await password.fill(config.yahooPassword);
    await screenshot(page, "password-filled");
    console.log("Submitting password");
    await password.press("Enter");

    console.log(
      "\nPassword submitted. Watching for incoming authenticator challenge..."
    );

    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    let lastScreenshot = 0;
    let loggedIn = false;
    let navigatedToMail = false;

    while (Date.now() < deadline) {
      loggedIn = await isLoggedIn(page);
      if (loggedIn) {
        break;
      }

      // Yahoo's post-login landing page is www.yahoo.com, not Yahoo Mail.
      if (
        !navigatedToMail &&
        page.url().includes("yahoo.com") &&
        !page.url().includes("login.yahoo.com") &&
        !page.url().includes("mail.yahoo.com")
      ) {
        navigatedToMail = true;
        console.log("Navigating to Yahoo Mail");
        await page.goto("https://mail.yahoo.com/", {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await page.waitForTimeout(3_000);
        continue;
      }

      if (
        config.yahooTotpSecret &&
        (await isChallengePage(page)) &&
        (await getCodeField(page))
      ) {
        await solveTotp(page, config.yahooTotpSecret);
        await page.waitForTimeout(2_000);
        continue;
      }

      if (config.yahooTotpSecret && (await isChallengePage(page))) {
        await selectAuthenticatorMethod(page);
        await page.waitForTimeout(1_500);
        continue;
      }

      const now = Date.now();
      if (now - lastScreenshot >= SCREENSHOT_INTERVAL_MS) {
        lastScreenshot = now;
        console.log(`WAITING: ${page.url()}`);
        await screenshot(page, "waiting");
      }

      await page.waitForTimeout(2_000);
    }

    if (!loggedIn) {
      await screenshot(page, "timeout");
      throw new Error(
        `Yahoo login did not complete within ${WAIT_TIMEOUT_MS / 60_000} minutes`
      );
    }

    await page.waitForTimeout(5_000);
    await screenshot(page, "logged-in");
    console.log("URL:", page.url());
    console.log("TITLE:", await page.title().catch(() => "?"));

    await fs.mkdir(OUT_DIR, { recursive: true });
    const storageState = await captureStorageState(context);
    await fs.writeFile(SESSION_FILE, JSON.stringify(storageState), {
      mode: 0o600,
    });
    console.log(`Saved Yahoo session to ${SESSION_FILE}`);
    console.log("You can close the noVNC tab; the hunter will reuse this session.");
    // A timed-out storageState() call may still be pending; exit explicitly so
    // the login container does not hang after the session is saved.
    process.exit(0);
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
