import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { BrowserReportService } from "../../src/services/browserReportService.js";

describe("BrowserReportService", () => {
  let service: BrowserReportService;

  beforeAll(async () => {
    service = new BrowserReportService();
    await service.init();
  });

  afterAll(async () => {
    await service.close();
  });

  it("should report to SmartScreen", async () => {
    // demonstration report site that is safe for testing
    const url = "https://nav.smartscreen.msft.net/other/malware.html";

    const result = await service.reportToSmartScreen(url);

    expect(result).toBe(true);
  });

  it("should report to Google Safe Browsing", async () => {
    // Google's Safe Browsing demo page, safe to report as a test
    const url = "https://testsafebrowsing.appspot.com/s/phishing.html";
    const details =
      "Automated test submission from a scam-reporting pipeline; this is Google's " +
      "Safe Browsing demo page. Please disregard.";

    const result = await service.reportToGoogleSafeBrowsing(url, details);

    expect(result).toBe("success");
  });
});
