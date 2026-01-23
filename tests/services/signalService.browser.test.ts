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
});
