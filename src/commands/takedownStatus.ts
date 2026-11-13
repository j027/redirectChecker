import { CommandDefinition } from "./commands.js";
import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import pool from "../dbPool.js";
import {
  EMOJI,
  formatHostProvider,
  formatHostStatusIndicator,
  formatHostStatusReason,
  formatTimeDifference,
  formatUrl,
} from "../utils/discordFormatting.js";

export const takedownStatusCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("takedown_status")
    .setDescription("Shows recent takedown activity and statistics")
    .addIntegerOption(option => 
      option.setName('limit')
        .setDescription('Number of recent takedowns to show')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(20)
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });
    const limit = interaction.options.getInteger('limit') || 10; // Default to 10
    
    const client = await pool.connect();
    try {
      // Query recent successful takedowns
      const query = `
        SELECT d.destination_url, d.first_seen,
               ts.safebrowsing_flagged_at,
               ts.netcraft_flagged_at,
               ts.smartscreen_flagged_at,
               ts.dns_unresolvable_at,
               ts.host_status_at,
               ts.host_status_kind,
               ts.host_status_provider,
               ts.host_status_reason,
               ts.host_status_url
        FROM takedown_status ts
        JOIN redirect_destinations d ON ts.redirect_destination_id = d.id
        WHERE ts.safebrowsing_flagged_at IS NOT NULL 
           OR ts.netcraft_flagged_at IS NOT NULL
           OR ts.smartscreen_flagged_at IS NOT NULL
           OR ts.dns_unresolvable_at IS NOT NULL
           OR ts.host_status_at IS NOT NULL
        ORDER BY 
          GREATEST(
            COALESCE(ts.safebrowsing_flagged_at, '1970-01-01'::timestamp),
            COALESCE(ts.netcraft_flagged_at, '1970-01-01'::timestamp),
            COALESCE(ts.smartscreen_flagged_at, '1970-01-01'::timestamp),
            COALESCE(ts.dns_unresolvable_at, '1970-01-01'::timestamp),
            COALESCE(ts.host_status_at, '1970-01-01'::timestamp)
          ) DESC
        LIMIT $1;
      `;
      
      const result = await client.query(query, [limit]);
      
      if (result.rows.length === 0) {
        await interaction.editReply("No takedowns found.");
        return;
      }

      // Create a beautiful embed to show the takedowns
      const embed = new EmbedBuilder()
        .setTitle("🛡️ Recent Takedown Signals")
        .setColor(0x3ba55c) // Green color for success
        .setDescription(`Recent takedown and provider-status signals`)
        .setTimestamp();
      
      // Add some overall statistics
      const stats = {
        safebrowsing: 0,
        netcraft: 0, 
        smartscreen: 0,
        dns: 0,
        hostStatusCounts: {} as Record<string, number>,
        fastest: { service: '', time: Infinity }
      };
      
      // Process each row
      for (const row of result.rows) {
        const url = formatUrl(row.destination_url);
        const firstSeen = new Date(row.first_seen);
        const firstSeenTimestamp = `<t:${Math.floor(firstSeen.getTime() / 1000)}:R>`;
        
        // Track which services flagged this URL
        if (row.safebrowsing_flagged_at) stats.safebrowsing++;
        if (row.netcraft_flagged_at) stats.netcraft++;
        if (row.smartscreen_flagged_at) stats.smartscreen++;
        if (row.dns_unresolvable_at) stats.dns++;
        
        // Build status indicators
        const statusIndicators = [];
        
        // Determine fastest takedown
        let fastestTime = Infinity;
        let fastestService = '';
        
        // SafeBrowsing
        if (row.safebrowsing_flagged_at) {
          const flaggedAt = new Date(row.safebrowsing_flagged_at);
          const timeDiff = flaggedAt.getTime() - firstSeen.getTime();
          if (timeDiff < fastestTime) {
            fastestTime = timeDiff;
            fastestService = 'SafeBrowsing';
          }
          statusIndicators.push(`${EMOJI.SAFEBROWSING} ${formatTimeDifference(firstSeen, flaggedAt)}`);
        }
        
        // Netcraft
        if (row.netcraft_flagged_at) {
          const flaggedAt = new Date(row.netcraft_flagged_at);
          const timeDiff = flaggedAt.getTime() - firstSeen.getTime();
          if (timeDiff < fastestTime) {
            fastestTime = timeDiff;
            fastestService = 'Netcraft';
          }
          statusIndicators.push(`${EMOJI.NETCRAFT} ${formatTimeDifference(firstSeen, flaggedAt)}`);
        }
        
        // SmartScreen
        if (row.smartscreen_flagged_at) {
          const flaggedAt = new Date(row.smartscreen_flagged_at);
          const timeDiff = flaggedAt.getTime() - firstSeen.getTime();
          if (timeDiff < fastestTime) {
            fastestTime = timeDiff;
            fastestService = 'SmartScreen';
          }
          statusIndicators.push(`${EMOJI.SMARTSCREEN} ${formatTimeDifference(firstSeen, flaggedAt)}`);
        }
        
        // DNS
        if (row.dns_unresolvable_at) {
          const flaggedAt = new Date(row.dns_unresolvable_at);
          const timeDiff = flaggedAt.getTime() - firstSeen.getTime();
          if (timeDiff < fastestTime) {
            fastestTime = timeDiff;
            fastestService = 'DNS';
          }
          statusIndicators.push(`${EMOJI.DNS} ${formatTimeDifference(firstSeen, flaggedAt)}`);
        }

        // Provider host status (Forge/Bunny/...)
        if (row.host_status_at) {
          const flaggedAt = new Date(row.host_status_at);
          const indicator = formatHostStatusIndicator(
            row.host_status_kind,
            row.host_status_provider
          );
          const timeDiff = flaggedAt.getTime() - firstSeen.getTime();
          if (timeDiff < fastestTime) {
            fastestTime = timeDiff;
            fastestService = formatHostProvider(row.host_status_provider);
          }
          const reason = formatHostStatusReason(
            row.host_status_kind,
            row.host_status_reason
          );
          const reasonSuffix = reason.length > 0 ? ` (${reason})` : "";
          statusIndicators.push(
            `${indicator.emoji} ${indicator.label}${reasonSuffix} ${formatTimeDifference(firstSeen, flaggedAt)}`
          );
          const providerKey = row.host_status_provider ?? "unknown";
          stats.hostStatusCounts[providerKey] =
            (stats.hostStatusCounts[providerKey] ?? 0) + 1;
        }
        
        // Update global fastest if this is faster
        if (fastestTime < stats.fastest.time) {
          stats.fastest = { service: fastestService, time: fastestTime };
        }
        
        // Format the field content
        embed.addFields({
          name: url.display,
          value: `First seen: ${firstSeenTimestamp}\n${statusIndicators.join(' | ')}`,
          inline: false
        });
      }
      
      // Add statistics footer
      const fastestTime = stats.fastest.time < Infinity ? 
        formatTimeDifference(new Date(0), new Date(stats.fastest.time)) : 
        'N/A';
      
      const hostStatusSummary = Object.entries(stats.hostStatusCounts)
        .map(([provider, count]) => `${formatHostProvider(provider)}: ${count}`)
        .join(" | ");
      const hostStatusPart = hostStatusSummary
        ? ` | Host status: ${hostStatusSummary}`
        : "";

      embed.setFooter({
        text: `Flagged by: SafeBrowsing: ${stats.safebrowsing} | Netcraft: ${stats.netcraft} | SmartScreen: ${stats.smartscreen} | DNS: ${stats.dns}${hostStatusPart} | Fastest signal: ${stats.fastest.service} (${fastestTime})`
      });
      
      // Send the embed
      await interaction.editReply({ embeds: [embed] });
      
    } catch (error) {
      console.error("Error fetching takedown status:", error);
      await interaction.editReply("There was an error fetching the takedown status.");
    } finally {
      client.release();
    }
  },
};