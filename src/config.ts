import {promises as fs} from "fs";

type Config = {
    token: string;
    guildId: string;
    clientId: string;
};

export async function readConfig(): Promise<Config> {
    return JSON.parse(await fs.readFile("./config.json", {encoding: "utf-8"}));
}
