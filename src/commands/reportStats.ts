import { CommandDefinition } from "./commands.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import pool from "../dbPool.js";

interface DeliveryRow {
  channel: string;
  total: number;
  ok: number;
  errors: number;
}

interface ActionRow {
  channel_group: string;
  action_kind: string;
  acted: number;
  median_seconds: number | null;
}

export const reportStatsCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("report_stats")
    .setDescription("Shows outbound report delivery and report-to-action timing")
    .addIntegerOption((option) =>
      option
        .setName("days")
        .setDescription("Lookback window in days (default 7, max 365)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(365)
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });
    const days = interaction.options.getInteger("days") ?? 7;

    try {
      const [deliveryResult, actionResult] = await Promise.all([
        pool.query(
          `SELECT channel,
                  COUNT(*)::int AS total,
                  COUNT(*) FILTER (WHERE status IN ('success', 'submitted'))::int AS ok,
                  COUNT(*) FILTER (WHERE status = 'error')::int AS errors
           FROM report_submissions
           WHERE submitted_at > now() - make_interval(days => $1::int)
           GROUP BY channel
           ORDER BY total DESC`,
          [days]
        ),
        pool.query(
          `SELECT channel_group,
                  action_kind,
                  COUNT(*) FILTER (WHERE action_at >= first_success_at)::int AS acted,
                  percentile_cont(0.5) WITHIN GROUP (
                    ORDER BY EXTRACT(EPOCH FROM (action_at - first_success_at))::double precision
                  ) FILTER (WHERE action_at >= first_success_at) AS median_seconds
           FROM report_action_times
           WHERE first_success_at IS NOT NULL
             AND first_success_at > now() - make_interval(days => $1::int)
           GROUP BY channel_group, action_kind
           ORDER BY channel_group, action_kind`,
          [days]
        ),
      ]);

      const delivery = deliveryResult.rows as DeliveryRow[];
      const actions = actionResult.rows as ActionRow[];

      if (delivery.length === 0 && actions.length === 0) {
        await interaction.editReply(`No report activity in the last ${days} day(s).`);
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(`📊 Report Activity (last ${days} day(s))`)
        .setColor(0x3498db)
        .setTimestamp();

      if (delivery.length > 0) {
        const lines = delivery.map((row) => {
          const rate = row.total > 0 ? Math.round((row.ok / row.total) * 100) : 0;
          return `**${row.channel}** — ${row.total} total, ${rate}% accepted, ${row.errors} error(s)`;
        });
        embed.addFields({
          name: "Delivery",
          value: lines.join("\n").slice(0, 1024),
          inline: false,
        });
      }

      if (actions.length > 0) {
        const lines = actions.map((row) => {
          const median = formatSeconds(row.median_seconds);
          return `**${row.channel_group}** → ${row.action_kind}: median ${median} (${row.acted} observed)`;
        });
        embed.addFields({
          name: "Report → action",
          value: lines.join("\n").slice(0, 1024),
          inline: false,
        });
      }

      embed.setFooter({
        text: "Action times are measured from first successful report; they include monitor polling delay.",
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error("Error fetching report stats:", error);
      await interaction.editReply("There was an error fetching report stats.");
    }
  },
};

function formatSeconds(value: number | null): string {
  if (value == null) {
    return "n/a";
  }
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) {
    return "n/a";
  }
  if (seconds < 60) {
    return `${Math.round(seconds)}s`;
  }
  if (seconds < 3600) {
    return `${Math.round(seconds / 60)}m`;
  }
  if (seconds < 86400) {
    return `${(seconds / 3600).toFixed(1)}h`;
  }
  return `${(seconds / 86400).toFixed(1)}d`;
}
