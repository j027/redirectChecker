import { CommandDefinition } from "./commands";
import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import pool from "../dbPool";

export const statusCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
      .setName("status")
      .setDescription("Displays all redirects and their current status")
      .toJSON(),

  async execute(interaction) {
    await interaction.deferReply();

    const client = await pool.connect();

    try {
      // Fetch all redirects and their 10 most recent redirect destinations
      const query = `
        SELECT r.id AS redirect_id, r.source_url, r.regex_pattern, r.type,
               d.destination_url, d.first_seen, d.last_seen, d.is_popup
        FROM redirects r
        LEFT JOIN (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY redirect_id ORDER BY last_seen DESC) AS rn
          FROM redirect_destinations
        ) d ON r.id = d.redirect_id AND d.rn <= 10
        ORDER BY r.id, d.last_seen DESC;
      `;
      const result = await client.query(query);

      if (result.rows.length === 0) {
        await interaction.editReply("No redirects found.");
        return;
      }

      const embeds = [];
      let currentEmbed = new EmbedBuilder()
          .setTitle("Redirects Status")
          .setColor(0x00AE86);

      let currentRedirectId = null;
      let redirectInfo = "";

      for (const row of result.rows) {
        if (row.redirect_id !== currentRedirectId) {
          if (currentRedirectId !== null) {
            currentEmbed.addFields({ name: `Redirect ID: ${currentRedirectId}`, value: redirectInfo });
            if (currentEmbed.length > 6000) {
              embeds.push(currentEmbed);
              currentEmbed = new EmbedBuilder()
                  .setTitle("Redirects Status (cont.)")
                  .setColor(0x00AE86);
            }
          }
          currentRedirectId = row.redirect_id;
          redirectInfo = `**Source URL**: ${row.source_url}\n**Regex Pattern**: ${row.regex_pattern}\n**Type**: ${row.type}\n\n### Most Recent 10 Redirect Destinations:\n`;
        }
        if (row.destination_url) {
          redirectInfo += `**Destination URL**: ${row.destination_url}\n**First Seen**: <t:${Math.floor(new Date(row.first_seen).getTime() / 1000)}:F>\n**Last Seen**: <t:${Math.floor(new Date(row.last_seen).getTime() / 1000)}:F>\n**Is Popup**: ${row.is_popup}\n\n`;
        }
      }

      if (currentRedirectId !== null) {
        currentEmbed.addFields({ name: `Redirect ID: ${currentRedirectId}`, value: redirectInfo });
        embeds.push(currentEmbed);
      }

      for (const embed of embeds) {
        await interaction.followUp({ embeds: [embed] });
      }
    } catch (error) {
      console.error("Error fetching status:", error);
      await interaction.editReply("There was an error fetching the status.");
    } finally {
      client.release();
    }
  },
};