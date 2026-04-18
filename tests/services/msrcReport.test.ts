import { describe, it, expect } from "vitest";
import { fetch } from "undici";

const MSRC_API_BASE = "https://api.msrc.microsoft.com/report/v3.0";
const MSRC_ABUSE_ENDPOINT = `${MSRC_API_BASE}/abuse`;
const MSRC_FILE_ENDPOINT = `${MSRC_API_BASE}/file`;

// Minimal valid 1x1 red PNG (67 bytes)
const MINIMAL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
  "base64"
);

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

  it("uploads a screenshot and uses the attachment in a test submission", async () => {
    // Step 1: Upload a small PNG using manual multipart/form-data
    const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="screenshot.png"\r\n`),
      Buffer.from(`Content-Type: image/png\r\n\r\n`),
      MINIMAL_PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const uploadResponse = await fetch(MSRC_FILE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    });

    console.log(`Upload status: ${uploadResponse.status}`);
    const uploadText = await uploadResponse.text();
    console.log(`Upload response: ${uploadText}`);

    expect(uploadResponse.status).toBe(200);
    const uploadJson = JSON.parse(uploadText) as { name: string; id: string }[];
    expect(uploadJson).toHaveLength(1);
    expect(uploadJson[0].id).toBeTruthy();

    const attachmentId = uploadJson[0].id;

    // Step 2: Submit a test report referencing the uploaded attachment
    const now = new Date();
    const report = {
      date: now.toISOString().slice(0, 10),
      time: now.toISOString().slice(11, 19),
      timeZone: "+0000",
      threatType: "URL",
      incidentType: "Phishing",
      reporterName: "Automated Test",
      reporterEmail: "test@example.com",
      reportNotes: "Automated integration test with screenshot — should not create a real case.",
      source: "ReportApi",
      severity: "High",
      anonymizeReport: true,
      sourceUrl: "https://example.com/redirect",
      destinationUrl: "https://example.com/scam-page",
      attachmentId,
      attachmentFileName: "screenshot.png",
      testSubmission: true,
    };

    const reportResponse = await fetch(MSRC_ABUSE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });

    console.log(`Report status: ${reportResponse.status}`);
    const reportBody = await reportResponse.text();
    console.log(`Report response: ${reportBody}`);

    expect(reportResponse.status).toBe(200);
    const parsed = JSON.parse(reportBody) as { code: string; message: string };
    expect(parsed.code).toBe("OK");
    expect(parsed.message).toContain("Test Successful");
  });
});
