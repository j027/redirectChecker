import { CommandDefinition } from "./commands.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import pool from "../dbPool.js";
import { hunterProxyService } from "../services/hunterProxyService.js";

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 3) + "..." : value;
}

export const proxyCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
    .setName("proxy")
    .setDescription(
      "Shows hunter proxy state, in-flight operations, and recent proxy events"
    )
    .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });

    const status = hunterProxyService.getStatus();
    const operations =
      status.operations.length > 0
        ? status.operations
            .map((op) => `${op.name} (${Math.round(op.elapsedMs / 1000)}s)`)
            .join("\n")
        : "none";

    const embed = new EmbedBuilder()
      .setTitle("Hunter Proxy Status")
      .setColor(
        status.healthy && status.state === "ready" ? 0x00ae86 : 0xd9534f
      )
      .addFields(
        {
          name: "State",
          value: `${status.state} (healthy: ${status.healthy ? "yes" : "no"})`,
          inline: true,
        },
        { name: "In-flight", value: `${status.inFlight}`, inline: true },
        { name: "Waiters", value: `${status.waiters}`, inline: true },
        {
          name: "Last known IP",
          value: status.lastKnownIp ?? "unknown",
          inline: true,
        },
        { name: "Generation", value: `${status.generation}`, inline: true },
        {
          name: "Active operations",
          value: truncate(operations, 1024),
          inline: false,
        }
      );

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT event_type, message, created_at
         FROM proxy_events
         ORDER BY created_at DESC
         LIMIT 8`
      );

      const events = result.rows
        .map((row) => {
          const ts = `<t:${Math.floor(
            new Date(row.created_at).getTime() / 1000
          )}:R>`;
          return `${ts} **${row.event_type}**: ${truncate(
            row.message ?? "",
            160
          )}`;
        })
        .join("\n");

      embed.addFields({
        name: "Recent events",
        value: events.length > 0 ? truncate(events, 1024) : "none",
      });
    } catch (error) {
      console.error("Error fetching proxy events:", error);
      embed.addFields({
        name: "Recent events",
        value: "error fetching proxy events",
      });
    } finally {
      client.release();
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
