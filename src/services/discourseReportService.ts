import { fetch } from "undici";
import { readConfig } from "../config.js";

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

function buildPostRaw(
  site: string,
  redirect: string,
  cloudflareScanId: string | null,
  urlscanUuid: string | null
): string {
  const lines = [
    "> **This was identified automatically and has not been verified by a human. Please verify before calling or interacting with any phone numbers or links.**",
    "",
    `**URL:** ${site}`,
  ];

  if (redirect && redirect !== site) {
    lines.push(`**Source redirect:** ${redirect}`);
  }

  if (urlscanUuid) {
    lines.push(
      "",
      `![URLScan screenshot](https://urlscan.io/screenshots/${urlscanUuid}.png)`,
      `[View scan on URLScan](https://urlscan.io/result/${urlscanUuid}/)`
    );
  } else if (cloudflareScanId) {
    lines.push(
      "",
      `![Screenshot](https://radar.cloudflare.com/api/url-scanner/${cloudflareScanId}/screenshot)`,
      `[View scan on Cloudflare Radar](https://radar.cloudflare.com/scan/${cloudflareScanId})`
    );
  }

  return lines.join("\n");
}

export async function reportToDiscourse(
  site: string,
  redirect: string,
  cloudflareScanId: string | null,
  urlscanUuid: string | null
): Promise<void> {
  const config = await readConfig();
  const {
    discourseBaseUrl,
    discourseApiKey,
    discourseApiUsername,
    discourseTopicId,
    discourseBypassHeader,
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

  const raw = buildPostRaw(site, redirect, cloudflareScanId, urlscanUuid);

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
