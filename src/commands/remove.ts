import {ChatInputCommandInteraction, SlashCommandBuilder} from "discord.js";
import { CommandDefinition } from "./commands.js";
import pool from "../dbPool.js";
import { logRedirectEvent } from "../services/redirectEventLogger.js";

export const removeCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
      .setName("remove")
      .setDescription("Retires redirect from the list of monitored redirects")
      .addIntegerOption((option) =>
          option
              .setName("id")
              .setDescription("The ID of the redirect to remove")
              .setRequired(true)
      )
      .toJSON(),
  async execute(interaction: ChatInputCommandInteraction) {
    const id = interaction.options.getInteger("id");
    await interaction.deferReply({ flags: "Ephemeral" });

    const client = await pool.connect();

    try {
      const query = `
        UPDATE redirects
        SET deleted_at = CURRENT_TIMESTAMP,
            deleted_reason = 'manual'
        WHERE id = $1
          AND deleted_at IS NULL
        RETURNING id, source_url
      `;
      const result = await client.query(query, [id]);

      if (result.rowCount === 0) {
        await interaction.editReply("No active redirect found with the provided ID.");
      } else {
        const sourceUrl = result.rows[0].source_url;
        await logRedirectEvent(
          "redirect_retired",
          "Retired redirect (manual)",
          sourceUrl,
          { id }
        );
        await interaction.editReply(`The redirect with ID ${id} was retired.`);
      }
    } catch (error) {
      console.error("Error removing redirect:", error);
      await interaction.editReply("There was an error removing the redirect.");
    } finally {
      client.release();
    }
  },
};
