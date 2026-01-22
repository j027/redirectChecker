import { describe, it, expect, beforeEach } from "vitest";
import { 
  SignalService, 
  createSignalService, 
  createEmptySignals,
  hasWeightedSignal,
  DetectedSignals 
} from "../../src/services/signalService.js";

describe("SignalService", () => {
  let signalService: SignalService;

  beforeEach(() => {
    signalService = createSignalService();
  });

  describe("createEmptySignals", () => {
    it("should return an object with all signals set to false", () => {
      const signals = createEmptySignals();
      
      expect(signals.fullscreenRequested).toBe(false);
      expect(signals.keyboardLockRequested).toBe(false);
      expect(signals.pointerLockRequested).toBe(false);
      expect(signals.isThirdPartyHosting).toBe(false);
      expect(signals.isIpAddress).toBe(false);
      expect(signals.pageLoadFrozen).toBe(false);
    });
  });

  describe("reset", () => {
    it("should reset all signals to false", () => {
      // Manually trigger some signals via URL analysis
      signalService.analyzeUrl("http://192.168.1.1/scam");
      expect(signalService.getSignals().isIpAddress).toBe(true);

      signalService.reset();
      
      const signals = signalService.getSignals();
      expect(signals.isIpAddress).toBe(false);
      expect(signalService.hasAnySignal()).toBe(false);
    });
  });

  describe("checkIsIpAddress", () => {
    it("should return true for IPv4 addresses", () => {
      expect(signalService.checkIsIpAddress("192.168.1.1")).toBe(true);
      expect(signalService.checkIsIpAddress("10.0.0.1")).toBe(true);
      expect(signalService.checkIsIpAddress("8.8.8.8")).toBe(true);
      expect(signalService.checkIsIpAddress("255.255.255.255")).toBe(true);
    });

    it("should return true for IPv6 addresses", () => {
      expect(signalService.checkIsIpAddress("::1")).toBe(true);
      expect(signalService.checkIsIpAddress("2001:db8::1")).toBe(true);
      expect(signalService.checkIsIpAddress("fe80::1")).toBe(true);
    });

    it("should return false for domain names", () => {
      expect(signalService.checkIsIpAddress("example.com")).toBe(false);
      expect(signalService.checkIsIpAddress("www.google.com")).toBe(false);
      expect(signalService.checkIsIpAddress("sub.domain.example.org")).toBe(false);
    });

    it("should return false for invalid IP addresses", () => {
      expect(signalService.checkIsIpAddress("999.999.999.999")).toBe(false);
      expect(signalService.checkIsIpAddress("192.168.1")).toBe(false);
      expect(signalService.checkIsIpAddress("not-an-ip")).toBe(false);
    });
  });

  describe("checkIsThirdPartyHosting", () => {
    it("should return true for known third-party hosting domains", () => {
      // Cloud providers (via PSL isPrivate)
      expect(signalService.checkIsThirdPartyHosting("scam-site.ondigitalocean.app")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("malicious.azurewebsites.net")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("phishing.herokuapp.com")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("fake.netlify.app")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("scam.vercel.app")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("bad.pages.dev")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("evil.web.app")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("scam.firebaseapp.com")).toBe(true);
      
      // Static hosting / CDN (via PSL isPrivate)
      expect(signalService.checkIsThirdPartyHosting("malware.github.io")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("phish.gitlab.io")).toBe(true);
      
      // Additional list (not in PSL)
      expect(signalService.checkIsThirdPartyHosting("scam.surge.sh")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("bad.glitch.me")).toBe(true);
      
      // Website builders (via PSL isPrivate)
      expect(signalService.checkIsThirdPartyHosting("phishing.blogspot.com")).toBe(true);
    });

    it("should return true for private suffix domains (via tldts)", () => {
      // These should be detected via tldts isPrivate check
      expect(signalService.checkIsThirdPartyHosting("anything.blogspot.com")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("random.github.io")).toBe(true);
    });

    it("should return false for regular domains", () => {
      expect(signalService.checkIsThirdPartyHosting("google.com")).toBe(false);
      expect(signalService.checkIsThirdPartyHosting("www.microsoft.com")).toBe(false);
      expect(signalService.checkIsThirdPartyHosting("example.org")).toBe(false);
      expect(signalService.checkIsThirdPartyHosting("legitimate-business.com")).toBe(false);
    });

    it("should return false for common legitimate sites", () => {
      expect(signalService.checkIsThirdPartyHosting("amazon.com")).toBe(false);
      expect(signalService.checkIsThirdPartyHosting("facebook.com")).toBe(false);
      expect(signalService.checkIsThirdPartyHosting("twitter.com")).toBe(false);
    });
  });

  describe("analyzeUrl", () => {
    it("should detect IP address URLs", () => {
      signalService.analyzeUrl("http://192.168.1.1/malware.exe");
      
      const signals = signalService.getSignals();
      expect(signals.isIpAddress).toBe(true);
      expect(signals.isThirdPartyHosting).toBe(false);
    });

    it("should detect third-party hosting URLs", () => {
      signalService.analyzeUrl("https://scam-site.herokuapp.com/phishing");
      
      const signals = signalService.getSignals();
      expect(signals.isThirdPartyHosting).toBe(true);
      expect(signals.isIpAddress).toBe(false);
    });

    it("should not set any hosting signals for regular domains", () => {
      signalService.analyzeUrl("https://www.example.com/page");
      
      const signals = signalService.getSignals();
      expect(signals.isIpAddress).toBe(false);
      expect(signals.isThirdPartyHosting).toBe(false);
    });

    it("should handle invalid URLs gracefully", () => {
      signalService.analyzeUrl("not-a-valid-url");
      
      const signals = signalService.getSignals();
      expect(signals.isIpAddress).toBe(false);
      expect(signals.isThirdPartyHosting).toBe(false);
    });
  });

  describe("hasAnySignal", () => {
    it("should return false when no signals are triggered", () => {
      expect(signalService.hasAnySignal()).toBe(false);
    });

    it("should return true when isIpAddress is triggered", () => {
      signalService.analyzeUrl("http://192.168.1.1/");
      expect(signalService.hasAnySignal()).toBe(true);
    });

    it("should return true when isThirdPartyHosting is triggered", () => {
      signalService.analyzeUrl("https://scam.herokuapp.com/");
      expect(signalService.hasAnySignal()).toBe(true);
    });
  });

  describe("hasWeightedSignal (standalone function)", () => {
    it("should return false for empty signals", () => {
      const signals = createEmptySignals();
      expect(hasWeightedSignal(signals)).toBe(false);
    });

    it("should return true for fullscreenRequested", () => {
      const signals = { ...createEmptySignals(), fullscreenRequested: true };
      expect(hasWeightedSignal(signals)).toBe(true);
    });

    it("should return true for keyboardLockRequested", () => {
      const signals = { ...createEmptySignals(), keyboardLockRequested: true };
      expect(hasWeightedSignal(signals)).toBe(true);
    });

    it("should return true for pointerLockRequested", () => {
      const signals = { ...createEmptySignals(), pointerLockRequested: true };
      expect(hasWeightedSignal(signals)).toBe(true);
    });

    it("should return true for isThirdPartyHosting", () => {
      const signals = { ...createEmptySignals(), isThirdPartyHosting: true };
      expect(hasWeightedSignal(signals)).toBe(true);
    });

    it("should return true for isIpAddress", () => {
      const signals = { ...createEmptySignals(), isIpAddress: true };
      expect(hasWeightedSignal(signals)).toBe(true);
    });

    it("should return false for pageLoadFrozen only (advisory signal)", () => {
      const signals = { ...createEmptySignals(), pageLoadFrozen: true };
      expect(hasWeightedSignal(signals)).toBe(false);
    });

    it("should return true when pageLoadFrozen is combined with a weighted signal", () => {
      const signals = { ...createEmptySignals(), pageLoadFrozen: true, isIpAddress: true };
      expect(hasWeightedSignal(signals)).toBe(true);
    });
  });

  describe("hasWeightedSignal (service method)", () => {
    it("should return false when no signals are triggered", () => {
      expect(signalService.hasWeightedSignal()).toBe(false);
    });

    it("should return true when isIpAddress is triggered", () => {
      signalService.analyzeUrl("http://192.168.1.1/");
      expect(signalService.hasWeightedSignal()).toBe(true);
    });

    it("should return true when isThirdPartyHosting is triggered", () => {
      signalService.analyzeUrl("https://scam.herokuapp.com/");
      expect(signalService.hasWeightedSignal()).toBe(true);
    });
  });

  describe("getSignals", () => {
    it("should return a copy of signals, not the original object", () => {
      const signals1 = signalService.getSignals();
      signals1.isIpAddress = true; // Modify the copy
      
      const signals2 = signalService.getSignals();
      expect(signals2.isIpAddress).toBe(false); // Original should be unchanged
    });
  });

  describe("Azure/Windows specific hosting patterns", () => {
    it("should detect Azure blob storage URLs", () => {
      expect(signalService.checkIsThirdPartyHosting("scamsite.blob.core.windows.net")).toBe(true);
    });

    it("should detect Azure web core URLs", () => {
      expect(signalService.checkIsThirdPartyHosting("malicious.web.core.windows.net")).toBe(true);
    });

    it("should detect Google Cloud URLs", () => {
      expect(signalService.checkIsThirdPartyHosting("scam.appspot.com")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("bad.run.app")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("evil.cloudfunctions.net")).toBe(true);
    });

    it("should detect Cloudflare hosting URLs", () => {
      expect(signalService.checkIsThirdPartyHosting("scam.pages.dev")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("malicious.workers.dev")).toBe(true);
    });
  });

  describe("Edge cases", () => {
    it("should handle URLs with ports", () => {
      signalService.analyzeUrl("http://192.168.1.1:8080/page");
      expect(signalService.getSignals().isIpAddress).toBe(true);
    });

    it("should handle URLs with authentication", () => {
      signalService.analyzeUrl("http://user:pass@192.168.1.1/page");
      expect(signalService.getSignals().isIpAddress).toBe(true);
    });

    it("should handle subdomains of third-party hosts", () => {
      expect(signalService.checkIsThirdPartyHosting("subdomain.scam.herokuapp.com")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("deep.nested.github.io")).toBe(true);
    });

    it("should be case-insensitive for domain matching", () => {
      expect(signalService.checkIsThirdPartyHosting("SCAM.HEROKUAPP.COM")).toBe(true);
      expect(signalService.checkIsThirdPartyHosting("Bad.GitHub.IO")).toBe(true);
    });
  });
});
