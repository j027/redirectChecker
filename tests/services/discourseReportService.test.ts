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

const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64"
);

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
      null
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when scanner name is missing", async () => {
    mockReadConfig.mockResolvedValue({
      ...baseConfig(),
      discourseBaseUrl: "https://forum.example.com",
      discourseApiKey: "secret-key",
      discourseApiUsername: "scanner-bot",
      discourseTopicId: 12345,
    });

    await expect(
      reportToDiscourse("https://example.com", "https://example.com", null)
    ).rejects.toThrow("discourseScannerName is required");
  });

  it("uploads screenshot and creates a post when config is present", async () => {
    mockReadConfig.mockResolvedValue({
      ...baseConfig(),
      discourseBaseUrl: "https://forum.example.com",
      discourseApiKey: "secret-key",
      discourseApiUsername: "scanner-bot",
      discourseTopicId: 12345,
      discourseBypassHeader: "super-secret",
      discourseScannerName: "Tech Support Scam Hunter",
    });

    mockFetch.mockImplementation(async (url: string | URL | Request) => {
      const urlString = url.toString();
      if (urlString.includes("/uploads.json")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => ({ short_url: "upload://screenshot.png" }),
          text: async () => "",
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ id: 99, topic_id: 12345, post_number: 7 }),
        text: async () => "",
      } as Response;
    });

    await reportToDiscourse(
      "https://example.com",
      "https://redirect.example.com",
      MINIMAL_PNG
    );

    const uploadCall = mockFetch.mock.calls.find((call) =>
      call[0].toString().includes("/uploads.json")
    );
    expect(uploadCall).toBeDefined();
    const uploadInit = uploadCall![1] as RequestInit;
    expect(uploadInit.method).toBe("POST");
    const uploadHeaders = uploadInit.headers as Record<string, string>;
    expect(uploadHeaders["Api-Key"]).toBe("secret-key");
    expect(uploadHeaders["Api-Username"]).toBe("scanner-bot");
    expect(uploadHeaders["x-bypass-protection"]).toBe("super-secret");

    const postCall = mockFetch.mock.calls.find((call) =>
      call[0].toString().includes("/posts.json")
    );
    expect(postCall).toBeDefined();
    const postInit = postCall![1] as RequestInit;
    expect(postInit.method).toBe("POST");
    const postHeaders = postInit.headers as Record<string, string>;
    expect(postHeaders["Api-Key"]).toBe("secret-key");
    expect(postHeaders["Api-Username"]).toBe("scanner-bot");
    expect(postHeaders["x-bypass-protection"]).toBe("super-secret");

    const postBody = JSON.parse(postInit.body as string);
    expect(postBody.topic_id).toBe(12345);
    expect(postBody.raw).toContain(
      "Identified by: **Tech Support Scam Hunter**"
    );
    expect(postBody.raw).toContain("https://example.com");
    expect(postBody.raw).toContain("upload://screenshot.png");
    expect(postBody.raw).toContain("not been verified by a human");
  });

  it("creates a post without a screenshot when none is provided", async () => {
    mockReadConfig.mockResolvedValue({
      ...baseConfig(),
      discourseBaseUrl: "https://forum.example.com",
      discourseApiKey: "secret-key",
      discourseApiUsername: "scanner-bot",
      discourseTopicId: 12345,
      discourseScannerName: "Tech Support Scam Hunter",
    });

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ id: 99, topic_id: 12345, post_number: 7 }),
      text: async () => "",
    } as Response);

    await reportToDiscourse("https://example.com", "https://example.com", null);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const postInit = mockFetch.mock.calls[0]![1] as RequestInit;
    const postBody = JSON.parse(postInit.body as string);
    expect(postBody.raw).not.toContain("upload://");
  });
});
