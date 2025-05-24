import {promises as fs} from "fs";

type Config = {
  token: string;
  guildId: string;
  clientId: string;
  proxy: string;
  hunterProxy: string;
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
  googleSafeBrowsingApiKey: string;
  cloudflareUrlScannerApiKey: string;
  cloudflareAccountId: string;
  /*
   *  The name of the project that is making the web risk api submission. This
   *  string is in the format "projects/{project_number}".
   *  Only needed if you are reporting to the web risk api (need special permission for this)
   */
  googleWebRiskApiProjectName: string;
};

export async function readConfig(): Promise<Config> {
    return JSON.parse(await fs.readFile("./config.json", {encoding: "utf-8"}));
}
