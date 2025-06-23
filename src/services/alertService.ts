import { TextChannel } from "discord.js";
import { readConfig } from "../config.js";
import { discordClient } from "../discordBot.js";

export type AlertType = "adScam" | "typosquat";

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

/**
 * Unified alert function that handles different alert types
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

    // Build message based on alert type
    let messageText = "";

    if (payload.type === "adScam") {
      // Ad Scam alert formatting
      const header = payload.isNew
        ? `🚨 NEW SEARCH AD SCAM DETECTED 🚨 (Confidence: ${confidencePercent}%)`
        : `⚠️ EXISTING SEARCH AD NOW MARKED AS SCAM ⚠️ (Confidence: ${confidencePercent}%)`;

      // Format ad text if available
      let adTextSection = "";
      if (payload.adText) {
        const formattedAdText = payload.adText
          .replace(/\s+/g, " ")
          .trim()
          .substring(0, 150);

        adTextSection = `**Ad Text:**\n${formattedAdText}${formattedAdText.length >= 150 ? "..." : ""}\n\n`;
      }

      // Build path section
      const pathSection = buildRedirectPathSection(
        payload.initialUrl,
        payload.finalUrl,
        payload.redirectionPath
      );

      // Include cloaker info if available
      const cloakerSection = payload.cloakerCandidate
        ? `\n**Potential Cloaker:**\n${payload.cloakerCandidate}`
        : "";

      messageText = `${header}\n\n${adTextSection}${pathSection}${cloakerSection}`;
    } else if (payload.type === "typosquat") {
      // Typosquat alert formatting
      const header = `🚨 NEW TYPOSQUAT SCAM DESTINATION 🚨 (Confidence: ${confidencePercent}%)`;

      // Include domain info
      let pathSection = `**Typosquat Domain:** ${payload.initialUrl}\n**Final URL:** ${payload.finalUrl}\n\n`;

      // Add redirect path if available
      if (payload.redirectionPath && payload.redirectionPath.length > 0) {
        pathSection += buildRedirectList(payload.redirectionPath);
      }

      // Include cloaker info if available
      const cloakerSection = payload.cloakerCandidate
        ? `\n**Potential Cloaker:**\n${payload.cloakerCandidate}`
        : "";

      messageText = `${header}\n\n${pathSection}${cloakerSection}`;
    }

    await channel.send(messageText);
    console.log(`Discord ${payload.type} alert sent`);
  } catch (error) {
    console.error(`Error sending Discord notification: ${error}`);
    // Non-critical functionality, don't throw
  }
}

/**
 * Helper to build the redirect path section
 */
function buildRedirectPathSection(
  initialUrl: string,
  finalUrl: string,
  redirectionPath: string[] | null
): string {
  if (redirectionPath && redirectionPath.length > 0) {
    return buildRedirectList(redirectionPath);
  } else {
    return `**Initial URL:** ${initialUrl}\n**Final URL:** ${finalUrl}`;
  }
}

/**
 * Helper to format redirection list
 */
function buildRedirectList(redirectionPath: string[]): string {
  let result = "**Redirect Path:**\n";
  redirectionPath.forEach((url, index) => {
    result += `${index + 1}. ${url}\n`;
  });
  return result;
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
