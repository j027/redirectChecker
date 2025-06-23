import { TextChannel } from "discord.js";
import { readConfig } from "../config.js";
import { discordClient } from "../discordBot.js";

export async function sendTyposquatAlert(
  typosquatDomain: string,
  finalUrl: string,
  confidenceScore: number,
  redirectionPath: string[] | null = null
) {
  try {
    const { channelId } = await readConfig();
    const channel = discordClient.channels.cache.get(channelId) as TextChannel;

    if (channel) {
      // Format confidence as percentage with 2 decimal places
      const confidencePercent = (confidenceScore * 100).toFixed(2);

      // Build message components
      const header = `🚨 NEW TYPOSQUAT SCAM DESTINATION 🚨 (Confidence: ${confidencePercent}%)`;

      let pathSection = `**Typosquat Domain:** ${typosquatDomain}\n**Final URL:** ${finalUrl}\n\n`;

      if (redirectionPath && redirectionPath.length > 0) {
        pathSection += "**Redirect Path:**\n";
        redirectionPath.forEach((url, index) => {
          pathSection += `${index + 1}. ${url}\n`;
        });
      }

      // Combine all sections
      const messageText = `${header}\n\n${pathSection}`;

      await channel.send(messageText);
      console.log("Discord typosquat alert sent");
    } else {
      console.error("Discord channel not found");
    }
  } catch (error) {
    console.error(`Error sending Discord notification: ${error}`);
  }
}

export async function sendAdScamAlert(
  adDestination: string,
  finalUrl: string,
  adText: string,
  isNew: boolean = true,
  confidenceScore: number,
  redirectionPath: string[] | null = null
) {
  try {
    const { channelId } = await readConfig();
    const channel = discordClient.channels.cache.get(channelId) as TextChannel;

    if (channel) {
      // Format confidence as percentage with 2 decimal places
      const confidencePercent = (confidenceScore * 100).toFixed(2);

      // Format ad text: clean up extra whitespace and limit length
      const formattedAdText = adText
        .replace(/\s+/g, " ")
        .trim()
        .substring(0, 150);

      // Build message components
      const header = isNew
        ? `🚨 NEW SCAM AD DETECTED 🚨 (Confidence: ${confidencePercent}%)`
        : `⚠️ EXISTING AD NOW MARKED AS SCAM ⚠️ (Confidence: ${confidencePercent}%)`;

      const adTextSection = `**Ad Text:**\n${formattedAdText}${formattedAdText.length >= 150 ? "..." : ""}`;

      // Build redirect path section
      let pathSection = "";
      if (redirectionPath && redirectionPath.length > 0) {
        pathSection = "**Redirect Path:**\n";
        redirectionPath.forEach((url, index) => {
          pathSection += `${index + 1}. ${url}\n`;
        });
      } else {
        pathSection = `**Initial URL:** ${adDestination}\n**Final URL:** ${finalUrl}`;
      }

      // Combine all sections
      const messageText = `${header}\n\n${adTextSection}\n\n${pathSection}`;

      await channel.send(messageText);
      console.log("Discord alert sent");
    } else {
      console.error("Ad hunter Discord channel not found");
    }
  } catch (error) {
    console.error(`Error sending Discord notification: ${error}`);
    // Don't throw - this is non-critical functionality
  }
}
