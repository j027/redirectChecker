import { Page, BrowserContext } from "patchright";
import { parse as parseTldts } from "tldts";
import { isIP } from "net";
import crypto from "crypto";

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
  workerBombDetected: boolean;  // Many web workers spawned rapidly (scam tactic to freeze browser)
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
    workerBombDetected: false,
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
    signals.isIpAddress ||
    signals.workerBombDetected
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
  "b-cdn.net",
];

export class SignalService {
  private signals: DetectedSignals = createEmptySignals();
  private apiCallListenerAttached: boolean = false;
  private bindingName: string = '';

  /**
   * Generates a random binding name to reduce fingerprinting
   */
  private generateBindingName(): string {
    const randomHex = crypto.randomBytes(16).toString('hex');
    return `__sb_${randomHex}`;
  }

  /**
   * Resets all signals to their default (false) state
   */
  public reset(): void {
    this.signals = createEmptySignals();
    this.apiCallListenerAttached = false;
    this.bindingName = '';
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
      this.signals.pageLoadFrozen ||
      this.signals.workerBombDetected
    );
  }

  /**
   * Attaches listeners to detect suspicious API calls on a page.
   * Uses a hidden DOM element to store signal state, which is then
   * read by collectApiSignals. This approach works reliably with
   * addInitScript since DOM manipulation works from init scripts.
   * Should be called before navigating to the target URL.
   */
  public async attachApiListeners(page: Page): Promise<void> {
    if (this.apiCallListenerAttached) {
      return;
    }

    // Generate a random element ID to reduce fingerprinting
    this.bindingName = this.generateBindingName();

    // Inject the hooks that store signals in a hidden DOM element
    await page.addInitScript((elementId: string) => {
      // Create hidden element to store signals (created on first signal)
      const getOrCreateSignalElement = () => {
        let el = document.getElementById(elementId);
        if (!el) {
          el = document.createElement('div');
          el.id = elementId;
          el.style.display = 'none';
          el.setAttribute('data-fullscreen', 'false');
          el.setAttribute('data-keyboard', 'false');
          el.setAttribute('data-pointer', 'false');
          el.setAttribute('data-worker-bomb', 'false');
          el.setAttribute('data-worker-count', '0');
          el.setAttribute('data-page-frozen', 'false');
          // Append to documentElement to work before body exists
          (document.documentElement || document.body || document).appendChild(el);
        }
        return el;
      };

      // Helper to set a signal
      const setSignal = (type: 'fullscreen' | 'keyboard' | 'pointer' | 'worker-bomb' | 'page-frozen') => {
        try {
          const el = getOrCreateSignalElement();
          el.setAttribute(`data-${type}`, 'true');
        } catch {
          // Ignore errors
        }
      };

      // Timer drift detection for page freeze/lag
      // Detects when JavaScript execution is blocked (busy loops, etc.)
      const DRIFT_CHECK_INTERVAL = 200;  // Check every 200ms
      const DRIFT_THRESHOLD = 1000;       // 1 second of drift indicates freeze
      let lastCheckTime = Date.now();
      
      try {
        setInterval(() => {
          const now = Date.now();
          const expectedElapsed = DRIFT_CHECK_INTERVAL;
          const actualElapsed = now - lastCheckTime;
          const drift = actualElapsed - expectedElapsed;
          
          if (drift > DRIFT_THRESHOLD) {
            setSignal('page-frozen');
          }
          
          lastCheckTime = now;
        }, DRIFT_CHECK_INTERVAL);
      } catch {
        // Ignore errors
      }

      // Worker bomb detection threshold
      const WORKER_BOMB_THRESHOLD = 5;

      // Hook Worker constructor to detect worker bombs
      try {
        const OriginalWorker = (window as any).Worker;
        if (typeof OriginalWorker === 'function') {
          (window as any).Worker = new Proxy(OriginalWorker, {
            construct(target, args, newTarget) {
              // Count workers and check threshold
              try {
                const el = getOrCreateSignalElement();
                const currentCount = parseInt(el.getAttribute('data-worker-count') || '0', 10);
                const newCount = currentCount + 1;
                el.setAttribute('data-worker-count', String(newCount));
                
                if (newCount >= WORKER_BOMB_THRESHOLD) {
                  setSignal('worker-bomb');
                }
              } catch {
                // Ignore errors
              }
              return Reflect.construct(target, args, newTarget);
            }
          });
        }
      } catch {
        // API not available
      }

      // Hook requestFullscreen
      try {
        const originalFullscreen = Element.prototype.requestFullscreen;
        Element.prototype.requestFullscreen = new Proxy(originalFullscreen, {
          apply(target, ctx, args) {
            setSignal('fullscreen');
            return Reflect.apply(target, ctx, args);
          }
        });
      } catch {
        // API not available
      }

      // Hook webkitRequestFullscreen (prefixed version)
      try {
        const proto = Element.prototype as any;
        if (typeof proto.webkitRequestFullscreen === 'function') {
          const originalWebkitFullscreen = proto.webkitRequestFullscreen;
          proto.webkitRequestFullscreen = new Proxy(originalWebkitFullscreen, {
            apply(target, ctx, args) {
              setSignal('fullscreen');
              return Reflect.apply(target, ctx, args);
            }
          });
        }
      } catch {
        // API not available
      }

      // Hook navigator.keyboard.lock
      try {
        const nav = navigator as any;
        if (nav.keyboard && typeof nav.keyboard.lock === 'function') {
          const originalLock = nav.keyboard.lock.bind(nav.keyboard);
          nav.keyboard.lock = new Proxy(originalLock, {
            apply(target, ctx, args) {
              setSignal('keyboard');
              return Reflect.apply(target, ctx, args);
            }
          });
        }
      } catch {
        // API not available
      }

      // Hook requestPointerLock
      try {
        const originalPointerLock = Element.prototype.requestPointerLock;
        Element.prototype.requestPointerLock = new Proxy(originalPointerLock, {
          apply(target, ctx, args) {
            setSignal('pointer');
            return Reflect.apply(target, ctx, args);
          }
        });
      } catch {
        // API not available
      }
    }, this.bindingName);

    this.apiCallListenerAttached = true;
  }

  /**
   * Collects the API call signals from the hidden DOM element.
   * Call this after the page has loaded and APIs may have been called.
   */
  public async collectApiSignals(page: Page): Promise<void> {
    const elementId = this.bindingName;
    if (!elementId) {
      return;
    }

    try {
      const signals = await page.evaluate((id: string) => {
        const el = document.getElementById(id);
        if (!el) {
          return { fullscreen: false, keyboard: false, pointer: false, workerBomb: false, pageFrozen: false };
        }
        return {
          fullscreen: el.getAttribute('data-fullscreen') === 'true',
          keyboard: el.getAttribute('data-keyboard') === 'true',
          pointer: el.getAttribute('data-pointer') === 'true',
          workerBomb: el.getAttribute('data-worker-bomb') === 'true',
          pageFrozen: el.getAttribute('data-page-frozen') === 'true',
        };
      }, elementId);

      this.signals.fullscreenRequested = signals.fullscreen;
      this.signals.keyboardLockRequested = signals.keyboard;
      this.signals.pointerLockRequested = signals.pointer;
      this.signals.workerBombDetected = signals.workerBomb;
      this.signals.pageLoadFrozen = signals.pageFrozen;
    } catch {
      // Ignore errors - element may not exist yet
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
   * Performs full signal detection on a page.
   * Collects API signals from DOM and analyzes the URL.
   */
  public async detectAllSignals(page: Page, url: string): Promise<DetectedSignals> {
    // Analyze the URL for hosting signals
    this.analyzeUrl(url);

    // Collect API signals from the hidden DOM element
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
