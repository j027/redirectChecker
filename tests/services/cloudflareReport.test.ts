import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  readConfig: vi.fn(),
}));

vi.mock("../../src/dbPool.js", () => ({
  default: {
    query: vi.fn().mockResolvedValue({
      rows: [{ id: "1" }],
      rowCount: 1,
    }),
  },
}));

import { fetch } from "undici";
import { readConfig } from "../../src/config.js";
import { reportToCloudflareUrlScanner } from "../../src/services/reportService.js";

const mockFetch = vi.mocked(fetch);
const mockReadConfig = vi.mocked(readConfig);

function cloudflareResponse(overrides: Record<string, unknown> = {}) {
  return {
    uuid: "3edfed37-6c42-4ef9-a243-fa16a6dad900",
    api: "https://api.cloudflare.com/client/v4/accounts/acct/urlscanner/v2/result/3edfed37-6c42-4ef9-a243-fa16a6dad900",
    visibility: "public",
    url: "https://example.com",
    result: "https://radar.cloudflare.com/scan/3edfed37-6c42-4ef9-a243-fa16a6dad900",
    message: "Submission successful",
    ...overrides,
  };
}

describe("Cloudflare URL Scanner reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadConfig.mockResolvedValue({
      cloudflareAccountId: "acct",
      cloudflareUrlScannerApiKey: "key",
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the documented top-level uuid and result URL", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(cloudflareResponse()),
    } as any);

    const outcome = await reportToCloudflareUrlScanner("https://example.com");

    expect(outcome.status).toBe("submitted");
    expect(outcome.externalId).toBe(
      "3edfed37-6c42-4ef9-a243-fa16a6dad900"
    );
    expect(outcome.externalUrl).toBe(
      "https://radar.cloudflare.com/scan/3edfed37-6c42-4ef9-a243-fa16a6dad900"
    );
    expect(outcome.httpStatus).toBe(200);
    expect(outcome.metadata?.api_url).toContain("/urlscanner/v2/result/");
  });

  it("fails loudly when the response has no uuid", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ message: "Submission successful" }),
    } as any);

    const outcome = await reportToCloudflareUrlScanner("https://example.com");

    expect(outcome.status).toBe("error");
    expect(outcome.errorMessage).toBe("Cloudflare response missing uuid");
  });

  it("records a non-2xx response as an error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ success: false, errors: [{ message: "rate limited" }] }),
    } as any);

    const outcome = await reportToCloudflareUrlScanner("https://example.com");

    expect(outcome.status).toBe("error");
    expect(outcome.httpStatus).toBe(429);
    expect(outcome.responseSnippet).toContain("rate limited");
  });
});
