import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock external dependencies
vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

vi.mock("../../src/config.js", () => ({
  readConfig: vi.fn(),
}));

import { fetch } from "undici";
import { readConfig } from "../../src/config.js";
import { reportToDiscourse } from "../../src/services/discourseReportService.js";

const mockFetch = vi.mocked(fetch);
const mockReadConfig = vi.mocked(readConfig);

function baseConfig() {
  return {
    token: "test",
    guildId: "test",
    clientId: "test",
    proxy: "",
    hunterProxy: "",
    classifierProxy: "http://proxy",
    channelId: "test",
    netcraftReportEmail: "",
    urlscanApiKey: "",
    crdfLabsApiKey: "",
    virusTotalApiKey: "",
    microsoftUsername: "",
    microsoftPassword: "",
    kasperskyApiKey: "",
    metaDefenderApiKey: "",
    checkPhishApiKey: "",
    hybridAnalysisApiKey: "",
    googleSafeBrowsingApiKey: "",
    cloudflareUrlScannerApiKey: "",
    cloudflareAccountId: "",
    googleWebRiskApiProjectName: "",
    msrcReporterName: "",
    msrcReporterEmail: "",
    msrcReporterOrg: "",
    xarfReporterOrg: "",
    xarfReporterContact: "",
    xarfReporterDomain: "",
    smtpHost: "",
    smtpPort: 0,
    smtpUser: "",
    smtpPass: "",
  };
}

describe("Discourse reporting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips reporting when Discourse config is missing", async () => {
    mockReadConfig.mockResolvedValue(baseConfig());

    await reportToDiscourse(
      "https://example.com",
      "https://redirect.example.com",
      null,
      null
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("creates a post with a URLScan screenshot when UUID is provided", async () => {
    mockReadConfig.mockResolvedValue({
      ...baseConfig(),
      discourseBaseUrl: "https://forum.example.com",
      discourseApiKey: "secret-key",
      discourseApiUsername: "scanner-bot",
      discourseTopicId: 12345,
      discourseBypassHeader: "super-secret",
    });

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ id: 99, topic_id: 12345, post_number: 7 }),
      text: async () => "",
    } as Response);

    await reportToDiscourse(
      "https://example.com",
      "https://redirect.example.com",
      "cf-scan-id-123",
      "urlscan-uuid-456"
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const postInit = mockFetch.mock.calls[0]![1] as RequestInit;
    expect(postInit.method).toBe("POST");
    const postHeaders = postInit.headers as Record<string, string>;
    expect(postHeaders["Api-Key"]).toBe("secret-key");
    expect(postHeaders["Api-Username"]).toBe("scanner-bot");
    expect(postHeaders["x-bypass-protection"]).toBe("super-secret");

    const postBody = JSON.parse(postInit.body as string);
    expect(postBody.topic_id).toBe(12345);
    expect(postBody.raw).toContain("https://example.com");
    expect(postBody.raw).toContain(
      "https://urlscan.io/screenshots/urlscan-uuid-456.png"
    );
    expect(postBody.raw).toContain(
      "https://urlscan.io/result/urlscan-uuid-456/"
    );
    expect(postBody.raw).not.toContain("radar.cloudflare.com");
    expect(postBody.raw).not.toContain("Identified by");
    expect(postBody.raw).toContain("not been verified by a human");
  });

  it("falls back to a Cloudflare Radar screenshot when no URLScan UUID is provided", async () => {
    mockReadConfig.mockResolvedValue({
      ...baseConfig(),
      discourseBaseUrl: "https://forum.example.com",
      discourseApiKey: "secret-key",
      discourseApiUsername: "scanner-bot",
      discourseTopicId: 12345,
    });

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ id: 99, topic_id: 12345, post_number: 7 }),
      text: async () => "",
    } as Response);

    await reportToDiscourse(
      "https://example.com",
      "https://example.com",
      "cf-scan-id-789",
      null
    );

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const postInit = mockFetch.mock.calls[0]![1] as RequestInit;
    const postBody = JSON.parse(postInit.body as string);
    expect(postBody.raw).toContain(
      "https://radar.cloudflare.com/api/url-scanner/cf-scan-id-789/screenshot"
    );
    expect(postBody.raw).toContain(
      "https://radar.cloudflare.com/scan/cf-scan-id-789"
    );
    expect(postBody.raw).not.toContain("urlscan.io");
    expect(postBody.raw).not.toContain("Identified by");
  });

  it("creates a post without a screenshot when no scanner ids are provided", async () => {
    mockReadConfig.mockResolvedValue({
      ...baseConfig(),
      discourseBaseUrl: "https://forum.example.com",
      discourseApiKey: "secret-key",
      discourseApiUsername: "scanner-bot",
      discourseTopicId: 12345,
    });

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ id: 99, topic_id: 12345, post_number: 7 }),
      text: async () => "",
    } as Response);

    await reportToDiscourse("https://example.com", "https://example.com", null, null);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const postInit = mockFetch.mock.calls[0]![1] as RequestInit;
    const postBody = JSON.parse(postInit.body as string);
    expect(postBody.raw).not.toContain("radar.cloudflare.com");
    expect(postBody.raw).not.toContain("urlscan.io");
    expect(postBody.raw).not.toContain("Identified by");
  });
});
