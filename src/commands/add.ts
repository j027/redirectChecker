import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { CommandDefinition } from "./commands.js";
import { RedirectType } from "../redirectType.js";
import { handleRedirect } from "../services/redirectHandlerService.js";
import pool from "../dbPool.js";

export const addCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("add")
    .setDescription("Adds redirect to list of redirects")
    .addStringOption((option) =>
      option.setName("url").setDescription("The URL to add").setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName("redirect_type")
        .setDescription("The type of redirect")
        .setRequired(true)
        .addChoices([
          { name: "HTTP redirect", value: RedirectType.HTTP },
          {
            name: "Weebly DigitalOcean JS",
            value: RedirectType.WeeblyDigitalOceanJs,
          },
          {
            name: "Browser Redirect",
            value: RedirectType.BrowserRedirect,
          },
          {
            name: "Browser Redirect Pornhub",
            value: RedirectType.BrowserRedirectPornhub,
          },
        ]),
    )
    .toJSON(),
  async execute(interaction: ChatInputCommandInteraction) {
    const url = interaction.options.getString("url");
    const redirectType = interaction.options.getString(
      "redirect_type",
    ) as RedirectType;
    await interaction.deferReply({ flags: "Ephemeral" });

    if (url == null || !isValidUrl(url)) {
      await interaction.editReply(
        "Invalid URL provided. Please enter a valid URL.",
      );
      return;
    }

    if (redirectType == null) {
      await interaction.editReply(
        "Invalid redirect type provided. Please enter a valid redirect type.",
      );
      return;
    }

    let redirectDestination: string | null = null;
    let isScam: boolean = false;
    let screenshot: Buffer | null = null;
    let html: string | null = null;

    // Verify the redirect with AI classification
    try {
      await interaction.editReply("Attempting to validate redirect...");
      [redirectDestination, isScam, screenshot, html] = await handleRedirect(
        url,
        redirectType,
      );
    } catch (error) {
      await interaction.editReply(
        "There was an error attempting to validate the redirect.",
      );
      console.log(error);
      return;
    }

    if (redirectDestination == null) {
      await interaction.editReply(
        "Redirect did not go anywhere, please provide a valid redirect or ensure the redirect type is correct.",
      );
      return;
    }

    if (!isScam) {
      await interaction.editReply(
        `No scam detected, the redirect may not be redirecting to a malicious site.\nThe current destination is \`${redirectDestination}\``
      );
      return;
    }

    await interaction.editReply(
      `The redirect has been detected as a scam, it will be added to monitoring.\nThe current destination is \`${redirectDestination}\``,
    );

    const client = await pool.connect();

    try {
      const query = "SELECT 1 FROM redirects WHERE source_url = $1 LIMIT 1";
      const result = await client.query(query, [url]);

      if (result.rowCount != null && result.rowCount > 0) {
        await interaction.editReply(`This URL already exists in the database`);
        return;
      }

      const insertQuery =
        "INSERT INTO redirects (source_url, type) VALUES ($1, $2)";
      await client.query(insertQuery, [url, redirectType]);

      await interaction.editReply(
        `The URL \`${url}\` was added to monitoring.\nThe current destination is \`${redirectDestination}\`\nAI classification: ${isScam ? '⚠️ SCAM' : '✅ SAFE'}`
      );
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
