import { CommandDefinition } from "./commands.js";
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from "discord.js";
import pool from "../dbPool.js";

export const hunterLogsCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("hunterlogs")
    .setDescription("Shows recent hunter event logs for debugging")
    .addStringOption((option) =>
      option
        .setName("hunter")
        .setDescription("Filter by hunter type")
        .setRequired(false)
        .addChoices(
          { name: "Search Ads", value: "search" },
          { name: "Typosquat", value: "typosquat" },
          { name: "Pornhub", value: "pornhub" },
          { name: "AdSpyGlass", value: "adspyglass" },
          { name: "Scheduler", value: "scheduler" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("event")
        .setDescription("Filter by event type")
        .setRequired(false)
        .addChoices(
          { name: "Cycle Start", value: "cycle_start" },
          { name: "Cycle End", value: "cycle_end" },
          { name: "Ads Found", value: "ads_found" },
          { name: "Ad Processed", value: "ad_processed" },
          { name: "Ad Skipped", value: "ad_skipped" },
          { name: "Classification", value: "classification" },
          { name: "Scam Detected", value: "scam_detected" },
          { name: "Error", value: "error" },
          { name: "Timeout", value: "timeout" }
        )
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

    const hunterType = interaction.options.getString("hunter");
    const eventType = interaction.options.getString("event");
    const limit = interaction.options.getInteger("limit") ?? 25;

    const client = await pool.connect();
    try {
      let query = `SELECT id, hunter_type, event_type, message, details, created_at 
                    FROM hunter_events WHERE 1=1`;
      const params: unknown[] = [];
      let paramIdx = 1;

      if (hunterType) {
        query += ` AND hunter_type = $${paramIdx++}`;
        params.push(hunterType);
      }
      if (eventType) {
        query += ` AND event_type = $${paramIdx++}`;
        params.push(eventType);
      }

      query += ` ORDER BY created_at DESC LIMIT $${paramIdx++}`;
      params.push(limit);

      const result = await client.query(query, params);

      if (result.rows.length === 0) {
        await interaction.editReply("No hunter events found matching your filters.");
        return;
      }

      // Build embeds (Discord has a 6000 char limit per message, so we paginate)
      const embeds: EmbedBuilder[] = [];
      let currentEmbed = new EmbedBuilder()
        .setTitle("🔍 Hunter Event Logs")
        .setColor(0x5865f2)
        .setFooter({ text: `Showing ${result.rows.length} events` });

      if (hunterType || eventType) {
        const filters: string[] = [];
        if (hunterType) filters.push(`Hunter: ${hunterType}`);
        if (eventType) filters.push(`Event: ${eventType}`);
        currentEmbed.setDescription(`Filters: ${filters.join(" | ")}`);
      }

      let fieldCount = 0;

      for (const row of result.rows) {
        // Start a new embed every 10 fields to stay under limits
        if (fieldCount >= 10) {
          embeds.push(currentEmbed);
          currentEmbed = new EmbedBuilder()
            .setColor(0x5865f2);
          fieldCount = 0;
        }

        const timestamp = `<t:${Math.floor(new Date(row.created_at).getTime() / 1000)}:R>`;
        const icon = getEventIcon(row.event_type);

        let value = `${timestamp}\n${row.message}`;

        // Show key details if present
        if (row.details) {
          const detailStr = formatDetails(row.details);
          if (detailStr) {
            value += `\n${detailStr}`;
          }
        }

        // Truncate if too long
        if (value.length > 1024) {
          value = value.substring(0, 1021) + "...";
        }

        currentEmbed.addFields({
          name: `${icon} [${row.hunter_type}] ${row.event_type}`,
          value,
          inline: false,
        });

        fieldCount++;
      }

      embeds.push(currentEmbed);

      // Discord allows max 10 embeds per message
      await interaction.editReply({ embeds: embeds.slice(0, 10) });
    } finally {
      client.release();
    }
  },
};

function getEventIcon(eventType: string): string {
  switch (eventType) {
    case "cycle_start": return "🟢";
    case "cycle_end": return "🏁";
    case "browser_restart": return "🔄";
    case "ads_found": return "📋";
    case "ad_processed": return "⚙️";
    case "ad_skipped": return "⏭️";
    case "classification": return "🤖";
    case "scam_detected": return "🚨";
    case "added_to_checker": return "➕";
    case "status_changed": return "🔀";
    case "error": return "❌";
    case "timeout": return "⏰";
    case "whitelisted": return "✅";
    default: return "📝";
  }
}

function formatDetails(details: Record<string, unknown>): string {
  const parts: string[] = [];

  // Show the most useful fields in a compact format
  for (const [key, value] of Object.entries(details)) {
    if (value === null || value === undefined) continue;

    // Truncate long string values (like URLs)
    let displayValue = String(value);
    if (displayValue.length > 100) {
      displayValue = displayValue.substring(0, 97) + "...";
    }

    // Format key nicely
    const formattedKey = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    parts.push(`**${formattedKey}:** ${displayValue}`);
  }

  return parts.slice(0, 5).join("\n"); // Max 5 detail fields
}
