import { CommandDefinition } from "./commands.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import pool from "../dbPool.js";

const CHANNELS = [
  "cloudflare_urlscan",
  "urlscan",
  "netcraft",
  "safe_browsing_crx",
  "virustotal",
  "kaspersky",
  "metadefender",
  "smartscreen",
  "safe_browsing_web_form",
  "checkphish",
  "hybrid_analysis",
  "crdf",
  "web_risk",
  "discourse",
  "discord",
  "msrc",
  "xarf",
] as const;

const STATUSES = [
  "queued",
  "success",
  "submitted",
  "error",
  "captcha",
  "blocked",
  "rejected",
  "skipped",
  "abandoned",
] as const;

interface ReportRow {
  submitted_at: Date;
  channel: string;
  provider: string | null;
  status: string;
  http_status: number | null;
  url: string;
  external_id: string | null;
  external_url: string | null;
  response_snippet: string | null;
  error_message: string | null;
}

export const reportLogCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("report_log")
    .setDescription("Shows recent outbound report submissions and responses")
    .addStringOption((option) =>
      option
        .setName("channel")
        .setDescription("Filter by report channel")
        .setRequired(false)
        .addChoices(...CHANNELS.map((channel) => ({ name: channel, value: channel })))
    )
    .addStringOption((option) =>
      option
        .setName("status")
        .setDescription("Filter by status")
        .setRequired(false)
        .addChoices(...STATUSES.map((status) => ({ name: status, value: status })))
    )
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("Filter by the exact reported URL")
        .setRequired(false)
    )
    .addIntegerOption((option) =>
      option
        .setName("count")
        .setDescription("Number of rows to show (default 10, max 25)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(25)
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });

    const channel = interaction.options.getString("channel");
    const status = interaction.options.getString("status");
    const url = interaction.options.getString("url");
    const count = interaction.options.getInteger("count") ?? 10;

    try {
      const result = await pool.query(
        `SELECT submitted_at, channel, provider, status, http_status, url,
                external_id, external_url, response_snippet, error_message
         FROM report_submissions
         WHERE ($1::text IS NULL OR channel = $1)
           AND ($2::text IS NULL OR status = $2)
           AND ($3::text IS NULL OR url = $3)
         ORDER BY submitted_at DESC
         LIMIT $4`,
        [channel, status, url, count]
      );

      const rows = result.rows as ReportRow[];
      if (rows.length === 0) {
        await interaction.editReply("No report submissions found.");
        return;
      }

      const lines: string[] = [];
      for (const row of rows) {
        const icon =
          row.status === "success" || row.status === "submitted"
            ? "✅"
            : row.status === "queued"
              ? "⏳"
              : row.status === "skipped"
                ? "⏭️"
                : "❌";
        const http = row.http_status != null ? ` HTTP ${row.http_status}` : "";
        const response = compact(row.response_snippet ?? row.error_message);
        const external = row.external_url
          ? `[${row.external_id ?? "link"}](${row.external_url})`
          : row.external_id;

        const channelLabel = row.provider
          ? `${row.channel} (${row.provider})`
          : row.channel;
        lines.push(
          `${icon} **${channelLabel}** \`${row.status}\`${http} — ${relativeTime(row.submitted_at)}`
        );
        lines.push(formatUrl(row.url));
        if (external) {
          lines.push(`Ref: ${external}`);
        }
        if (response) {
          lines.push(`Response: ${response}`);
        }
        lines.push("");
      }

      const embed = new EmbedBuilder()
        .setTitle("📤 Report Submissions")
        .setColor(0x3498db)
        .setDescription(lines.join("\n").slice(0, 4000))
        .setFooter({
          text: `${rows.length} row(s)${channel ? ` | ${channel}` : ""}${status ? ` | ${status}` : ""}${url ? ` | ${url}` : ""}`.slice(0, 2048),
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("Error fetching report submissions:", error);
      await interaction.editReply("There was an error fetching report submissions.");
    }
  },
};

function compact(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 160 ? `${singleLine.slice(0, 157)}...` : singleLine;
}

function formatUrl(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

function relativeTime(date: Date): string {
  const diffMins = Math.floor((Date.now() - new Date(date).getTime()) / 60_000);
  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}
