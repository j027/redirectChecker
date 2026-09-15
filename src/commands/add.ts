import {
  AttachmentBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";
import { CommandDefinition } from "./commands.js";
import { RedirectType } from "../redirectType.js";
import { handleRedirect } from "../services/redirectHandlerService.js";
import {
  aiClassifierService,
  ClassificationResult,
  CONFIDENCE_THRESHOLD,
} from "../services/aiClassifierService.js";
import { hasWeightedSignal } from "../services/signalService.js";
import { isValidUrl } from "../utils/urlUtils.js";
import { formatRequestLog, CapturedRequest } from "../utils/requestLogger.js";
import {
  formatConfidence,
  formatSignals,
  SignalData,
} from "../utils/discordFormatting.js";
import pool from "../dbPool.js";

const DESTINATION_INLINE_LIMIT = 1000;

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
            name: "Browser Redirect",
            value: RedirectType.BrowserRedirect,
          },
          {
            name: "Browser Redirect Pornhub",
            value: RedirectType.BrowserRedirectPornhub,
          },
          {
            name: "Browser Redirect Hunter Proxy",
            value: RedirectType.BrowserRedirectHunterProxy
          }
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
    let redirectRequests: CapturedRequest[] = [];

    try {
      await interaction.editReply("Attempting to validate redirect...");
      const redirectResult = await handleRedirect(
        url,
        redirectType,
        true,
      );
      redirectDestination = redirectResult.location;
      redirectRequests = redirectResult.requests;
    } catch (error) {
      await interaction.editReply(
        "There was an error attempting to validate the redirect.",
      );
      console.log(error);
      return;
    }

    if (redirectDestination == null) {
      const requestLog = formatRequestLog(redirectRequests);

      if (requestLog.length === 0) {
        await interaction.editReply(
          "Redirect did not go anywhere, please provide a valid redirect or ensure the redirect type is correct.",
        );
        return;
      }

      if (requestLog.length <= 1500) {
        await interaction.editReply(
          "Redirect did not go anywhere, please provide a valid redirect or ensure the redirect type is correct.\n\n**HTTP request log:**\n```\n" +
            requestLog +
            "\n```",
        );
        return;
      }

      const attachment = new AttachmentBuilder(
        Buffer.from(requestLog, "utf-8"),
        { name: `redirect-requests-${Date.now()}.txt` },
      );
      await interaction.editReply({
        content:
          "Redirect did not go anywhere, please provide a valid redirect or ensure the redirect type is correct.\n\nFull HTTP request log attached below.",
        files: [attachment],
      });
      return;
    }

    // Message 1: keep the destination visible while classification runs
    const destinationFiles: AttachmentBuilder[] = [];
    let destinationLine: string;

    if (redirectDestination.length > DESTINATION_INLINE_LIMIT) {
      destinationFiles.push(
        new AttachmentBuilder(Buffer.from(redirectDestination, "utf-8"), {
          name: "destination-url.txt",
        }),
      );
      destinationLine = `**Destination:** attached as \`destination-url.txt\` (${redirectDestination.length} chars)`;
    } else {
      destinationLine = `**Destination:** \`${redirectDestination}\``;
    }

    await interaction.editReply({
      content:
        `${destinationLine}\n` +
        `**Redirect type:** \`${redirectType}\`\n` +
        `**Hops:** ${redirectRequests.length}\n` +
        "Classifying destination...",
      ...(destinationFiles.length > 0 ? { files: destinationFiles } : {}),
    });

    // attempt classification
    let classificationResult: ClassificationResult | null = null;
    try {
      classificationResult = await aiClassifierService.classifyUrl(
        redirectDestination,
      );
      if (classificationResult == null) {
        throw new Error("Failed to get classification result");
      }
    } catch (error) {
      console.log(error);
      await interaction.followUp({
        content:
          "There was an error attempting to classify the redirect destination.\n" +
          destinationLine,
        flags: "Ephemeral",
      });
      return;
    }

    const isScam = classificationResult.isScam;

    // add to monitoring when classified as a scam
    let action = "Not added: destination was not classified as a scam";
    if (isScam) {
      const client = await pool.connect();

      try {
        const query = "SELECT 1 FROM redirects WHERE source_url = $1 LIMIT 1";
        const result = await client.query(query, [url]);

        if (result.rowCount != null && result.rowCount > 0) {
          action = "Not added: this URL already exists in the database";
        } else {
          const insertQuery =
            "INSERT INTO redirects (source_url, type) VALUES ($1, $2)";
          await client.query(insertQuery, [url, redirectType]);
          action = "Added to monitoring";
        }
      } catch (error) {
        console.error("Error adding redirect to database:", error);
        action = "Failed to add to monitoring: database error";
      } finally {
        if (client != null) {
          client.release();
        }
      }
    }

    const signals: SignalData = {
      fullscreen: classificationResult.signals.fullscreenRequested,
      keyboardLock: classificationResult.signals.keyboardLockRequested,
      pointerLock: classificationResult.signals.pointerLockRequested,
      thirdPartyHosting: classificationResult.signals.isThirdPartyHosting,
      ipAddress: classificationResult.signals.isIpAddress,
      pageFrozen: classificationResult.signals.pageLoadFrozen,
      workerBomb: classificationResult.signals.workerBombDetected,
    };

    const signalStr = formatSignals(signals);
    const confidence = formatConfidence(classificationResult.confidenceScore);
    const effectiveScam =
      classificationResult.isScam &&
      classificationResult.confidenceScore >= CONFIDENCE_THRESHOLD &&
      hasWeightedSignal(classificationResult.signals);

    const embed = new EmbedBuilder()
      .setTitle(isScam ? "⚠️ Scam detected" : "✅ No scam detected")
      .setColor(isScam ? 0xed4245 : 0x57f287)
      .addFields(
        {
          name: "Model verdict",
          value: `${classificationResult.isScam ? "SCAM" : "Not scam"} (${confidence})`,
          inline: true,
        },
        {
          name: "Effective verdict",
          value: effectiveScam ? "Scam" : "Not flagged",
          inline: true,
        },
        { name: "Signals", value: signalStr.length > 0 ? signalStr : "None" },
        { name: "Action", value: action },
      );

    if (redirectDestination.length <= DESTINATION_INLINE_LIMIT) {
      embed.addFields({
        name: "Destination",
        value: `\`${redirectDestination}\``,
      });
    }

    await interaction.followUp({
      embeds: [embed],
      files: [
        new AttachmentBuilder(classificationResult.screenshot, {
          name: "destination.png",
        }),
      ],
      flags: "Ephemeral",
    });
  },
};
