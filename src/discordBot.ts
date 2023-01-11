
import { Client, Events, GatewayIntentBits } from "discord.js";
import { readConfig } from "./config";
import { commands } from "./commands/commands";

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const { token } = await readConfig();

  // Log in to Discord with your client's token
  await client.login(token);

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.find(
      (it) => it.command.name === interaction.commandName
    );

    if (!command) {
      console.error(
        `No command matching ${interaction.commandName} was found.`
      );
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      await interaction.reply({
        content: "There was an error while executing this command!",
        ephemeral: false,
      });
    }
  });
}

main();
