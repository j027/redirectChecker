import { fetch } from "undici";
import { readConfig } from "../config.js";

interface DiscourseUploadResponse {
  id?: number;
  url?: string;
  short_url?: string;
}

interface DiscoursePostResponse {
  id?: number;
  topic_id?: number;
  post_number?: number;
}

function getDiscourseHeaders(
  apiKey: string,
  apiUsername: string,
  bypassHeader?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    "Api-Key": apiKey,
    "Api-Username": apiUsername,
  };
  if (bypassHeader) {
    headers["x-bypass-protection"] = bypassHeader;
  }
  return headers;
}

function buildMultipartBody(
  boundary: string,
  screenshot: Buffer,
  filename: string
): Buffer {
  const parts: Buffer[] = [];

  parts.push(
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="upload_type"\r\n\r\n`),
    Buffer.from("composer\r\n"),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="synchronous"\r\n\r\n`),
    Buffer.from("true\r\n"),
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    ),
    Buffer.from("Content-Type: image/png\r\n\r\n"),
    screenshot,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  );

  return Buffer.concat(parts);
}

async function uploadScreenshot(
  baseUrl: string,
  apiKey: string,
  apiUsername: string,
  bypassHeader: string | undefined,
  screenshot: Buffer,
  filename: string
): Promise<string | null> {
  const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
  const body = buildMultipartBody(boundary, screenshot, filename);

  const headers = getDiscourseHeaders(apiKey, apiUsername, bypassHeader);
  headers["Content-Type"] = `multipart/form-data; boundary=${boundary}`;

  const response = await fetch(`${baseUrl}/uploads.json`, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(
      `Discourse upload failed: ${response.status} ${response.statusText} - ${text}`
    );
    return null;
  }

  const data = (await response.json()) as DiscourseUploadResponse;
  const uploadUrl = data.short_url ?? data.url;
  if (!uploadUrl) {
    console.error("Discourse upload response missing url", data);
    return null;
  }

  return uploadUrl;
}

function buildPostRaw(
  site: string,
  redirect: string,
  scannerName: string,
  uploadUrl?: string
): string {
  const lines = [
    `Identified by: **${scannerName}**`,
    "",
    "> **This was identified automatically and has not been verified by a human. Please verify before calling or interacting with any phone numbers or links.**",
    "",
    `**URL:** ${site}`,
  ];

  if (redirect && redirect !== site) {
    lines.push(`**Source redirect:** ${redirect}`);
  }

  if (uploadUrl) {
    lines.push("", `![screenshot.png](${uploadUrl})`);
  }

  return lines.join("\n");
}

export async function reportToDiscourse(
  site: string,
  redirect: string,
  screenshot: Buffer | null
): Promise<void> {
  const config = await readConfig();
  const {
    discourseBaseUrl,
    discourseApiKey,
    discourseApiUsername,
    discourseTopicId,
    discourseBypassHeader,
    discourseScannerName,
  } = config;

  if (
    !discourseBaseUrl ||
    !discourseApiKey ||
    !discourseApiUsername ||
    discourseTopicId == null
  ) {
    console.info("Discourse reporting disabled: missing config");
    return;
  }

  if (!discourseScannerName) {
    throw new Error(
      "discourseScannerName is required when Discourse reporting is configured"
    );
  }

  let uploadUrl: string | undefined;
  if (screenshot) {
    uploadUrl =
      (await uploadScreenshot(
        discourseBaseUrl,
        discourseApiKey,
        discourseApiUsername,
        discourseBypassHeader,
        screenshot,
        "screenshot.png"
      )) ?? undefined;
  }

  const raw = buildPostRaw(site, redirect, discourseScannerName, uploadUrl);

  try {
    const response = await fetch(`${discourseBaseUrl}/posts.json`, {
      method: "POST",
      headers: {
        ...getDiscourseHeaders(
          discourseApiKey,
          discourseApiUsername,
          discourseBypassHeader
        ),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topic_id: discourseTopicId,
        raw,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.error(
        `Discourse report failed for ${site}: ${response.status} ${response.statusText} - ${text}`
      );
      return;
    }

    const data = (await response.json()) as DiscoursePostResponse;
    console.info(
      `Reported to Discourse: ${site} (topic ${data.topic_id}, post #${data.post_number})`
    );
  } catch (err) {
    console.error(`Error reporting to Discourse: ${err}`);
  }
}
