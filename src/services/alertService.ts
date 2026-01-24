import { EmbedBuilder, TextChannel } from "discord.js";
import { readConfig } from "../config.js";
import { discordClient } from "../discordBot.js";

// Add pornhubAd and adspyglass as new alert types
export type AlertType = "adScam" | "typosquat" | "pornhubAd" | "adspyglass";

export interface AlertPayload {
  type: AlertType;
  initialUrl: string;
  finalUrl: string;
  adText?: string;
  isNew?: boolean;
  confidenceScore: number;
  redirectionPath: string[] | null;
  cloakerCandidate?: string | null;
}

// Discord embed limits
const EMBED_FIELD_VALUE_LIMIT = 1024;
const EMBED_DESCRIPTION_LIMIT = 4096;

/**
 * Truncate a string to a maximum length, adding ellipsis if truncated
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.substring(0, maxLength - 3) + "...";
}

/**
 * Get alert configuration based on type
 */
function getAlertConfig(type: AlertType, isNew: boolean): { emoji: string; title: string; color: number } {
  const configs: Record<AlertType, { newTitle: string; existingTitle: string; color: number }> = {
    adScam: {
      newTitle: "NEW SEARCH AD SCAM DETECTED",
      existingTitle: "EXISTING SEARCH AD NOW MARKED AS SCAM",
      color: 0xff0000, // Red
    },
    typosquat: {
      newTitle: "NEW TYPOSQUAT SCAM DESTINATION",
      existingTitle: "NEW TYPOSQUAT SCAM DESTINATION",
      color: 0xff6600, // Orange
    },
    pornhubAd: {
      newTitle: "NEW PORNHUB AD SCAM DETECTED",
      existingTitle: "EXISTING PORNHUB AD NOW MARKED AS SCAM",
      color: 0xff0000, // Red
    },
    adspyglass: {
      newTitle: "NEW ADSPYGLASS AD SCAM DETECTED",
      existingTitle: "EXISTING ADSPYGLASS AD NOW MARKED AS SCAM",
      color: 0xff0000, // Red
    },
  };

  const config = configs[type];
  return {
    emoji: isNew ? "🚨" : "⚠️",
    title: isNew ? config.newTitle : config.existingTitle,
    color: config.color,
  };
}

/**
 * Build redirect path field value with truncation
 */
function buildRedirectPathValue(
  initialUrl: string,
  finalUrl: string,
  redirectionPath: string[] | null
): string {
  if (redirectionPath && redirectionPath.length > 0) {
    let result = "";
    let truncated = false;

    for (let i = 0; i < redirectionPath.length; i++) {
      const line = `${i + 1}. ${redirectionPath[i]}\n`;
      // Reserve space for truncation message
      if (result.length + line.length > EMBED_FIELD_VALUE_LIMIT - 50) {
        const remaining = redirectionPath.length - i;
        result += `... and ${remaining} more redirect(s)`;
        truncated = true;
        break;
      }
      result += line;
    }

    return result.trim();
  } else {
    return `**Initial:** ${truncate(initialUrl, 400)}\n**Final:** ${truncate(finalUrl, 400)}`;
  }
}

/**
 * Unified alert function that handles different alert types using embeds
 */
export async function sendAlert(payload: AlertPayload): Promise<void> {
  try {
    const { channelId } = await readConfig();
    const channel = discordClient.channels.cache.get(channelId) as TextChannel;

    if (!channel) {
      console.error("Discord channel not found");
      return;
    }

    // Format confidence as percentage with 2 decimal places
    const confidencePercent = (payload.confidenceScore * 100).toFixed(2);
    const isNew = payload.isNew ?? true;
    const alertConfig = getAlertConfig(payload.type, isNew);

    // Build the embed
    const embed = new EmbedBuilder()
      .setTitle(`${alertConfig.emoji} ${alertConfig.title} ${alertConfig.emoji}`)
      .setColor(alertConfig.color)
      .setTimestamp()
      .setFooter({ text: `Confidence: ${confidencePercent}%` });

    // Add type-specific fields
    if (payload.type === "typosquat") {
      embed.addFields(
        { name: "Typosquat Domain", value: truncate(payload.initialUrl, EMBED_FIELD_VALUE_LIMIT), inline: false },
        { name: "Final URL", value: truncate(payload.finalUrl, EMBED_FIELD_VALUE_LIMIT), inline: false }
      );
    }

    // Add ad text for adScam type
    if (payload.type === "adScam" && payload.adText) {
      const formattedAdText = payload.adText.replace(/\s+/g, " ").trim();
      embed.addFields({
        name: "Ad Text",
        value: truncate(formattedAdText, EMBED_FIELD_VALUE_LIMIT),
        inline: false,
      });
    }

    // Add redirect path
    const redirectValue = buildRedirectPathValue(
      payload.initialUrl,
      payload.finalUrl,
      payload.redirectionPath
    );
    embed.addFields({
      name: "Redirect Path",
      value: truncate(redirectValue, EMBED_FIELD_VALUE_LIMIT),
      inline: false,
    });

    // Add cloaker info if available
    if (payload.cloakerCandidate) {
      embed.addFields({
        name: "Potential Cloaker",
        value: truncate(payload.cloakerCandidate, EMBED_FIELD_VALUE_LIMIT),
        inline: false,
      });
    }

    await channel.send({ embeds: [embed] });
    console.log(`Discord ${payload.type} alert sent`);
  } catch (error) {
    console.error(`Error sending Discord notification: ${error}`);
    // Non-critical functionality, don't throw
  }
}

/**
 * Sends a simple confirmation when a URL is added to the redirect checker
 *
 * @param cloakerUrl The URL that was added to redirect checker
 * @param huntType The type of hunt that found it
 */
export async function sendCloakerAddedAlert(
  cloakerUrl: string,
  huntType: string
): Promise<void> {
  try {
    const { channelId } = await readConfig();
    const channel = discordClient.channels.cache.get(channelId) as TextChannel;

    if (!channel) {
      console.error("Discord channel not found");
      return;
    }

    // Simple confirmation message
    const messageText = `✅ Added to redirect checker: \`${cloakerUrl}\` (from ${huntType} hunter)`;

    await channel.send(messageText);
    console.log(`Redirect checker addition confirmation sent for: ${cloakerUrl}`);
  } catch (error) {
    console.error(`Error sending Discord notification: ${error}`);
  }
}
