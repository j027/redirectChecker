import { fetch } from "undici";
import { readConfig } from "../config.js";
import {
  ReportContext,
  ReportOutcome,
  reportInput,
  trackReport,
} from "./reportLogService.js";

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
  urlscanUuid: string | null,
  context?: ReportContext
): Promise<ReportOutcome> {
  return trackReport(
    reportInput("discourse", "notification", site, context),
    async () => {
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
        return { status: "skipped", metadata: { reason: "not_configured" } };
      }

      const raw = buildPostRaw(site, redirect, cloudflareScanId, urlscanUuid);

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
      const text = await response.text();

      if (!response.ok) {
        console.error(
          `Discourse report failed for ${site}: ${response.status} ${response.statusText} - ${text}`
        );
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: `HTTP ${response.status} ${response.statusText}`,
        };
      }

      let data: DiscoursePostResponse;
      try {
        data = JSON.parse(text) as DiscoursePostResponse;
      } catch {
        return {
          status: "error",
          httpStatus: response.status,
          responseSnippet: text,
          errorMessage: "Discourse response was not JSON",
        };
      }

      console.info(
        `Reported to Discourse: ${site} (topic ${data.topic_id}, post #${data.post_number})`
      );
      const postUrl =
        data.topic_id != null && data.post_number != null
          ? `${discourseBaseUrl}/t/${data.topic_id}/${data.post_number}`
          : null;
      return {
        status: "success",
        httpStatus: response.status,
        externalId: data.id != null ? String(data.id) : null,
        externalUrl: postUrl,
        responseSnippet: text,
        metadata: {
          topic_id: data.topic_id ?? null,
          post_number: data.post_number ?? null,
        },
      };
    }
  );
}
