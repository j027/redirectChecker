import { CommandDefinition } from "./commands.js";
import { EMOJI, formatConfidence, formatSignals, SignalData } from "../utils/discordFormatting.js";
import { SlashCommandBuilder, EmbedBuilder, ChatInputCommandInteraction } from "discord.js";
import pool from "../dbPool.js";

export const adsCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("ads")
    .setDescription("Shows recent ads found by hunters")
    .addStringOption((option) =>
      option
        .setName("filter")
        .setDescription("Filter by scam status")
        .setRequired(false)
        .addChoices(
          { name: "Scams Only", value: "scam" },
          { name: "Not Scam Only", value: "not_scam" },
          { name: "All", value: "all" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("type")
        .setDescription("Filter by ad type")
        .setRequired(false)
        .addChoices(
          { name: "Search Ads", value: "search" },
          { name: "Typosquat", value: "typosquat" },
          { name: "Pornhub", value: "pornhub" },
          { name: "AdSpyGlass", value: "adspyglass" }
        )
    )
    .addIntegerOption((option) =>
      option
        .setName("limit")
        .setDescription("Number of ads to show (default: 15, max: 30)")
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(30)
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });

    const filter = interaction.options.getString("filter") ?? "all";
    const adType = interaction.options.getString("type");
    const limit = interaction.options.getInteger("limit") ?? 15;

    const client = await pool.connect();
    try {
      let query = `SELECT a.id, a.ad_type, a.initial_url, a.final_url, a.redirect_path,
                          a.classifier_is_scam, a.confidence_score, a.is_scam,
                          a.first_seen, a.last_seen, a.last_updated,
                          a.signal_fullscreen, a.signal_keyboard_lock, a.signal_pointer_lock,
                          a.signal_third_party_hosting, a.signal_ip_address,
                          a.signal_page_frozen, a.signal_worker_bomb,
                          sa.ad_text, sa.search_url
                   FROM ads a
                   LEFT JOIN search_ads sa ON a.id = sa.ad_id
                   WHERE 1=1`;

      const params: unknown[] = [];
      let paramIdx = 1;

      if (filter === "scam") {
        query += ` AND a.is_scam = true`;
      } else if (filter === "not_scam") {
        query += ` AND a.is_scam = false`;
      }

      if (adType) {
        query += ` AND a.ad_type = $${paramIdx++}`;
        params.push(adType);
      }

      query += ` ORDER BY a.last_seen DESC LIMIT $${paramIdx++}`;
      params.push(limit);

      const result = await client.query(query, params);

      if (result.rows.length === 0) {
        await interaction.editReply("No ads found matching your filters.");
        return;
      }

      // Get summary counts  
      const countQuery = await client.query(
        `SELECT 
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE is_scam = true) as scam_count,
           COUNT(*) FILTER (WHERE is_scam = false) as not_scam_count,
           COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '1 hour') as last_hour,
           COUNT(*) FILTER (WHERE last_seen > NOW() - INTERVAL '24 hours') as last_24h
         FROM ads`
      );
      const counts = countQuery.rows[0];

      const embeds: EmbedBuilder[] = [];
      
      // Summary embed
      const summaryEmbed = new EmbedBuilder()
        .setTitle("📊 Ads Overview")
        .setColor(0x5865f2)
        .setDescription(
          `**Total Ads:** ${counts.total} | **Scams:** ${counts.scam_count} | **Not Scam:** ${counts.not_scam_count}\n` +
          `**Last Hour:** ${counts.last_hour} | **Last 24h:** ${counts.last_24h}\n` +
          `Showing ${result.rows.length} most recent${filter !== "all" ? ` (${filter})` : ""}${adType ? ` [${adType}]` : ""}`
        );
      embeds.push(summaryEmbed);

      // Build ads list
      let currentEmbed = new EmbedBuilder()
        .setTitle("🔎 Recent Ads")
        .setColor(filter === "scam" ? 0xed4245 : filter === "not_scam" ? 0x57f287 : 0x5865f2);

      let fieldCount = 0;

      for (const row of result.rows) {
        if (fieldCount >= 8) {
          embeds.push(currentEmbed);
          currentEmbed = new EmbedBuilder().setColor(0x5865f2);
          fieldCount = 0;
        }

        const scamIcon = row.is_scam ? "🚨" : "✅";
        const lastSeen = `<t:${Math.floor(new Date(row.last_seen).getTime() / 1000)}:R>`;
        const firstSeen = `<t:${Math.floor(new Date(row.first_seen).getTime() / 1000)}:R>`;

        const signals: SignalData = {
          fullscreen: row.signal_fullscreen || false,
          keyboardLock: row.signal_keyboard_lock || false,
          pointerLock: row.signal_pointer_lock || false,
          thirdPartyHosting: row.signal_third_party_hosting || false,
          ipAddress: row.signal_ip_address || false,
          pageFrozen: row.signal_page_frozen || false,
          workerBomb: row.signal_worker_bomb || false,
        };

        const signalStr = formatSignals(signals);
        const confidence = formatConfidence(row.confidence_score);

        // Truncate URLs for display
        const initialUrl = truncateUrl(row.initial_url, 60);
        const finalUrl = truncateUrl(row.final_url, 60);

        let value = `**Source:** ${initialUrl}\n`;
        value += `**Dest:** ${finalUrl}\n`;
        value += `**Confidence:** ${confidence} | **Classifier:** ${row.classifier_is_scam ? "Scam" : "Not Scam"}\n`;
        value += `**First:** ${firstSeen} | **Last:** ${lastSeen}\n`;
        
        if (signalStr) {
          value += `**Signals:** ${signalStr}\n`;
        }
        
        if (row.redirect_path && row.redirect_path.length > 0) {
          value += `**Hops:** ${row.redirect_path.length}`;
        }

        if (row.ad_text) {
          const truncatedText = row.ad_text.length > 80 ? row.ad_text.substring(0, 77) + "..." : row.ad_text;
          value += `\n**Ad Text:** ${truncatedText}`;
        }

        // Truncate total value if needed
        if (value.length > 1024) {
          value = value.substring(0, 1021) + "...";
        }

        currentEmbed.addFields({
          name: `${scamIcon} [${row.ad_type}] ${row.is_scam ? "SCAM" : "Clean"}`,
          value,
          inline: false,
        });

        fieldCount++;
      }

      embeds.push(currentEmbed);
      await interaction.editReply({ embeds: embeds.slice(0, 10) });
    } finally {
      client.release();
    }
  },
};

function truncateUrl(url: string, maxLength: number): string {
  if (!url) return "N/A";
  if (url.length <= maxLength) return url;
  try {
    const parsed = new URL(url);
    return parsed.hostname + (url.length > maxLength ? "..." : "");
  } catch {
    return url.substring(0, maxLength - 3) + "...";
  }
}
