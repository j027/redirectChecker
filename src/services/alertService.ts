import { EmbedBuilder, TextChannel } from "discord.js";
import { readConfig } from "../config.js";
import { discordClient } from "../discordClient.js";

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

/** Max characters for a single URL before it gets truncated */
const MAX_SINGLE_URL_LENGTH = 350;

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
 * Build the redirect path for the embed description.
 * Strategy: show full URLs at the start and end of the chain (most important),
 * only truncate excessively long individual URLs, and collapse the middle
 * of the chain if the total exceeds the available character budget.
 */
function buildRedirectPathDescription(
  initialUrl: string,
  finalUrl: string,
  redirectionPath: string[] | null,
  availableChars: number
): string {
  if (!redirectionPath || redirectionPath.length === 0) {
    return `**Initial:** ${truncate(initialUrl, 400)}\n**Final:** ${truncate(finalUrl, 400)}`;
  }

  const header = "**Redirect Path**\n";
  const budget = availableChars - header.length;

  // Format each URL as a numbered line, truncating only excessively long ones
  const allLines = redirectionPath.map(
    (url, i) => `${i + 1}. ${truncate(url, MAX_SINGLE_URL_LENGTH)}`
  );

  // If everything fits, return it all
  const fullText = allLines.join("\n");
  if (fullText.length <= budget) {
    return header + fullText;
  }

  // Doesn't fit — keep as many from the start and end as possible,
  // collapsing the middle of the chain.
  // Start with 3 from each end and increase if space allows.
  const total = allLines.length;
  let keepStart = Math.min(3, total);
  let keepEnd = Math.min(3, total);

  // Try to show more from each end if there's room
  for (let extra = 0; extra < total; extra++) {
    const candidateStart = Math.min(keepStart + 1, total - keepEnd);
    const candidateEnd = keepEnd;
    if (candidateStart + candidateEnd >= total) break;

    const hidden = total - candidateStart - candidateEnd;
    const collapsedLine = `\n   ... ${hidden} more redirect(s) ...\n`;
    const headText = allLines.slice(0, candidateStart).join("\n");
    const tailText = allLines.slice(total - candidateEnd).join("\n");
    const candidate = headText + collapsedLine + tailText;

    if (candidate.length > budget) break;
    keepStart = candidateStart;

    // Try adding one more to the end too
    const candidateEnd2 = Math.min(keepEnd + 1, total - keepStart);
    if (keepStart + candidateEnd2 < total) {
      const hidden2 = total - keepStart - candidateEnd2;
      const collapsedLine2 = `\n   ... ${hidden2} more redirect(s) ...\n`;
      const tailText2 = allLines.slice(total - candidateEnd2).join("\n");
      const candidate2 = allLines.slice(0, keepStart).join("\n") + collapsedLine2 + tailText2;
      if (candidate2.length <= budget) {
        keepEnd = candidateEnd2;
      }
    }
  }

  if (keepStart + keepEnd >= total) {
    // Everything fits after all (shouldn't happen but safe fallback)
    return header + fullText;
  }

  const hidden = total - keepStart - keepEnd;
  const collapsedLine = `\n   ... ${hidden} more redirect(s) ...\n`;
  const headText = allLines.slice(0, keepStart).join("\n");
  const tailText = allLines.slice(total - keepEnd).join("\n");
  return truncate(header + headText + collapsedLine + tailText, availableChars);
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

    // Add type-specific fields (these use the 1024-char field limit)
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

    // Add cloaker info as a field (short enough for field limit)
    if (payload.cloakerCandidate) {
      embed.addFields({
        name: "Potential Cloaker",
        value: truncate(payload.cloakerCandidate, EMBED_FIELD_VALUE_LIMIT),
        inline: false,
      });
    }

    // Use the embed description (4096 char limit) for the redirect path
    // so we can show far more of the chain than a field allows
    const redirectDescription = buildRedirectPathDescription(
      payload.initialUrl,
      payload.finalUrl,
      payload.redirectionPath,
      EMBED_DESCRIPTION_LIMIT
    );
    embed.setDescription(redirectDescription);

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
  huntType: string,
  strategy?: string | null
): Promise<void> {
  try {
    const { channelId } = await readConfig();
    const channel = discordClient.channels.cache.get(channelId) as TextChannel;

    if (!channel) {
      console.error("Discord channel not found");
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle("✅ Added to Redirect Checker")
      .setColor(0x00cc00) // Green
      .setTimestamp()
      .addFields(
        { name: "URL", value: truncate(cloakerUrl, EMBED_FIELD_VALUE_LIMIT), inline: false },
        { name: "Source", value: huntType, inline: true }
      );

    if (strategy) {
      embed.addFields({ name: "Strategy", value: strategy, inline: true });
    }

    await channel.send({ embeds: [embed] });
    console.log(`Redirect checker addition confirmation sent for: ${cloakerUrl}`);
  } catch (error) {
    console.error(`Error sending Discord notification: ${error}`);
  }
}
