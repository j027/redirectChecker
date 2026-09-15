import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, Browser, BrowserContext, Page } from "patchright";
import {
  startBombFixtureServer,
  BombFixtureServer,
} from "../fixtures/bomb/serve.js";
import { createSignalService } from "../../src/services/signalService.js";
import { BombGuard } from "../../src/services/bombGuard.js";
import { dispatchMainWorldEvent } from "../../src/utils/playwrightUtilities.js";

const TEST_TIMEOUT = 45000;
const STRESS_TIMEOUT = 60000;
const STRESS_HEADED = process.env.BOMB_STRESS_HEADED === "1";

async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: !STRESS_HEADED,
    channel: "chrome",
    chromiumSandbox: true,
  });
}

async function armGuardAndTrigger(
  page: Page,
  context: BrowserContext,
  maxWaitMs = 6000
): Promise<{ guard: BombGuard; bombDetected: boolean }> {
  const guard = new BombGuard();
  await guard.arm(context, page);
  await guard.throttle(4);

  const dispatch = guard.dispatchUnloadEvent().catch(() => undefined);

  await Promise.race([
    dispatch,
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);

  const bombDetected = await guard.waitForSettle(undefined, maxWaitMs);
  return { guard, bombDetected };
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number = 5000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

describe("BombGuard browser integration", () => {
  let browser: Browser;
  let server: BombFixtureServer;

  const tickCount = (from: number, name: string) =>
    server.ticks.slice(from).filter((t) => t === name).length;
  const payloadTicks = (from: number) =>
    server.ticks.slice(from).filter((t) => t.startsWith("payload")).length;

  beforeAll(async () => {
    server = await startBombFixtureServer();
    browser = await launchBrowser();
  }, TEST_TIMEOUT);

  afterAll(async () => {
    await browser?.close().catch(() => undefined);
    await server?.close();
  });

  it(
    "runs patchright init scripts on the local fixture origin (smoke)",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const signalService = createSignalService();

      await signalService.attachApiListeners(page);
      await page.goto(`${server.baseUrl}/smoke.html`);

      await page.evaluate(() => {
        const script = document.createElement("script");
        script.textContent = `
          const src = "postMessage({done:true});";
          const url = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
          for (let i = 0; i < 13; i++) { new Worker(url); }
        `;
        document.head.appendChild(script);
      });

      await signalService.collectApiSignals(page);
      expect(signalService.getSignals().workerBombDetected).toBe(true);

      await context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "freezes the unload-seed bomb: no payload execution, no extra pages",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${server.baseUrl}/unload-seed.html`);
      const from = server.ticks.length;

      const { guard, bombDetected } = await armGuardAndTrigger(page, context);

      expect(bombDetected).toBe(true);
      expect(guard.getWorkerTargetCount()).toBeGreaterThanOrEqual(3);

      expect(await waitFor(() => tickCount(from, "unload-handler") > 0, 8000)).toBe(true);
      expect(payloadTicks(from)).toBe(0);
      expect(await waitFor(() => context.pages().length === 1, 8000)).toBe(true);

      await guard.dispose();
      await context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "freezes module workers on unload",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${server.baseUrl}/module-worker.html`);
      const from = server.ticks.length;

      const { guard, bombDetected } = await armGuardAndTrigger(page, context);

      expect(bombDetected).toBe(true);
      expect(payloadTicks(from)).toBe(0);

      await guard.dispose();
      await context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "does not flag a single unload worker but documents the handshake tradeoff",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${server.baseUrl}/handshake.html`);
      const from = server.ticks.length;

      const { guard, bombDetected } = await armGuardAndTrigger(page, context);

      expect(bombDetected).toBe(false);
      expect(guard.getWorkerTargetCount()).toBe(1);
      expect(payloadTicks(from)).toBe(0);

      // A page that waits for a handshake notices the frozen worker; the
      // alternate path fires. This is the known detectability tradeoff of
      // freeze-all and is asserted here so a future policy change is visible.
      expect(await waitFor(() => tickCount(from, "alternate") > 0, 8000)).toBe(true);

      await guard.dispose();
      await context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "never flags legitimate unload cleanup (false-positive control)",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${server.baseUrl}/legit-control.html`);
      const from = server.ticks.length;

      const { guard, bombDetected } = await armGuardAndTrigger(page, context);

      expect(bombDetected).toBe(false);
      expect(guard.getWorkerTargetCount()).toBe(1);

      await guard.dispose();
      await context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "fixture detonates when the guard is not armed (sanity check)",
    async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${server.baseUrl}/detonate-small.html`);
      const from = server.ticks.length;

      await dispatchMainWorldEvent(page, "beforeunload").catch(
        () => undefined
      );

      expect(await waitFor(() => payloadTicks(from) > 0, 15000)).toBe(true);

      await page.waitForTimeout(500);
      await context.close();
    },
    TEST_TIMEOUT
  );

  it(
    "stress: full-force bomb stays frozen and bounded",
    async () => {
      const stressBrowser = await launchBrowser();
      const context = await stressBrowser.newContext();
      const page = await context.newPage();

      try {
        await page.goto(`${server.baseUrl}/full-force.html`);
        const from = server.ticks.length;

        const { guard, bombDetected } = await armGuardAndTrigger(page, context, 8000);

        expect(bombDetected).toBe(true);
        expect(payloadTicks(from)).toBe(0);
        expect(guard.getWorkerTargetCount()).toBeGreaterThanOrEqual(3);
        expect(guard.getWorkerTargetCount()).toBeLessThanOrEqual(50);

        await guard.dispose();
      } finally {
        await stressBrowser.close().catch(() => undefined);
      }
    },
    STRESS_TIMEOUT
  );
});
