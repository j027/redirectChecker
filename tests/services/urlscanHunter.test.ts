import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UrlscanHunter } from "../../src/services/urlscanHunter.js";

// Mock external dependencies
vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

vi.mock("../../src/services/aiClassifierService.js", () => ({
  aiClassifierService: {
    runInference: vi.fn(),
    isWhitelisted: vi.fn().mockReturnValue(false),
  },
}));

vi.mock("../../src/services/reportService.js", () => ({
  reportToNetcraft: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/scamReportLogger.js", () => ({
  logScamReport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/dbPool.js", () => ({
  default: {
    query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }),
  },
}));

vi.mock("../../src/services/browserManagerService.js", () => ({
  BrowserManagerService: {
    createBrowser: vi.fn(),
    closeBrowser: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../../src/utils/playwrightUtilities.js", () => ({
  parseProxy: vi.fn().mockResolvedValue(undefined),
  blockGoogleAnalytics: vi.fn().mockResolvedValue(undefined),
  spoofWindowsChrome: vi.fn().mockResolvedValue(undefined),
  simulateRandomMouseMovements: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/services/signalService.js", () => {
  const createEmptySignals = () => ({
    fullscreenRequested: false,
    keyboardLockRequested: false,
    pointerLockRequested: false,
    isThirdPartyHosting: false,
    isIpAddress: false,
    pageLoadFrozen: false,
    workerBombDetected: false,
  });

  return {
    createSignalService: vi.fn().mockReturnValue({
      attachApiListeners: vi.fn().mockResolvedValue(undefined),
      detectAllSignals: vi.fn().mockResolvedValue(createEmptySignals()),
      getSignals: vi.fn().mockReturnValue({
        ...createEmptySignals(),
        isThirdPartyHosting: true, // default: signal present
      }),
    }),
    createEmptySignals,
    hasWeightedSignal: vi.fn().mockReturnValue(true),
  };
});

// Get mocked modules for assertions
import { fetch } from "undici";
import { aiClassifierService } from "../../src/services/aiClassifierService.js";
import { reportToNetcraft } from "../../src/services/reportService.js";
import { logScamReport } from "../../src/services/scamReportLogger.js";
import pool from "../../src/dbPool.js";

const mockFetch = vi.mocked(fetch);
const mockRunInference = vi.mocked(aiClassifierService.runInference);
const mockIsWhitelisted = vi.mocked(aiClassifierService.isWhitelisted);
const mockReportToNetcraft = vi.mocked(reportToNetcraft);
const mockLogScamReport = vi.mocked(logScamReport);
const mockPoolQuery = vi.mocked(pool.query);

function makeFeedResult(overrides: Record<string, unknown> = {}) {
  const uuid = overrides.uuid ?? "test-uuid-001";
  return {
    task: {
      uuid,
      url: "https://example-test-site.pages.dev/",
      domain: "example-test-site.pages.dev",
      time: "2026-03-10T00:00:00.000Z",
    },
    page: {
      url: "https://example-test-site.pages.dev/",
      domain: "example-test-site.pages.dev",
    },
    screenshot: "https://urlscan.io/screenshots/test-uuid-001.png",
    _id: uuid,
    ...overrides,
  };
}

describe("UrlscanHunter", () => {
  let hunter: UrlscanHunter;

  beforeEach(() => {
    hunter = new UrlscanHunter();
    vi.clearAllMocks();

    // Default: DB says not already processed/reported
    mockPoolQuery.mockResolvedValue({ rowCount: 0, rows: [] } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("runCycle", () => {
    it("should return true when feed is empty", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ results: [], has_more: false }),
      } as any);

      const result = await hunter.runCycle();
      expect(result).toBe(true);
    });

    it("should return true on successful cycle with results", async () => {
      // Feed returns one result
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [makeFeedResult()],
          has_more: false,
        }),
      } as any);

      // Screenshot download
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      } as any);

      // Classifier says not scam
      mockRunInference.mockResolvedValueOnce({
        isScam: false,
        confidenceScore: 0.3,
      });

      const result = await hunter.runCycle();
      expect(result).toBe(true);
      expect(mockReportToNetcraft).not.toHaveBeenCalled();
    });

    it("should return false on feed fetch failure", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await hunter.runCycle();
      expect(result).toBe(false);
    });
  });

  describe("deduplication", () => {
    it("should skip whitelisted URLs", async () => {
      mockIsWhitelisted.mockReturnValueOnce(true);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [makeFeedResult()],
          has_more: false,
        }),
      } as any);

      await hunter.runCycle();

      // Should not download screenshot
      expect(mockFetch).toHaveBeenCalledTimes(1); // only feed fetch
    });

    it("should skip already-processed UUIDs (in-memory)", async () => {
      const result1 = makeFeedResult({ uuid: "dup-uuid" });
      const result2 = makeFeedResult({ uuid: "dup-uuid" });

      // First cycle with result1
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [result1],
          has_more: false,
        }),
      } as any);

      // Screenshot download
      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      } as any);

      mockRunInference.mockResolvedValueOnce({
        isScam: false,
        confidenceScore: 0.2,
      });

      await hunter.runCycle();

      // Second cycle with same UUID
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [result2],
          has_more: false,
        }),
      } as any);

      await hunter.runCycle();

      // Screenshot should only be fetched once (first cycle)
      // Feed fetched twice, screenshot once = 3 total fetches
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it("should skip URLs already in scam_reports", async () => {
      // DB says already reported
      mockPoolQuery
        .mockResolvedValueOnce({ rowCount: 0, rows: [] } as any) // incrementScanCount
        .mockResolvedValueOnce({ rowCount: 0, rows: [] } as any) // isAlreadyProcessed
        .mockResolvedValueOnce({ rowCount: 1, rows: [{}] } as any); // isAlreadyReported

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [makeFeedResult()],
          has_more: false,
        }),
      } as any);

      await hunter.runCycle();

      // Should not download screenshot
      expect(mockRunInference).not.toHaveBeenCalled();
    });
  });

  describe("classification filtering", () => {
    it("should not report when classifier confidence is below threshold", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [makeFeedResult()],
          has_more: false,
        }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      } as any);

      mockRunInference.mockResolvedValueOnce({
        isScam: true,
        confidenceScore: 0.85, // below 0.90 threshold
      });

      await hunter.runCycle();
      expect(mockReportToNetcraft).not.toHaveBeenCalled();
    });

    it("should not report when classifier says not scam", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [makeFeedResult()],
          has_more: false,
        }),
      } as any);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new ArrayBuffer(100),
      } as any);

      mockRunInference.mockResolvedValueOnce({
        isScam: false,
        confidenceScore: 0.95,
      });

      await hunter.runCycle();
      expect(mockReportToNetcraft).not.toHaveBeenCalled();
    });
  });

  describe("stats tracking", () => {
    it("should increment scan count for each batch of results", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          results: [
            makeFeedResult({ uuid: "uuid-1", _id: "uuid-1" }),
            makeFeedResult({ uuid: "uuid-2", _id: "uuid-2" }),
            makeFeedResult({ uuid: "uuid-3", _id: "uuid-3" }),
          ],
          has_more: false,
        }),
      } as any);

      // Screenshots
      for (let i = 0; i < 3; i++) {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          arrayBuffer: async () => new ArrayBuffer(100),
        } as any);
      }

      mockRunInference.mockResolvedValue({
        isScam: false,
        confidenceScore: 0.2,
      });

      await hunter.runCycle();

      // First pool.query call should be the scan count increment with count=3
      expect(mockPoolQuery).toHaveBeenCalledWith(
        expect.stringContaining("urlscan_scan_stats"),
        [3]
      );
    });
  });
});
