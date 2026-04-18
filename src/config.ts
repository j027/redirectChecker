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
  /** Enable the URLScan firehose hunter (default false if absent) */
  urlscanHunterEnabled?: boolean;
  /** URL to GET to trigger hunter proxy IP rotation (optional) */
  hunterProxyRotationUrl?: string;
  // MSRC abuse reporting
  msrcReporterName: string;
  msrcReporterEmail: string;
  msrcReporterOrg?: string;
  // XARF email reporting
  xarfReporterOrg: string;
  xarfReporterContact: string;
  xarfReporterDomain: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
};

export async function readConfig(): Promise<Config> {
    return JSON.parse(await fs.readFile("./config.json", {encoding: "utf-8"}));
}
