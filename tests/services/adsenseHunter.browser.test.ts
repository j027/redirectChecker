import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, Browser } from "patchright";
// hunterService must load first: it instantiates the hunters and the
// hunterService <-> adsenseHunter cycle deadlocks if the hunter loads first.
import "../../src/services/hunterService.js";
import {
  startAdsenseFixtureServer,
  AdsenseFixtureServer,
} from "../fixtures/adsense/serve.js";
import {
  AdsenseTarget,
  IZITO_TARGET,
  clickSlotAndCapturePopup,
  isSlotFilled,
  waitForSlotFill,
} from "../../src/services/adsenseHunter.js";

const TEST_TIMEOUT = 45000;

describe("AdsenseHunter detection", () => {
  let browser: Browser;
  let server: AdsenseFixtureServer;

  const targetFor = (file: string): AdsenseTarget => ({
    ...IZITO_TARGET,
    url: `${server.baseUrl}/${file}`,
  });

  beforeAll(async () => {
    server = await startAdsenseFixtureServer();
    browser = await chromium.launch({
      headless: false,
      channel: "chrome",
      chromiumSandbox: true,
    });
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await server?.close();
  });

  it(
    "clicks a filled slot and captures the popup it opens",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const target = targetFor("popup.html");

      await page.goto(target.url);
      expect(await waitForSlotFill(page, target, 5000)).toBe(true);

      const capture = await clickSlotAndCapturePopup(
        page,
        target.filledSlotSelector,
        500,
        5000,
      );

      expect(capture).not.toBeNull();
      expect(capture?.finalUrl).toBe(`${server.baseUrl}/landing.html`);
      expect(capture?.redirectionPath).toContain(
        `${server.baseUrl}/landing.html`,
      );
      expect(capture?.screenshot.length).toBeGreaterThan(0);
      expect(capture?.html).toContain("Your download is ready");

      await context.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "clicks the C0ntinue CTA link instead of the AdChoices decoys",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const target = targetFor("continue-cta.html");

      await page.goto(target.url);
      expect(await waitForSlotFill(page, target, 5000)).toBe(true);

      const capture = await clickSlotAndCapturePopup(
        page,
        target.filledSlotSelector,
        500,
        5000,
      );

      expect(capture).not.toBeNull();
      expect(capture?.finalUrl).toBe(`${server.baseUrl}/landing.html`);

      await context.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "clicks a corner button that a slot-center click would miss",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const target = targetFor("popup-corner.html");

      await page.goto(target.url);
      expect(await waitForSlotFill(page, target, 5000)).toBe(true);

      const capture = await clickSlotAndCapturePopup(
        page,
        target.filledSlotSelector,
        500,
        5000,
      );

      expect(capture).not.toBeNull();
      expect(capture?.finalUrl).toBe(`${server.baseUrl}/landing.html`);

      await context.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "clicks a button-only creative with no anchors",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const target = targetFor("button-creative.html");

      await page.goto(target.url);
      expect(await waitForSlotFill(page, target, 5000)).toBe(true);

      const capture = await clickSlotAndCapturePopup(
        page,
        target.filledSlotSelector,
        500,
        5000,
      );

      expect(capture).not.toBeNull();
      expect(capture?.finalUrl).toBe(`${server.baseUrl}/landing.html`);

      await context.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "reports no fill when the slot never receives a query id",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const target = targetFor("no-fill.html");

      await page.goto(target.url);
      expect(await isSlotFilled(page, target)).toBe(false);
      expect(await waitForSlotFill(page, target, 300)).toBe(false);

      await context.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "returns null when clicking the slot opens no popup",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const target = targetFor("no-popup.html");

      await page.goto(target.url);
      expect(await waitForSlotFill(page, target, 5000)).toBe(true);

      const capture = await clickSlotAndCapturePopup(
        page,
        target.filledSlotSelector,
        500,
        1500,
      );
      expect(capture).toBeNull();

      await context.close();
    },
    TEST_TIMEOUT,
  );
});
