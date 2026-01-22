import { Page, BrowserContext } from "patchright";
import { parse as parseTldts } from "tldts";
import { isIP } from "net";

/**
 * Signals detected during page analysis
 * These are suspicious behaviors commonly used by scam sites
 */
export interface DetectedSignals {
  fullscreenRequested: boolean;
  keyboardLockRequested: boolean;
  pointerLockRequested: boolean;
  isThirdPartyHosting: boolean;
  isIpAddress: boolean;
  pageLoadFrozen: boolean;      // Advisory: page took too long to load
  // workerBombDetected: boolean; // TODO: implement later
}

/**
 * Creates a default signals object with all flags set to false
 */
export function createEmptySignals(): DetectedSignals {
  return {
    fullscreenRequested: false,
    keyboardLockRequested: false,
    pointerLockRequested: false,
    isThirdPartyHosting: false,
    isIpAddress: false,
    pageLoadFrozen: false,
  };
}

/**
 * Checks if a signals object has any weighted (non-advisory) signal triggered.
 * Used for scam decision: classifier + confidence + hasWeightedSignal
 * Note: pageLoadFrozen is advisory only and NOT included
 */
export function hasWeightedSignal(signals: DetectedSignals): boolean {
  return (
    signals.fullscreenRequested ||
    signals.keyboardLockRequested ||
    signals.pointerLockRequested ||
    signals.isThirdPartyHosting ||
    signals.isIpAddress
  );
}

/**
 * Additional third-party hosting domains not in the PSL private list
 * These are checked in addition to the PSL isPrivate check
 */
const ADDITIONAL_THIRD_PARTY_HOSTING = [
  "web.core.windows.net",
  "surge.sh",
  "glitch.me",
];

export class SignalService {
  private signals: DetectedSignals = createEmptySignals();
  private apiCallListenerAttached: boolean = false;

  /**
   * Resets all signals to their default (false) state
   */
  public reset(): void {
    this.signals = createEmptySignals();
    this.apiCallListenerAttached = false;
  }

  /**
   * Gets the current state of all detected signals
   */
  public getSignals(): DetectedSignals {
    return { ...this.signals };
  }

  /**
   * Checks if at least one weighted signal (non-advisory) has been triggered
   * Used for scam decision: classifier + confidence + hasWeightedSignal
   * Note: pageLoadFrozen is advisory only and NOT included
   */
  public hasWeightedSignal(): boolean {
    return hasWeightedSignal(this.signals);
  }

  /**
   * Checks if at least one signal (including advisory) has been triggered
   * Used for logging purposes only
   */
  public hasAnySignal(): boolean {
    return (
      this.signals.fullscreenRequested ||
      this.signals.keyboardLockRequested ||
      this.signals.pointerLockRequested ||
      this.signals.isThirdPartyHosting ||
      this.signals.isIpAddress ||
      this.signals.pageLoadFrozen
    );
  }

  /**
   * Attaches listeners to detect suspicious API calls on a page
   * Should be called before navigating to the target URL
   */
  public async attachApiListeners(page: Page): Promise<void> {
    if (this.apiCallListenerAttached) {
      return;
    }

    // Inject script to intercept suspicious API calls
    await page.addInitScript(() => {
      // Track API calls via a global object
      (window as any).__signalDetection = {
        fullscreenRequested: false,
        keyboardLockRequested: false,
        pointerLockRequested: false,
      };

      // Intercept fullscreen requests
      const originalRequestFullscreen = Element.prototype.requestFullscreen;
      Element.prototype.requestFullscreen = function (...args) {
        (window as any).__signalDetection.fullscreenRequested = true;
        console.log("[SIGNAL] Fullscreen API requested");
        return originalRequestFullscreen.apply(this, args);
      };

      // Also intercept webkit/moz prefixed versions
      const webkitFullscreen = (Element.prototype as any).webkitRequestFullscreen;
      if (webkitFullscreen) {
        (Element.prototype as any).webkitRequestFullscreen = function (...args: any[]) {
          (window as any).__signalDetection.fullscreenRequested = true;
          console.log("[SIGNAL] Webkit Fullscreen API requested");
          return webkitFullscreen.apply(this, args);
        };
      }

      // Intercept keyboard lock
      const nav = navigator as any;
      if (nav.keyboard && nav.keyboard.lock) {
        const originalKeyboardLock = nav.keyboard.lock.bind(nav.keyboard);
        nav.keyboard.lock = function (...args: any[]) {
          (window as any).__signalDetection.keyboardLockRequested = true;
          console.log("[SIGNAL] Keyboard Lock API requested");
          return originalKeyboardLock(...args);
        };
      }

      // Intercept pointer lock
      const originalRequestPointerLock = Element.prototype.requestPointerLock;
      Element.prototype.requestPointerLock = function (...args) {
        (window as any).__signalDetection.pointerLockRequested = true;
        console.log("[SIGNAL] Pointer Lock API requested");
        return originalRequestPointerLock.apply(this, args as []);
      };
    });

    this.apiCallListenerAttached = true;
  }

  /**
   * Collects the API call signals from the page after navigation
   */
  public async collectApiSignals(page: Page): Promise<void> {
    try {
      const detection = await page.evaluate(() => {
        return (window as any).__signalDetection || {
          fullscreenRequested: false,
          keyboardLockRequested: false,
          pointerLockRequested: false,
        };
      });

      this.signals.fullscreenRequested = detection.fullscreenRequested;
      this.signals.keyboardLockRequested = detection.keyboardLockRequested;
      this.signals.pointerLockRequested = detection.pointerLockRequested;
    } catch (error) {
      console.error("Error collecting API signals:", error);
    }
  }

  /**
   * Analyzes a URL to detect hosting-related signals
   */
  public analyzeUrl(url: string): void {
    try {
      const parsedUrl = new URL(url);
      const hostname = parsedUrl.hostname;

      // Check if it's an IP address
      this.signals.isIpAddress = this.checkIsIpAddress(hostname);

      // Check for third-party hosting
      if (!this.signals.isIpAddress) {
        this.signals.isThirdPartyHosting = this.checkIsThirdPartyHosting(hostname);
      }
    } catch (error) {
      console.error(`Error analyzing URL ${url}:`, error);
    }
  }

  /**
   * Checks if the hostname is an IP address
   */
  public checkIsIpAddress(hostname: string): boolean {
    // isIP returns 0 for invalid, 4 for IPv4, 6 for IPv6
    return isIP(hostname) !== 0;
  }

  /**
   * Checks if the hostname is using third-party hosting
   * Uses tldts to check if the domain uses a private suffix from the PSL
   * Also checks against a small list of known hosts not in the PSL
   */
  public checkIsThirdPartyHosting(hostname: string): boolean {
    const parsed = parseTldts(hostname, { allowPrivateDomains: true });
    
    // Check PSL private suffixes (blogspot.com, github.io, ondigitalocean.app, etc.)
    if (parsed.isPrivate === true) {
      return true;
    }

    // Check additional domains not in PSL
    const lowercaseHostname = hostname.toLowerCase();
    for (const domain of ADDITIONAL_THIRD_PARTY_HOSTING) {
      if (lowercaseHostname === domain || lowercaseHostname.endsWith(`.${domain}`)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Monitors page load and sets the frozen signal if it takes too long
   * @param page The page to monitor
   * @param timeoutMs Timeout in milliseconds (default 30 seconds)
   */
  public async monitorPageLoad(page: Page, timeoutMs: number = 30000): Promise<void> {
    const startTime = Date.now();
    
    try {
      await page.waitForLoadState("load", { timeout: timeoutMs });
    } catch (error) {
      // If we timeout, the page might be frozen or intentionally slow
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        this.signals.pageLoadFrozen = true;
        console.log(`[SIGNAL] Page load frozen - took longer than ${timeoutMs}ms`);
      }
    }
  }

  /**
   * Performs full signal detection on a page
   * This is a convenience method that runs all applicable checks
   */
  public async detectAllSignals(page: Page, url: string): Promise<DetectedSignals> {
    // Analyze the URL for hosting signals
    this.analyzeUrl(url);

    // Collect API signals from the page
    await this.collectApiSignals(page);

    return this.getSignals();
  }
}

/**
 * Factory function to create a new SignalService instance
 * Each page/context should have its own instance
 */
export function createSignalService(): SignalService {
  return new SignalService();
}
