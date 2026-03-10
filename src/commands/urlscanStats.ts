import { CommandDefinition } from "./commands.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import pool from "../dbPool.js";

export const urlscanStatsCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("urlscan-stats")
    .setDescription(
      "Shows URLScan hunter statistics: scanned, classified, and reported counts"
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });
    const client = await pool.connect();

    try {
      // --- Aggregate stats for today / 7 days / 30 days ---
      const statsQuery = `
        SELECT
          COALESCE(SUM(CASE WHEN date = CURRENT_DATE THEN urls_scanned END), 0)::int         AS today_scanned,
          COALESCE(SUM(CASE WHEN date = CURRENT_DATE THEN urls_classified_scam END), 0)::int  AS today_classified,
          COALESCE(SUM(CASE WHEN date = CURRENT_DATE THEN urls_reported END), 0)::int         AS today_reported,
          COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '6 days' THEN urls_scanned END), 0)::int         AS week_scanned,
          COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '6 days' THEN urls_classified_scam END), 0)::int  AS week_classified,
          COALESCE(SUM(CASE WHEN date >= CURRENT_DATE - INTERVAL '6 days' THEN urls_reported END), 0)::int         AS week_reported,
          COALESCE(SUM(urls_scanned), 0)::int         AS month_scanned,
          COALESCE(SUM(urls_classified_scam), 0)::int  AS month_classified,
          COALESCE(SUM(urls_reported), 0)::int         AS month_reported
        FROM urlscan_scan_stats
        WHERE date >= CURRENT_DATE - INTERVAL '29 days';
      `;
      const statsResult = await client.query(statsQuery);
      const s = statsResult.rows[0];

      // --- Last 5 reports ---
      const recentQuery = `
        SELECT url, classifier_confidence, reported_to_netcraft, created_at
        FROM urlscan_reports
        ORDER BY created_at DESC
        LIMIT 5;
      `;
      const recentResult = await client.query(recentQuery);

      // --- Build embed ---
      const fmt = (scanned: number, classified: number, reported: number) =>
        `${scanned.toLocaleString()} scanned │ ${classified} confirmed │ ${reported} reported`;

      const lines = [
        `**Today:** ${fmt(s.today_scanned, s.today_classified, s.today_reported)}`,
        `**7 days:** ${fmt(s.week_scanned, s.week_classified, s.week_reported)}`,
        `**30 days:** ${fmt(s.month_scanned, s.month_classified, s.month_reported)}`,
      ];

      const embed = new EmbedBuilder()
        .setTitle("🔎 URLScan Hunter Stats")
        .setColor(0x3498db)
        .setDescription(lines.join("\n"))
        .setTimestamp();

      // Recent reports
      if (recentResult.rows.length > 0) {
        const recentLines = recentResult.rows.map((row) => {
          const confidence = (row.classifier_confidence * 100).toFixed(1);
          const ago = relativeTime(new Date(row.created_at));
          const status = row.reported_to_netcraft ? "✅" : "❌";
          let hostname: string;
          try {
            hostname = new URL(row.url).hostname;
          } catch {
            hostname = row.url;
          }
          return `${status} \`${hostname}\` (${confidence}%) — ${ago}`;
        });

        embed.addFields({
          name: "Recent Reports",
          value: recentLines.join("\n"),
          inline: false,
        });
      } else {
        embed.addFields({
          name: "Recent Reports",
          value: "No reports yet",
          inline: false,
        });
      }

      await interaction.editReply({ embeds: [embed] });
    } finally {
      client.release();
    }
  },
};

function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
