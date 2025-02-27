import {ChatInputCommandInteraction, SlashCommandBuilder} from "discord.js";
import { CommandDefinition } from "./commands.js";
import pool from "../dbPool.js";

export const removeCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
      .setName("remove")
      .setDescription("Removes redirect from list of redirects")
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
      const query = "DELETE FROM redirects WHERE id = $1 RETURNING *";
      const result = await client.query(query, [id]);

      if (result.rowCount === 0) {
        await interaction.editReply("No redirect found with the provided ID.");
      } else {
        await interaction.editReply(`The redirect with ID ${id} was removed.`);
      }
    } catch (error) {
      console.error("Error removing redirect:", error);
      await interaction.editReply("There was an error removing the redirect.");
    } finally {
      client.release();
    }
  },
};