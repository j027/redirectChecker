import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, Browser, BrowserContext } from "patchright";
import { 
  createSignalService,
} from "../../src/services/signalService.js";

describe("SignalService Browser Integration", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser.close();
  });

  describe("Fullscreen API Detection", () => {
    it("should detect fullscreen request", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const signalService = createSignalService();

      // Attach listeners BEFORE navigation (uses addInitScript with Proxy)
      await signalService.attachApiListeners(page);

      // Navigate to a real HTTP page
      await page.goto("https://example.com");
      
      // Inject a button and click it to trigger fullscreen
      await page.evaluate(() => {
        const btn = document.createElement("button");
        btn.id = "trigger";
        btn.onclick = () => document.documentElement.requestFullscreen();
        document.body.appendChild(btn);
      });
      await page.click("#trigger");

      // Collect signals
      await signalService.collectApiSignals(page);
      const signals = signalService.getSignals();

      expect(signals.fullscreenRequested).toBe(true);

      await context.close();
    });

    it("should not detect fullscreen on clean page", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const signalService = createSignalService();

      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");

      await signalService.collectApiSignals(page);
      const signals = signalService.getSignals();

      expect(signals.fullscreenRequested).toBe(false);

      await context.close();
    });
  });

  describe("Keyboard Lock API Detection", () => {
    it("should detect keyboard lock request", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const signalService = createSignalService();

      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");
      
      // Inject a button that triggers keyboard lock
      await page.evaluate(() => {
        const btn = document.createElement("button");
        btn.id = "trigger";
        btn.onclick = () => {
          if ((navigator as any).keyboard && (navigator as any).keyboard.lock) {
            (navigator as any).keyboard.lock(["Escape"]);
          }
        };
        document.body.appendChild(btn);
      });
      await page.click("#trigger");

      await signalService.collectApiSignals(page);
      const signals = signalService.getSignals();

      expect(signals.keyboardLockRequested).toBe(true);

      await context.close();
    });

    it("should not detect keyboard lock on clean page", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const signalService = createSignalService();

      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");

      await signalService.collectApiSignals(page);
      const signals = signalService.getSignals();

      expect(signals.keyboardLockRequested).toBe(false);

      await context.close();
    });
  });

  describe("Pointer Lock API Detection", () => {
    it("should detect pointer lock request", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const signalService = createSignalService();

      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");
      
      // Inject a button that triggers pointer lock
      await page.evaluate(() => {
        const btn = document.createElement("button");
        btn.id = "trigger";
        btn.onclick = () => btn.requestPointerLock();
        document.body.appendChild(btn);
      });
      await page.click("#trigger");

      await signalService.collectApiSignals(page);
      const signals = signalService.getSignals();

      expect(signals.pointerLockRequested).toBe(true);

      await context.close();
    });

    it("should not detect pointer lock on clean page", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const signalService = createSignalService();

      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");

      await signalService.collectApiSignals(page);
      const signals = signalService.getSignals();

      expect(signals.pointerLockRequested).toBe(false);

      await context.close();
    });
  });

  describe("Multiple API Detection", () => {
    it("should detect multiple signals independently", async () => {
      const context = await browser.newContext();
      
      // Test fullscreen
      let page = await context.newPage();
      let signalService = createSignalService();
      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");
      await page.evaluate(() => {
        const btn = document.createElement("button");
        btn.id = "trigger";
        btn.onclick = () => document.documentElement.requestFullscreen();
        document.body.appendChild(btn);
      });
      await page.click("#trigger");
      await signalService.collectApiSignals(page);
      let signals = signalService.getSignals();
      
      expect(signals.fullscreenRequested).toBe(true);
      expect(signals.keyboardLockRequested).toBe(false);
      expect(signals.pointerLockRequested).toBe(false);
      await page.close();

      // Test keyboard lock
      page = await context.newPage();
      signalService = createSignalService();
      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");
      await page.evaluate(() => {
        const btn = document.createElement("button");
        btn.id = "trigger";
        btn.onclick = () => {
          if ((navigator as any).keyboard && (navigator as any).keyboard.lock) {
            (navigator as any).keyboard.lock(["Escape"]);
          }
        };
        document.body.appendChild(btn);
      });
      await page.click("#trigger");
      await signalService.collectApiSignals(page);
      signals = signalService.getSignals();
      
      expect(signals.fullscreenRequested).toBe(false);
      expect(signals.keyboardLockRequested).toBe(true);
      expect(signals.pointerLockRequested).toBe(false);
      await page.close();

      // Test pointer lock
      page = await context.newPage();
      signalService = createSignalService();
      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");
      await page.evaluate(() => {
        const btn = document.createElement("button");
        btn.id = "trigger";
        btn.onclick = () => btn.requestPointerLock();
        document.body.appendChild(btn);
      });
      await page.click("#trigger");
      await signalService.collectApiSignals(page);
      signals = signalService.getSignals();
      
      expect(signals.fullscreenRequested).toBe(false);
      expect(signals.keyboardLockRequested).toBe(false);
      expect(signals.pointerLockRequested).toBe(true);

      await context.close();
    });
  });

  describe("hasWeightedSignal with browser signals", () => {
    it("should return true when fullscreen is requested", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const signalService = createSignalService();

      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");
      await page.evaluate(() => {
        const btn = document.createElement("button");
        btn.id = "trigger";
        btn.onclick = () => document.documentElement.requestFullscreen();
        document.body.appendChild(btn);
      });
      await page.click("#trigger");
      await signalService.collectApiSignals(page);

      expect(signalService.hasWeightedSignal()).toBe(true);

      await context.close();
    });

    it("should return false on clean page", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const signalService = createSignalService();

      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");
      await signalService.collectApiSignals(page);

      expect(signalService.hasWeightedSignal()).toBe(false);

      await context.close();
    });
  });

  describe("detectAllSignals integration", () => {
    it("should detect both browser APIs and URL-based signals", async () => {
      const context = await browser.newContext();
      const page = await context.newPage();
      const signalService = createSignalService();

      await signalService.attachApiListeners(page);
      await page.goto("https://example.com");
      await page.evaluate(() => {
        const btn = document.createElement("button");
        btn.id = "trigger";
        btn.onclick = () => document.documentElement.requestFullscreen();
        document.body.appendChild(btn);
      });
      await page.click("#trigger");

      // Use detectAllSignals with a third-party hosting URL
      const signals = await signalService.detectAllSignals(page, "https://scam.herokuapp.com/page");

      // Should have both browser signal and URL signal
      expect(signals.fullscreenRequested).toBe(true);
      expect(signals.isThirdPartyHosting).toBe(true);

      await context.close();
    });
  });
});
