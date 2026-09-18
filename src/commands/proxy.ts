import { CommandDefinition } from "./commands.js";
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ChatInputCommandInteraction,
} from "discord.js";
import pool from "../dbPool.js";

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max - 3) + "..." : value;
}

export const proxyCommand: CommandDefinition = {
  command: new SlashCommandBuilder()
      .setName("proxy")
      .setDescription("Shows the last known hunter proxy IP and recent proxy events")
      .toJSON(),

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: "Ephemeral" });

    const embed = new EmbedBuilder()
      .setTitle("Hunter Proxy Status")
      .setColor(0x00ae86);

    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT event_type, message, ip_address, created_at
         FROM proxy_events
         ORDER BY created_at DESC
         LIMIT 8`
      );

      const lastIpEvent = result.rows.find(
        (row) => row.event_type === "ip_check" || row.ip_address != null
      );

      embed.addFields({
        name: "Last known IP",
        value: lastIpEvent?.ip_address ?? "unknown",
        inline: true,
      });

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
