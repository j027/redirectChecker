import {promises as fs} from "fs";

type Config = {
    token: string;
    guildId: string;
    clientId: string;
    proxy: string;
    channelId: string;
    netcraftReportEmail: string;
    urlscanApiKey: string;
    crdfLabsApiKey: string;
    virusTotalApiKey: string;
    microsoftUsername: string;
    microsoftPassword: string;
    kasperskyApiKey: string;
    metaDefenderApiKey: string;
    checkPhishApiKey: string;
    hybridAnalysisApiKey: string;
};

export async function readConfig(): Promise<Config> {
    return JSON.parse(await fs.readFile("./config.json", {encoding: "utf-8"}));
}
