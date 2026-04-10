import { describe, it, expect } from "vitest";
import { chromium } from "patchright";
import { createSignalService } from "../../src/services/signalService.js";

describe("SignalService Browser Integration", () => {
  
  it("should detect fullscreen request on chrome.dev keyboard-lock demo", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    await page.goto("https://chrome.dev/keyboard-lock/");

    // Click the "Enter full screen" button
    await page.click('text=Enter full screen');

    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    expect(signals.fullscreenRequested).toBe(true);
    expect(signals.keyboardLockRequested).toBe(false);

    await browser.close();
  }, 30000);

  it("should detect keyboard lock request on chrome.dev keyboard-lock demo", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    await page.goto("https://chrome.dev/keyboard-lock/");

    // First enter fullscreen (required for keyboard lock)
    await page.click('text=Enter full screen');
    
    // Then activate keyboard lock
    await page.click('text=Activate keyboard lock');

    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    expect(signals.fullscreenRequested).toBe(true);
    expect(signals.keyboardLockRequested).toBe(true);

    await browser.close();
  }, 30000);

  it("should detect pointer lock request", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    
    // Navigate to a real page first so init script runs
    await page.goto("https://mdn.github.io/dom-examples/pointer-lock/");
    await page.locator('canvas').click();
  
    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    expect(signals.pointerLockRequested).toBe(true);
    expect(signals.fullscreenRequested).toBe(false);
    expect(signals.keyboardLockRequested).toBe(false);

    await browser.close();
  }, 30000);

  it("should not detect signals on a clean page", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    await page.goto("https://example.com");

    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    expect(signals.fullscreenRequested).toBe(false);
    expect(signals.keyboardLockRequested).toBe(false);
    expect(signals.pointerLockRequested).toBe(false);

    await browser.close();
  }, 30000);

  it("should detect signals combined with URL analysis via detectAllSignals", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    await page.goto("https://chrome.dev/keyboard-lock/");

    // Trigger fullscreen
    await page.click('text=Enter full screen');

    // Use detectAllSignals with a third-party hosting URL
    const signals = await signalService.detectAllSignals(page, "https://scam.herokuapp.com/page");

    expect(signals.fullscreenRequested).toBe(true);
    expect(signals.isThirdPartyHosting).toBe(true);

    await browser.close();
  }, 30000);

  it("should detect worker bomb when many workers are spawned in a burst", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    await page.goto("https://example.com");

    // Simulate a scam page spawning 25 workers in a tight loop (like the real obfuscated scam code)
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = `
        // Scam pattern: create a blob with an infinite CPU-burning loop, then spawn many workers
        const workerCode = 'let c = 0; while (true) { c++; Math.random() * Math.random(); }';
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        for (let i = 0; i < 25; i++) {
          new Worker(url);
        }
      `;
      document.head.appendChild(script);
    });

    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    expect(signals.workerBombDetected).toBe(true);
    expect(signals.fullscreenRequested).toBe(false);

    await browser.close();
  }, 30000);

  it("should not detect worker bomb when few workers are spawned (legitimate usage)", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    await page.goto("https://example.com");

    // Legitimate sites may use a handful of workers for tasks like analytics or image processing
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = `
        const workerCode = 'self.onmessage = function(e) { postMessage(e.data * 2); }';
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        for (let i = 0; i < 5; i++) {
          new Worker(url);
        }
      `;
      document.head.appendChild(script);
    });

    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    expect(signals.workerBombDetected).toBe(false);

    await browser.close();
  }, 30000);

  it("should detect worker bomb hidden in beforeunload handler via triggerNavigationSignals", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    await page.goto("https://example.com");

    // Simulate the real scam pattern: register a beforeunload handler that spawns a worker bomb.
    // The bomb only fires when the user tries to leave the page.
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = `
        window.addEventListener('beforeunload', function(e) {
          const workerCode = 'let c = 0; while (true) { c++; Math.random() * Math.random(); }';
          const blob = new Blob([workerCode], { type: 'application/javascript' });
          const url = URL.createObjectURL(blob);
          // Spawn a batch of workers to freeze the browser
          for (let i = 0; i < 30; i++) {
            new Worker(url);
          }
          e.returnValue = 'Do you want to leave?';
        });
      `;
      document.head.appendChild(script);
    });

    // Initial collection should NOT detect the bomb (it hasn't fired yet)
    await signalService.collectApiSignals(page);
    expect(signalService.getSignals().workerBombDetected).toBe(false);

    // triggerNavigationSignals dispatches beforeunload, which fires the bomb
    await signalService.triggerNavigationSignals(page);
    const signals = signalService.getSignals();

    expect(signals.workerBombDetected).toBe(true);

    await browser.close();
  }, 30000);

  it("should detect worker bomb hidden in onbeforeunload assignment via detectAllSignals", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    await page.goto("https://example.com");

    // Scam pages sometimes use direct property assignment instead of addEventListener.
    // Must use script injection (not page.evaluate) so the handler and Workers run in the
    // page world where the addInitScript Worker proxy is active.
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = `
        window.onbeforeunload = function(e) {
          var workerCode = 'while (true) { Math.random(); }';
          var blob = new Blob([workerCode], { type: 'application/javascript' });
          var url = URL.createObjectURL(blob);
          for (var i = 0; i < 25; i++) {
            new Worker(url);
          }
          return 'Are you sure?';
        };
      `;
      document.head.appendChild(script);
    });

    // detectAllSignals should handle the full flow: collect + trigger navigation signals
    const signals = await signalService.detectAllSignals(page, "https://example.com");

    expect(signals.workerBombDetected).toBe(true);

    await browser.close();
  }, 30000);

  it("should detect page freeze via timer drift", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    await page.goto("https://example.com");

    // Inject script that blocks the main thread for 2 seconds
    // This will cause timer drift to exceed the 1 second threshold
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = `
        const start = Date.now();
        while (Date.now() - start < 2000) {
          // Busy loop to block main thread
        }
      `;
      document.head.appendChild(script);
    });

    // Wait a bit for the drift detection interval to fire after the freeze
    await page.waitForTimeout(500);

    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    expect(signals.pageLoadFrozen).toBe(true);

    await browser.close();
  }, 30000);

  it("should not detect page freeze on a responsive page", async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    await signalService.attachApiListeners(page);
    await page.goto("https://example.com");

    // Wait for a few drift check intervals to pass
    await page.waitForTimeout(1000);

    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    expect(signals.pageLoadFrozen).toBe(false);

    await browser.close();
  }, 30000);
});
