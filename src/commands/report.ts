import { ChatInputCommandInteraction, SlashCommandBuilder } from "discord.js";
import { CommandDefinition } from "./commands.js";
import { reportSite } from "../services/reportService.js";

export const reportCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("report")
    .setDescription("Manually report a phishing URL to security services")
    .addStringOption((option) =>
      option
        .setName("url")
        .setDescription("The phishing URL to report")
        .setRequired(true),
    )
    .toJSON(),
  async execute(interaction: ChatInputCommandInteraction) {
    const url = interaction.options.getString("url");
    await interaction.deferReply({ flags: "Ephemeral" });

    if (url == null || !isValidUrl(url)) {
      await interaction.editReply(
        "Invalid URL provided. Please enter a valid URL.",
      );
      return;
    }

    await interaction.editReply(
      `Reporting \`${url}\` to all security services...\n\nThis will submit the URL to:\n• Google Safe Browsing\n• Google Web Risk\n• Netcraft\n• VirusTotal\n• Kaspersky\n• MetaDefender\n• Microsoft SmartScreen\n• CheckPhish\n• Hybrid Analysis\n• URLScan\n• Cloudflare URL Scanner\n• CRDF Labs\n\nYou'll see the results in the monitoring channel.`,
    );

    try {
      // Report the URL to all security services
      // We pass the same URL for both site and redirect since this is a direct report
      // No screenshot or HTML since we're not visiting the site
      await reportSite(url, url, null, null);
      
      await interaction.followUp({
        content: `✅ Successfully submitted \`${url}\` to all security services!`,
        flags: "Ephemeral",
      });
    } catch (error) {
      console.error("Error reporting URL:", error);
      await interaction.followUp({
        content: "⚠️ There was an error submitting the report. Check the logs for details.",
        flags: "Ephemeral",
      });
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
