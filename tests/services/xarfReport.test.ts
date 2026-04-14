import { describe, it, expect } from "vitest";
import {
  buildXarfReport,
  getMatchingXarfProvider,
  XARF_PROVIDERS,
} from "../../src/services/xarfReportService.js";

describe("xarfReportService", () => {
  describe("getMatchingXarfProvider", () => {
    it("matches subdomain of on-forge.com to laravel-forge", () => {
      const provider = getMatchingXarfProvider("mysite.on-forge.com");
      expect(provider).not.toBeNull();
      expect(provider!.name).toBe("laravel-forge");
      expect(provider!.abuseEmail).toBe("security@laravel.com");
    });

    it("matches bare on-forge.com", () => {
      const provider = getMatchingXarfProvider("on-forge.com");
      expect(provider).not.toBeNull();
      expect(provider!.name).toBe("laravel-forge");
    });

    it("returns null for unmatched hostnames", () => {
      expect(getMatchingXarfProvider("example.com")).toBeNull();
      expect(getMatchingXarfProvider("herokuapp.com")).toBeNull();
    });

    it("is case-insensitive", () => {
      const provider = getMatchingXarfProvider("SITE.ON-FORGE.COM");
      expect(provider).not.toBeNull();
    });
  });

  describe("buildXarfReport", () => {
    const defaultArgs = {
      scamUrl: "https://scam.on-forge.com/fake-login",
      screenshot: null as Buffer | null,
      confidence: 0.95,
      xarfType: "fraud" as const,
      reporterOrg: "Test Org",
      reporterContact: "test@example.com",
      reporterDomain: "example.com",
    };

    it("builds a valid XARF v4 report structure", () => {
      const report = buildXarfReport(
        defaultArgs.scamUrl,
        defaultArgs.screenshot,
        defaultArgs.confidence,
        defaultArgs.xarfType,
        defaultArgs.reporterOrg,
        defaultArgs.reporterContact,
        defaultArgs.reporterDomain
      );

      expect(report.xarf_version).toBe("4.0.0");
      expect(report.report_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(report.category).toBe("content");
      expect(report.type).toBe("fraud");
      expect(report.url).toBe(defaultArgs.scamUrl);
      expect(report.source_identifier).toBe("scam.on-forge.com");
      expect(report.evidence_source).toBe("automated_scan");
      expect(report.confidence).toBe(0.95);
      expect(report.reporter.org).toBe("Test Org");
      expect(report.reporter.contact).toBe("test@example.com");
      expect(report.reporter.domain).toBe("example.com");
      expect(report.sender).toEqual(report.reporter);
      expect(report.tags).toContain("severity:high");
      expect(report.tags).toContain("detection:automated");
    });

    it("includes evidence when screenshot is provided", () => {
      const screenshot = Buffer.from("fake-png-data");
      const report = buildXarfReport(
        defaultArgs.scamUrl,
        screenshot,
        defaultArgs.confidence,
        defaultArgs.xarfType,
        defaultArgs.reporterOrg,
        defaultArgs.reporterContact,
        defaultArgs.reporterDomain
      );

      expect(report.evidence).toHaveLength(1);
      expect(report.evidence[0].content_type).toBe("image/png");
      expect(report.evidence[0].payload).toBe(screenshot.toString("base64"));
      expect(report.evidence[0].hash).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(report.evidence[0].size).toBe(screenshot.length);
    });

    it("has empty evidence when screenshot is null", () => {
      const report = buildXarfReport(
        defaultArgs.scamUrl,
        null,
        defaultArgs.confidence,
        defaultArgs.xarfType,
        defaultArgs.reporterOrg,
        defaultArgs.reporterContact,
        defaultArgs.reporterDomain
      );

      expect(report.evidence).toHaveLength(0);
    });

    it("omits confidence when undefined", () => {
      const report = buildXarfReport(
        defaultArgs.scamUrl,
        null,
        undefined,
        defaultArgs.xarfType,
        defaultArgs.reporterOrg,
        defaultArgs.reporterContact,
        defaultArgs.reporterDomain
      );

      expect(report).not.toHaveProperty("confidence");
    });

    it("sets timestamp in ISO 8601 format", () => {
      const report = buildXarfReport(
        defaultArgs.scamUrl,
        null,
        defaultArgs.confidence,
        defaultArgs.xarfType,
        defaultArgs.reporterOrg,
        defaultArgs.reporterContact,
        defaultArgs.reporterDomain
      );

      expect(new Date(report.timestamp).toISOString()).toBe(report.timestamp);
    });
  });

  describe("XARF_PROVIDERS", () => {
    it("has laravel-forge provider configured", () => {
      const forgeProvider = XARF_PROVIDERS.find(
        (p) => p.name === "laravel-forge"
      );
      expect(forgeProvider).toBeDefined();
      expect(forgeProvider!.abuseEmail).toBe("security@laravel.com");
      expect(forgeProvider!.hostPatterns).toContain("on-forge.com");
      expect(forgeProvider!.xarfType).toBe("fraud");
    });
  });
});
