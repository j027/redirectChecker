import { SlashCommandBuilder } from "discord.js";
import { CommandDefinition } from "./commands";
import { RedirectType } from "../redirectType";
import { handleRedirect } from "../services/redirectHandlerService";
import pool from "../dbPool";

export const addCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("add")
    .setDescription("Adds redirect to list of redirects")
    .addStringOption((option) =>
      option.setName("url").setDescription("The URL to add").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("regex")
        .setDescription("Regex for popup detection")
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("redirect_type")
        .setDescription("The type of redirect")
        .setRequired(true)
        .addChoices({ name: "HTTP redirect", value: RedirectType.HTTP }),
    )
    .toJSON(),
  async execute(interaction) {
    const url = interaction.options.getString("URL");
    const regex = interaction.options.getString("Regex");
    const redirectType = interaction.options.getString(
      "Redirect Type",
    ) as RedirectType;
    await interaction.deferReply({ flags: "Ephemeral" });

    if (url == null || !isValidUrl(url)) {
      await interaction.editReply(
        "Invalid URL provided. Please enter a valid URL.",
      );
      return;
    }

    if (regex == null || !isValidRegex(regex)) {
      await interaction.editReply(
        "Invalid regex provided. Please enter a valid regex.",
      );
      return;
    }

    if (redirectType == null) {
      await interaction.editReply(
        "Invalid redirect type provided. Please enter a valid redirect type.",
      );
      return;
    }

    const parsedRegex = new RegExp(regex);
    const [redirectDestination, isPopup] = await handleRedirect(
      url,
      parsedRegex,
      redirectType,
    );

    if (redirectDestination == null) {
      await interaction.editReply(
        "Redirect did not go anywhere, please provide a valid redirect or ensure the redirect type is correct.",
      );
      return;
    }

    if (!isPopup) {
      await interaction.editReply(
        `Popup not detected, the redirect may not be redirecting to the expected location or the regex may be incorrect.
        The current destination is ${redirectDestination}`,
      );
      return;
    }

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
      if (client != null) {
        client.release();
      }
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

function isValidRegex(regex: string) {
  try {
    return Boolean(new RegExp(regex));
  } catch (e) {
    return false;
  }
}
