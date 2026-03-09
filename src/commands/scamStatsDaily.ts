import { CommandDefinition } from "./commands.js";
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from "discord.js";
import pool from "../dbPool.js";

export const scamStatsDailyCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("scam-stats-daily")
    .setDescription("Shows unique scams reported per day for the last 7 days")
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });
    const client = await pool.connect();

    try {
      const query = `
        SELECT date_trunc('day', detected_at) AS day, COUNT(*)::int AS total
        FROM scam_reports
        WHERE detected_at >= CURRENT_DATE - INTERVAL '6 days'
        GROUP BY date_trunc('day', detected_at)
        ORDER BY day ASC;
      `;

      const result = await client.query(query);

      // Build a map of day -> count, filling in zeros for missing days
      const dayCounts = new Map<string, number>();
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        dayCounts.set(key, 0);
      }

      for (const row of result.rows) {
        const key = new Date(row.day).toISOString().slice(0, 10);
        dayCounts.set(key, row.total);
      }

      const maxCount = Math.max(...dayCounts.values(), 1);
      const barMaxLength = 16;

      const lines: string[] = [];
      let weekTotal = 0;
      for (const [day, count] of dayCounts) {
        weekTotal += count;
        const barLength = Math.round((count / maxCount) * barMaxLength);
        const bar = "█".repeat(barLength) + "░".repeat(barMaxLength - barLength);
        const dateLabel = new Date(day + "T00:00:00Z").toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          timeZone: "UTC",
        });
        lines.push(`\`${dateLabel.padEnd(12)}\` ${bar} **${count}**`);
      }

      const embed = new EmbedBuilder()
        .setTitle("📊 Daily Scam Reports — Last 7 Days")
        .setColor(0xff4444)
        .setDescription(lines.join("\n"))
        .addFields({
          name: "Week Total",
          value: `**${weekTotal}** unique scams`,
          inline: true,
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } finally {
      client.release();
    }
  },
};
