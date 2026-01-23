import { describe, it, expect } from "vitest";
import { chromium } from "patchright";
import { createSignalService } from "../../src/services/signalService.js";

describe("SignalService Browser Integration - Manual Testing", () => {
  
  it.only("manual - fullscreen detection with keyboard-lock demo", async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    console.log('\n========================================');
    console.log('Fullscreen Detection Test');
    console.log('========================================');
    console.log('1. Attach signal listeners...');
    await signalService.attachApiListeners(page);

    console.log('2. Navigate to keyboard-lock demo...');
    await page.goto("https://chrome.dev/keyboard-lock/");

    console.log('\n>>> You have 30 seconds to click the FULLSCREEN button on the page <<<');
    console.log('>>> Check browser console for activity <<<\n');
    
    await page.waitForTimeout(30000);

    console.log('3. Collecting signals...');
    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    console.log('\n========================================');
    console.log('RESULTS:');
    console.log('========================================');
    console.log('Fullscreen Requested:', signals.fullscreenRequested);
    console.log('Keyboard Lock Requested:', signals.keyboardLockRequested);
    console.log('Pointer Lock Requested:', signals.pointerLockRequested);
    console.log('========================================\n');

    await browser.close();

    expect(signals.fullscreenRequested).toBe(true);
  }, 60000);

  it.skip("manual - keyboard lock detection with chrome.dev demo", async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    console.log('\n========================================');
    console.log('Keyboard Lock Detection Test');
    console.log('========================================');
    console.log('1. Attach signal listeners...');
    await signalService.attachApiListeners(page);

    console.log('2. Navigate to keyboard lock demo...');
    await page.goto("https://chrome.dev/keyboard-lock/");

    console.log('\n>>> You have 30 seconds to interact with the demo <<<');
    console.log('>>> Try triggering keyboard lock <<<');
    console.log('>>> Check browser console for activity <<<\n');
    
    await page.waitForTimeout(30000);

    console.log('3. Collecting signals...');
    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    console.log('\n========================================');
    console.log('RESULTS:');
    console.log('========================================');
    console.log('Fullscreen Requested:', signals.fullscreenRequested);
    console.log('Keyboard Lock Requested:', signals.keyboardLockRequested);
    console.log('Pointer Lock Requested:', signals.pointerLockRequested);
    console.log('========================================\n');

    await browser.close();

    expect(signals.keyboardLockRequested).toBe(true);
  }, 60000);

  it.skip("manual - pointer lock detection with example.com", async () => {
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    const signalService = createSignalService();

    console.log('\n========================================');
    console.log('Pointer Lock Detection Test');
    console.log('========================================');
    console.log('1. Attach signal listeners...');
    await signalService.attachApiListeners(page);

    console.log('2. Navigate to example.com...');
    await page.goto("https://example.com");

    console.log('3. Adding pointer lock button to page...');
    await page.evaluate(() => {
      const btn = document.createElement("button");
      btn.id = "pointer-lock-btn";
      btn.textContent = "CLICK ME TO LOCK POINTER";
      btn.style.cssText = "position: fixed; top: 20px; left: 20px; padding: 20px; font-size: 20px; z-index: 9999; background: blue; color: white; cursor: pointer;";
      btn.onclick = () => {
        console.log('Button clicked - requesting pointer lock');
        btn.requestPointerLock();
      };
      document.body.appendChild(btn);
    });

    console.log('\n>>> You have 30 seconds to click the blue button <<<');
    console.log('>>> Check browser console for activity <<<\n');
    
    await page.waitForTimeout(30000);

    console.log('4. Collecting signals...');
    await signalService.collectApiSignals(page);
    const signals = signalService.getSignals();

    console.log('\n========================================');
    console.log('RESULTS:');
    console.log('========================================');
    console.log('Fullscreen Requested:', signals.fullscreenRequested);
    console.log('Keyboard Lock Requested:', signals.keyboardLockRequested);
    console.log('Pointer Lock Requested:', signals.pointerLockRequested);
    console.log('========================================\n');

    await browser.close();

    expect(signals.pointerLockRequested).toBe(true);
  }, 60000);
});
