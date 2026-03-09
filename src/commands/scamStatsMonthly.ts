import { CommandDefinition } from "./commands.js";
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from "discord.js";
import pool from "../dbPool.js";

export const scamStatsMonthlyCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("scam-stats-monthly")
    .setDescription("Shows unique scams reported per month for recent months")
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });
    const client = await pool.connect();

    try {
      const query = `
        SELECT date_trunc('month', detected_at) AS month, COUNT(*)::int AS total
        FROM scam_reports
        WHERE detected_at >= date_trunc('month', CURRENT_DATE) - INTERVAL '5 months'
        GROUP BY date_trunc('month', detected_at)
        ORDER BY month ASC;
      `;

      const result = await client.query(query);

      // Build a map of month -> count, filling in zeros for missing months
      const monthCounts = new Map<string, number>();
      for (let i = 5; i >= 0; i--) {
        const d = new Date();
        d.setMonth(d.getMonth() - i, 1);
        const key = d.toISOString().slice(0, 7); // "YYYY-MM"
        monthCounts.set(key, 0);
      }

      for (const row of result.rows) {
        const key = new Date(row.month).toISOString().slice(0, 7);
        monthCounts.set(key, row.total);
      }

      const maxCount = Math.max(...monthCounts.values(), 1);
      const barMaxLength = 16;

      const lines: string[] = [];
      let grandTotal = 0;
      for (const [month, count] of monthCounts) {
        grandTotal += count;
        const barLength = Math.round((count / maxCount) * barMaxLength);
        const bar = "█".repeat(barLength) + "░".repeat(barMaxLength - barLength);
        const [year, m] = month.split("-");
        const monthLabel = new Date(Number(year), Number(m) - 1).toLocaleDateString("en-US", {
          month: "long",
          year: "numeric",
        });
        lines.push(`\`${monthLabel.padEnd(18)}\` ${bar} **${count}**`);
      }

      const embed = new EmbedBuilder()
        .setTitle("📊 Monthly Scam Reports — Last 6 Months")
        .setColor(0xff4444)
        .setDescription(lines.join("\n"))
        .addFields({
          name: "Total",
          value: `**${grandTotal}** unique scams`,
          inline: true,
        })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } finally {
      client.release();
    }
  },
};
