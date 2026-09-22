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
import {
  formatConfidence,
  formatSignals,
  SignalData,
} from "../utils/discordFormatting.js";
import pool from "../dbPool.js";
import { setTimeout as sleep } from "timers/promises";

const DESTINATION_INLINE_LIMIT = 1000;
const CLASSIFICATION_ATTEMPTS = 3;
const CLASSIFICATION_RETRY_DELAY_MS = 2_000;

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

    try {
      await interaction.editReply("Attempting to validate redirect...");
      console.log(`[add] stage=validating url=${url} type=${redirectType}`);
      redirectDestination = await handleRedirect(url, redirectType);
      console.log(
        `[add] stage=validated destination=${redirectDestination ?? "none"}`
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
        "Classifying destination...",
      ...(destinationFiles.length > 0 ? { files: destinationFiles } : {}),
    });

    // attempt classification; a null result can be transient (proxy rotation
    // recovery, navigation timeout), so retry a bounded number of times
    let classificationResult: ClassificationResult | null = null;
    for (let attempt = 1; attempt <= CLASSIFICATION_ATTEMPTS; attempt++) {
      try {
        console.log(
          `[add] stage=classifying destination=${redirectDestination} attempt=${attempt}/${CLASSIFICATION_ATTEMPTS}`,
        );
        classificationResult = await aiClassifierService.classifyUrl(
          redirectDestination,
        );
        if (classificationResult != null) {
          break;
        }
        console.warn(
          `[add] stage=classification_empty attempt=${attempt}/${CLASSIFICATION_ATTEMPTS}`,
        );
      } catch (error) {
        console.log(error);
      }

      if (attempt < CLASSIFICATION_ATTEMPTS) {
        await sleep(CLASSIFICATION_RETRY_DELAY_MS);
      }
    }

    if (classificationResult == null) {
      await interaction.followUp({
        content:
          "There was an error attempting to classify the redirect destination.\n" +
          destinationLine,
        flags: "Ephemeral",
      });
      return;
    }
    console.log(`[add] stage=classified isScam=${classificationResult.isScam}`);

    const isScam = classificationResult.isScam;

    // add to monitoring when classified as a scam
    let action = "Not added: destination was not classified as a scam";
    if (isScam) {
      const client = await pool.connect();

      try {
        const query =
          "SELECT id, deleted_at FROM redirects WHERE source_url = $1 ORDER BY deleted_at IS NULL DESC, id DESC LIMIT 1";
        const result = await client.query(query, [url]);

        if (result.rowCount != null && result.rowCount > 0) {
          const existing = result.rows[0];

          if (existing.deleted_at != null) {
            await client.query(
              `UPDATE redirects
               SET deleted_at = NULL, deleted_reason = NULL, type = $2
               WHERE id = $1`,
              [existing.id, redirectType],
            );
            action = "Reactivated in monitoring";
          } else {
            action = "Not added: this URL already exists in the database";
          }
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

    const attachment = new AttachmentBuilder(
      classificationResult.screenshot,
      { name: "destination.png" },
    );

    try {
      await interaction.followUp({
        embeds: [embed],
        files: [attachment],
        flags: "Ephemeral",
      });
    } catch (error) {
      console.error(
        "Failed to send /add result with screenshot, retrying without it:",
        error,
      );
      try {
        await interaction.followUp({ embeds: [embed], flags: "Ephemeral" });
      } catch (fallbackError) {
        console.error("Failed to send /add result embed:", fallbackError);
      }
    }
  },
};
