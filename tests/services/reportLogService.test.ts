import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/dbPool.js", () => ({
  default: {
    query: vi.fn(),
  },
}));

import pool from "../../src/dbPool.js";
import {
  abandonStaleReports,
  finishReport,
  logSkippedReport,
  pruneReportSubmissions,
  reportInput,
  startReport,
  trackReport,
  truncateResponse,
  updateReportProgress,
} from "../../src/services/reportLogService.js";

const mockQuery = vi.mocked(pool.query);

describe("reportLogService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a queued report and returns its id", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: "42" }] } as any);

    const context = {
      sourceUrl: "https://source.example",
      redirectDestinationId: 7,
      adId: "b4d7d4a5-5a5e-4f5d-9d5d-0f4f6f0f1a2b",
      provider: null,
      metadata: { confidence_score: 0.91 },
    };
    const input = reportInput(
      "netcraft",
      "threat_intel",
      "https://scam.example",
      context,
      { extra: true }
    );

    const id = await startReport(input, {
      startedAt: new Date("2026-11-13T00:00:00.000Z"),
    });

    expect(id).toBe(42);
    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("INSERT INTO report_submissions");
    expect(params).toEqual([
      "netcraft",
      "threat_intel",
      "https://scam.example",
      "https://source.example",
      null,
      7,
      "b4d7d4a5-5a5e-4f5d-9d5d-0f4f6f0f1a2b",
      new Date("2026-11-13T00:00:00.000Z"),
      JSON.stringify({ confidence_score: 0.91, extra: true }),
    ]);
  });

  it("finishes a report with terminal details and a capped snippet", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 } as any);
    const longResponse = "x".repeat(5000);

    await finishReport(42, {
      status: "error",
      httpStatus: 429,
      externalId: "ref-1",
      externalUrl: "https://provider.example/ref-1",
      responseSnippet: longResponse,
      errorMessage: "rate limited",
      abuseReportId: 9,
      metadata: { attempt: 1 },
    });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("UPDATE report_submissions");
    expect(String(sql)).toContain("completed_at IS NULL");
    expect(params[0]).toBe(42);
    expect(params[1]).toBe("error");
    expect(params[2]).toBe(429);
    expect(params[3]).toBe("ref-1");
    expect(params[4]).toBe("https://provider.example/ref-1");
    expect(params[5]).toHaveLength(4000);
    expect(params[6]).toBe("rate limited");
    expect(params[7]).toBe(9);
    expect(params[8]).toBe(JSON.stringify({ attempt: 1 }));
  });

  it("turns a thrown reporter error into an error outcome", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "1" }] } as any)
      .mockResolvedValueOnce({ rowCount: 1 } as any);

    const outcome = await trackReport(
      reportInput("virustotal", "scan", "https://scam.example"),
      async () => {
        throw new Error("network down");
      }
    );

    expect(outcome.status).toBe("error");
    expect(outcome.errorMessage).toBe("network down");
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it("records skipped reports without attempting a send", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ id: "3" }] } as any)
      .mockResolvedValueOnce({ rowCount: 1 } as any);

    await logSkippedReport(
      reportInput("crdf", "scan", "https://scam.example"),
      "not_configured"
    );

    const finishParams = mockQuery.mock.calls[1][1] as unknown[];
    expect(finishParams[1]).toBe("skipped");
    expect(finishParams[8]).toBe(
      JSON.stringify({ reason: "not_configured" })
    );
  });

  it("updates retry progress without completing the row", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 } as any);

    await updateReportProgress(5, { attempts: 2 });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("metadata = metadata || $2::jsonb");
    expect(String(sql)).toContain("completed_at IS NULL");
    expect(params).toEqual([5, JSON.stringify({ attempts: 2 })]);
  });

  it("abandons stale queued reports with an optional channel filter", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 4 } as any);

    const count = await abandonStaleReports(15, "safe_browsing_web_form");

    expect(count).toBe(4);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("status = 'abandoned'");
    expect(String(sql)).toContain("channel = $2");
    expect(params).toEqual([15, "safe_browsing_web_form"]);
  });

  it("prunes completed reports older than the retention window", async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 12 } as any);

    const count = await pruneReportSubmissions(365);

    expect(count).toBe(12);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain("DELETE FROM report_submissions");
    expect(String(sql)).toContain("completed_at IS NOT NULL");
    expect(params).toEqual([365]);
  });

  it("truncates long response snippets", () => {
    expect(truncateResponse("abc")).toBe("abc");
    expect(truncateResponse("x".repeat(5000))).toHaveLength(4000);
    expect(truncateResponse(null)).toBeNull();
  });
});
