import { CommandDefinition } from "./commands.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import pool from "../dbPool.js";

export const abuseReportsCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("abuse-reports")
    .setDescription("Shows recent MSRC and XARF abuse reports")
    .addStringOption((option) =>
      option
        .setName("provider")
        .setDescription("Filter by provider")
        .setRequired(false)
        .addChoices(
          { name: "All", value: "all" },
          { name: "MSRC", value: "msrc" },
          { name: "Laravel Forge", value: "laravel-forge" }
        )
    )
    .addIntegerOption((option) =>
      option
        .setName("count")
        .setDescription("Number of reports to show (default 10, max 25)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(25)
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });
    const client = await pool.connect();

    try {
      const provider = interaction.options.getString("provider") ?? "all";
      const count = interaction.options.getInteger("count") ?? 10;

      // Fetch recent reports
      const reportsQuery =
        provider === "all"
          ? await client.query(
              `SELECT provider, scam_url, response_status, reported_at
               FROM abuse_reports
               ORDER BY reported_at DESC
               LIMIT $1`,
              [count]
            )
          : await client.query(
              `SELECT provider, scam_url, response_status, reported_at
               FROM abuse_reports
               WHERE provider = $1
               ORDER BY reported_at DESC
               LIMIT $2`,
              [provider, count]
            );

      // Fetch totals per provider
      const totalsResult = await client.query(
        `SELECT provider, COUNT(*)::int AS total FROM abuse_reports GROUP BY provider`
      );

      const totals = totalsResult.rows
        .map((r: { provider: string; total: number }) => `${r.provider}: ${r.total}`)
        .join(" | ");

      if (reportsQuery.rows.length === 0) {
        const embed = new EmbedBuilder()
          .setTitle("📋 Abuse Reports")
          .setColor(0x888888)
          .setDescription("No reports found.")
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        return;
      }

      const lines: string[] = [];
      for (const row of reportsQuery.rows) {
        const status = row.response_status === "success" ? "✅" : "❌";
        const providerLabel = row.provider.toUpperCase();

        // Truncate URL to 50 chars
        let displayUrl = row.scam_url;
        if (displayUrl.length > 50) {
          displayUrl = displayUrl.slice(0, 47) + "...";
        }

        // Relative timestamp
        const ago = formatRelativeTime(new Date(row.reported_at));

        lines.push(`${status} **[${providerLabel}]** ${displayUrl} — ${ago}`);
      }

      const embed = new EmbedBuilder()
        .setTitle(`📋 Abuse Reports (last ${reportsQuery.rows.length})`)
        .setColor(0x3498db)
        .setDescription(lines.join("\n"))
        .setFooter({ text: totals || "No reports yet" })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } finally {
      client.release();
    }
  },
};

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;

  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}
