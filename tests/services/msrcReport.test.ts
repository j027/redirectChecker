import { describe, it, expect } from "vitest";
import { fetch } from "undici";

const MSRC_ABUSE_ENDPOINT = "https://api.msrc.microsoft.com/report/v3.0/abuse";

describe("MSRC abuse report API", () => {
  it("accepts a test submission with testSubmission=true", async () => {
    const now = new Date();
    const report = {
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 19),
      timeZone: "+0000",
      threatType: "URL",
      incidentType: "Phishing",
      reporterName: "Automated Test",
      reporterEmail: "test@example.com",
      reportNotes: "Automated integration test — should not create a real case.",
      source: "ReportApi",
      severity: "High",
      anonymizeReport: true,
      sourceUrl: "https://example.com/redirect",
      destinationUrl: "https://example.com/scam-page",
      testSubmission: true,
    };

    const response = await fetch(MSRC_ABUSE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { code: string; message: string };
    expect(body.code).toBe("OK");
    expect(body.message).toContain("Test Successful");
  });

  it("returns 400 when required fields are missing", async () => {
    const response = await fetch(MSRC_ABUSE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { errors: Record<string, string[]> };
    expect(body.errors).toHaveProperty("reporterName");
    expect(body.errors).toHaveProperty("reporterEmail");
    expect(body.errors).toHaveProperty("threatType");
  });

  it("rejects invalid timezone format", async () => {
    const now = new Date();
    const report = {
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 19),
      timeZone: "UTC",
      threatType: "URL",
      incidentType: "Phishing",
      reporterName: "Test",
      reporterEmail: "test@example.com",
      reportNotes: "test",
      severity: "High",
      anonymizeReport: true,
      sourceUrl: "https://example.com",
      destinationUrl: "https://example.com",
      testSubmission: true,
    };

    const response = await fetch(MSRC_ABUSE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { message: string };
    expect(body.message).toContain("Invalid ISO DateTime format");
  });

  it("requires sourceUrl when threatType is URL", async () => {
    const now = new Date();
    const report = {
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 19),
      timeZone: "+0000",
      threatType: "URL",
      incidentType: "Phishing",
      reporterName: "Test",
      reporterEmail: "test@example.com",
      reportNotes: "test",
      severity: "High",
      anonymizeReport: true,
      destinationUrl: "https://example.com",
      testSubmission: true,
    };

    const response = await fetch(MSRC_ABUSE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { message: string };
    expect(body.message).toContain("sourceUrl is required");
  });
});
