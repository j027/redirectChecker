import { CommandDefinition } from "./commands.js";
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from "discord.js";
import pool from "../dbPool.js";

export const redirectLogsCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("redirectlogs")
    .setDescription("Shows recent redirect checker event logs for debugging")
    .addStringOption((option) =>
      option
        .setName("event")
        .setDescription("Filter by event type")
        .setRequired(false)
        .addChoices(
          { name: "Check Start", value: "check_start" },
          { name: "Check End", value: "check_end" },
          { name: "New Destination", value: "new_destination" },
          { name: "Classification", value: "classification" },
          { name: "Scam Found", value: "scam_found" },
          { name: "No Redirect", value: "no_redirect" },
          { name: "Existing Destination", value: "existing_destination" },
          { name: "Error", value: "error" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("source")
        .setDescription("Filter by source URL (partial match)")
        .setRequired(false)
    )
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription("Number of events to show (default: 25, max: 50)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(50)
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });

    const eventType = interaction.options.getString("event");
    const sourceFilter = interaction.options.getString("source");
    const limit = interaction.options.getInteger("limit") ?? 25;

    const client = await pool.connect();
    try {
      let query = `SELECT id, event_type, source_url, message, details, created_at 
                    FROM redirect_events WHERE 1=1`;
      const params: unknown[] = [];
      let paramIdx = 1;

      if (eventType) {
        query += ` AND event_type = $${paramIdx++}`;
        params.push(eventType);
      }
      if (sourceFilter) {
        query += ` AND source_url ILIKE $${paramIdx++}`;
        params.push(`%${sourceFilter}%`);
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIdx++}`;
      params.push(limit);

      const result = await client.query(query, params);

      if (result.rows.length === 0) {
        await interaction.editReply("No redirect events found matching your filters.");
        return;
      }

      // Get a summary of recent activity  
      const summaryQuery = await client.query(
        `SELECT 
           COUNT(*) FILTER (WHERE event_type = 'new_destination' AND created_at > NOW() - INTERVAL '24 hours') as new_destinations_24h,
           COUNT(*) FILTER (WHERE event_type = 'scam_found' AND created_at > NOW() - INTERVAL '24 hours') as scams_24h,
           COUNT(*) FILTER (WHERE event_type = 'no_redirect' AND created_at > NOW() - INTERVAL '24 hours') as no_redirect_24h,
           COUNT(*) FILTER (WHERE event_type = 'error' AND created_at > NOW() - INTERVAL '24 hours') as errors_24h,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') as total_24h
         FROM redirect_events`
      );
      const summary = summaryQuery.rows[0];

      const embeds: EmbedBuilder[] = [];

      // Summary embed
      const summaryEmbed = new EmbedBuilder()
        .setTitle("🔄 Redirect Checker Logs")
        .setColor(0x5865f2)
        .setDescription(
          `**Last 24h:** ${summary.total_24h} events | ` +
          `**New Destinations:** ${summary.new_destinations_24h} | ` +
          `**Scams:** ${summary.scams_24h} | ` +
          `**No Redirect:** ${summary.no_redirect_24h} | ` +
          `**Errors:** ${summary.errors_24h}`
        );
      
      if (eventType || sourceFilter) {
        const filters: string[] = [];
        if (eventType) filters.push(`Event: ${eventType}`);
        if (sourceFilter) filters.push(`Source: ${sourceFilter}`);
        summaryEmbed.setFooter({ text: `Filters: ${filters.join(" | ")} | Showing ${result.rows.length} events` });
      } else {
        summaryEmbed.setFooter({ text: `Showing ${result.rows.length} events` });
      }

      embeds.push(summaryEmbed);

      let currentEmbed = new EmbedBuilder().setColor(0x5865f2);
      let fieldCount = 0;

      for (const row of result.rows) {
        if (fieldCount >= 10) {
          embeds.push(currentEmbed);
          currentEmbed = new EmbedBuilder().setColor(0x5865f2);
          fieldCount = 0;
        }

        const timestamp = `<t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>`;
        const icon = getRedirectEventIcon(row.event_type);

        let value = `${timestamp}\n${row.message}`;

        if (row.source_url) {
          const truncatedUrl = row.source_url.length > 80
            ? row.source_url.substring(0, 77) + "..."
            : row.source_url;
          value += `\n**Source:** ${truncatedUrl}`;
        }

        if (row.details) {
          const detailStr = formatDetails(row.details);
          if (detailStr) {
            value += `\n${detailStr}`;
          }
        }

        if (value.length > 1024) {
          value = value.substring(0, 1021) + "...";
        }

        currentEmbed.addFields({
          name: `${icon} ${row.event_type}`,
          value,
          inline: false,
        });

        fieldCount++;
      }

      embeds.push(currentEmbed);
      await interaction.editReply({ embeds: embeds.slice(0, 10) });
    } finally {
      client.release();
    }
  },
};

function getRedirectEventIcon(eventType: string): string {
  switch (eventType) {
    case "check_start": return "🟢";
    case "check_end": return "🏁";
    case "redirect_followed": return "➡️";
    case "new_destination": return "🆕";
    case "classification": return "🤖";
    case "scam_found": return "🚨";
    case "no_redirect": return "⛔";
    case "existing_destination": return "🔁";
    case "error": return "❌";
    default: return "📝";
  }
}

function formatDetails(details: Record<string, unknown>): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined) continue;

    let displayValue = String(value);
    if (displayValue.length > 100) {
      displayValue = displayValue.substring(0, 97) + "...";
    }

    const formattedKey = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    parts.push(`**${formattedKey}:** ${displayValue}`);
  }

  return parts.slice(0, 5).join("\n");
}
