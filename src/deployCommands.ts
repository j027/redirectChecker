import {
  REST,
  Routes,
  GatewayIntentBits,
  RESTPutAPIApplicationGuildCommandsJSONBody,
  RESTPutAPIApplicationGuildCommandsResult,
} from "discord.js";
import { readConfig } from "./config.js";
import { commands } from "./commands/commands.js";

async function main() {
  const { token, guildId, clientId } = await readConfig();
  const rest = new REST({ version: "10" }).setToken(token);

  const body: RESTPutAPIApplicationGuildCommandsJSONBody = commands.map(
    (command) => command.command
  );

  const data: RESTPutAPIApplicationGuildCommandsResult = (await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body }
  )) as any;

  console.log(`Successfully reloaded ${data.length} application (/) commands.`);
}

main();
