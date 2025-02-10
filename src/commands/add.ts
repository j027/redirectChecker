import { SlashCommandBuilder } from "discord.js";
import { CommandDefinition } from "./commands";
import { RedirectType } from "../redirectType";
import pool from "../dbPool";

export const addCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("add")
    .setDescription("Adds redirect to list of redirects")
    .addStringOption((option) =>
      option.setName("URL").setDescription("The URL to add").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("Regex")
        .setDescription("Regex for popup detection")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("Redirect Type")
        .setDescription("The type of redirect")
        .setRequired(true)
        .addChoices({ name: "HTTP redirect", value: RedirectType.HTTP }),
    )
    .toJSON(),
  async execute(interaction) {
    const url = interaction.options.getString("URL");
    const regex = interaction.options.getString("Regex");
    const redirectType = interaction.options.getString("Redirect Type");
    await interaction.deferReply({ flags: "Ephemeral" });

    if (url == null || !isValidUrl(url)) {
      await interaction.editReply(
        "Invalid URL provided. Please enter a valid URL.",
      );
      return;
    }

    // TODO: validate url and implement core redirect checking functionality

    const client = await pool.connect();

    try {
      const query = "SELECT 1 FROM redirects WHERE source_url = $1 LIMIT 1";
      const result = await client.query(query, [url]);

      if (result.rowCount != null && result.rowCount > 0) {
        await interaction.editReply(`This url already exists in the database`);
        return;
      }

      const insertQuery =
        "INSERT INTO redirects (source_url, regex_pattern, type) VALUES ($1, $2, $3)";
      await client.query(insertQuery, [url, regex, redirectType]);

      await interaction.editReply(`The url "${url}" was added`);
    } finally {
      client.release();
    }
  },
};

function isValidUrl(url: string) {
  try {
    return Boolean(new URL(url));
  } catch (e) {
    return false;
  }
}
