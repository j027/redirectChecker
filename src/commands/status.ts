import { CommandDefinition } from "./commands.js";
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from "discord.js";
import pool from "../dbPool.js";

const EMOJI = {
  SAFEBROWSING: "<:google_safe_browsing:1347648584727662713>", // Replace with your emoji IDs
  NETCRAFT: "<:netcraft:1347647539616157787>",
  SMARTSCREEN: "<:ms_smartscreen:1347648053045231636>",
  DNS: "🌐",
  BLOCKED: "🚫",
  CLEAN: "✅",
};

// Helper function for time to takedown
function formatTimeDifference(startDate: Date, endDate: Date): string {
  const diffMs = endDate.getTime() - startDate.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  
  const days = Math.floor(diffSeconds / 86400);
  const hours = Math.floor((diffSeconds % 86400) / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  
  if (days > 0) {
    return `${days}d ${hours}h`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m`;
  } else {
    return `${diffSeconds}s`;
  }
}

export const statusCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Displays all redirects and their current status")
    .toJSON(),

  async execute(interaction : ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });
    const client = await pool.connect();

    try {
      const query = `
        SELECT r.id AS redirect_id,
               r.source_url,
               r.regex_pattern,
               r.type,
               d.id AS destination_id,
               d.destination_url,
               d.first_seen,
               d.last_seen,
               d.is_popup,
               ts.safebrowsing_flagged_at,
               ts.netcraft_flagged_at, 
               ts.smartscreen_flagged_at,
               ts.dns_unresolvable_at,
               CASE WHEN ts.id IS NULL THEN FALSE ELSE TRUE END AS has_takedown_status
        FROM redirects r
        LEFT JOIN (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY redirect_id ORDER BY last_seen DESC) AS rn
          FROM redirect_destinations
        ) d ON r.id = d.redirect_id AND d.rn <= 8
        LEFT JOIN takedown_status ts ON d.id = ts.redirect_destination_id
        ORDER BY r.id, d.last_seen DESC;
      `;
      const result = await client.query(query);

      if (result.rows.length === 0) {
        await interaction.editReply("No redirects found.");
        return;
      }

      const embeds: EmbedBuilder[] = [];
      let currentEmbed = new EmbedBuilder()
        .setTitle("Redirects Status")
        .setColor(0x00ae86);

      // Keep track of current embed's field count
      let currentFieldCount = 0;

      // Group rows by redirect_id
      const redirects = new Map<number, { 
        header: string; 
        destinations: Array<{
          url: string;
          firstSeen: string;
          lastSeen: string;
          isPopup: boolean;
          firstSeenDate: Date;
          hasTakedownStatus: boolean;
          safebrowsingFlaggedAt: Date | null;
          netcraftFlaggedAt: Date | null;
          smartscreenFlaggedAt: Date | null;
          dnsUnresolvableAt: Date | null;
        }>;
      }>();

      for (const row of result.rows) {
        const id = row.redirect_id;
        if (!redirects.has(id)) {
          const sourceUrl = formatUrl(row.source_url);
          const header = `**Source URL:** [${sourceUrl.display}](${sourceUrl.full})\n**Regex Pattern:** \`${row.regex_pattern}\`\n**Type:** ${row.type}`;
          redirects.set(id, { header, destinations: [] });
        }
        if (row.destination_url) {
          // Use a compact timestamp format: relative time (<t:timestamp:R>)
          const firstSeen = `<t:${Math.floor(new Date(row.first_seen).getTime() / 1000)}:R>`;
          const lastSeen = `<t:${Math.floor(new Date(row.last_seen).getTime() / 1000)}:R>`;
          redirects.get(id)?.destinations.push({
            url: row.destination_url,
            firstSeen,
            lastSeen,
            isPopup: row.is_popup,
            firstSeenDate: new Date(row.first_seen),
            hasTakedownStatus: row.has_takedown_status,
            safebrowsingFlaggedAt: row.safebrowsing_flagged_at ? new Date(row.safebrowsing_flagged_at) : null,
            netcraftFlaggedAt: row.netcraft_flagged_at ? new Date(row.netcraft_flagged_at) : null, 
            smartscreenFlaggedAt: row.smartscreen_flagged_at ? new Date(row.smartscreen_flagged_at) : null,
            dnsUnresolvableAt: row.dns_unresolvable_at ? new Date(row.dns_unresolvable_at) : null
          });
        }
      }

      // Create an embed for each redirect
      for (const [redirectId, info] of redirects.entries()) {
        const embed = new EmbedBuilder()
          .setTitle(`Redirect ID: ${redirectId}`)
          .setColor(0x00ae86)
          .addFields({
            name: "Configuration",
            value: info.header,
            inline: false
          });

        // Add destination fields (max 8 destinations = 24 fields)
        for (const dest of info.destinations) {
          const destUrl = formatUrl(dest.url);
          
          // Build takedown status lines
          let takedownStatusLines = [];
          
          // Only show status for destinations that have been checked
          if (dest.isPopup && dest.hasTakedownStatus) {
            if (dest.safebrowsingFlaggedAt) {
              const timeDiff = formatTimeDifference(dest.firstSeenDate, dest.safebrowsingFlaggedAt);
              takedownStatusLines.push(`${EMOJI.SAFEBROWSING} ${EMOJI.BLOCKED} ${timeDiff}`);
            } else {
              takedownStatusLines.push(`${EMOJI.SAFEBROWSING} ${EMOJI.CLEAN}`);
            }
            
            if (dest.netcraftFlaggedAt) {
              const timeDiff = formatTimeDifference(dest.firstSeenDate, dest.netcraftFlaggedAt);
              takedownStatusLines.push(`${EMOJI.NETCRAFT} ${EMOJI.BLOCKED} ${timeDiff}`);
            } else {
              takedownStatusLines.push(`${EMOJI.NETCRAFT} ${EMOJI.CLEAN}`);
            }
            
            if (dest.smartscreenFlaggedAt) {
              const timeDiff = formatTimeDifference(dest.firstSeenDate, dest.smartscreenFlaggedAt);
              takedownStatusLines.push(`${EMOJI.SMARTSCREEN} ${EMOJI.BLOCKED} ${timeDiff}`);
            } else {
              takedownStatusLines.push(`${EMOJI.SMARTSCREEN} ${EMOJI.CLEAN}`);
            }
            
            if (dest.dnsUnresolvableAt) {
              const timeDiff = formatTimeDifference(dest.firstSeenDate, dest.dnsUnresolvableAt);
              takedownStatusLines.push(`${EMOJI.DNS} ${EMOJI.BLOCKED} ${timeDiff}`);
            } else {
              takedownStatusLines.push(`${EMOJI.DNS} ${EMOJI.CLEAN}`);
            }
          }
          
          let takedownStatus = takedownStatusLines.join('');
          
          embed.addFields(
            {
              name: "Destination",
              value: `[${destUrl.display}](${destUrl.full})\n${takedownStatus}`,
              inline: true
            },
            {
              name: "Timeline",
              value: `First: ${dest.firstSeen}\nLast: ${dest.lastSeen}`,
              inline: true
            },
            {
              name: "Popup",
              value: `${dest.isPopup ? "Yes" : "No"}`,
              inline: true
            }
          );
        }

        embeds.push(embed);
      }

      // Send each embed as a follow-up message
      for (const embed of embeds) {
        await interaction.followUp({ embeds: [embed], flags: "Ephemeral"});
      }
    } catch (error) {
      console.error("Error fetching status:", error);
      await interaction.editReply("There was an error fetching the status.");
    } finally {
      client.release();
    }
  },
};

function formatUrl(url: string): { display: string, full: string } {
  try {
    const urlObj = new URL(url);
    return {
      display: urlObj.hostname,
      full: url
    };
  } catch {
    // If URL parsing fails, return the original
    return {
      display: url,
      full: url
    };
  }
}