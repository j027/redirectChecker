import { CommandDefinition } from "./commands";
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import pool from "../dbPool";

export const statusCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("status")
    .setDescription("Displays all redirects and their current status")
    .toJSON(),

  async execute(interaction) {
    await interaction.deferReply({ flags: "Ephemeral" });
    const client = await pool.connect();

    try {
      const query = `
        SELECT r.id AS redirect_id,
               r.source_url,
               r.regex_pattern,
               r.type,
               d.destination_url,
               d.first_seen,
               d.last_seen,
               d.is_popup
        FROM redirects r
        LEFT JOIN (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY redirect_id ORDER BY last_seen DESC) AS rn
          FROM redirect_destinations
        ) d ON r.id = d.redirect_id AND d.rn <= 8
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
        }>;
      }>();

      for (const row of result.rows) {
        const id = row.redirect_id;
        if (!redirects.has(id)) {
          // Create a new group entry with header info
          const header = `**Source URL:** ${row.source_url}\n**Regex Pattern:** \`${row.regex_pattern}\`\n**Type:** ${row.type}`;
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
            isPopup: row.is_popup
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
          embed.addFields(
            {
              name: "Destination",
              value: dest.url,
              inline: true
            },
            {
              name: "Timeline",
              value: `First: ${dest.firstSeen}\nLast: ${dest.lastSeen}`,
              inline: true
            },
            {
              name: "Popup",
              value: dest.isPopup ? "Yes" : "No",
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
