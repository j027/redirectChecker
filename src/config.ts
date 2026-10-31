import {promises as fs} from "fs";

export const HUNTER_NAMES = [
  "search",
  "typosquat",
  "pornhub",
  "adspyglass",
  "adsense",
  "taboola",
] as const;

export type HunterName = (typeof HUNTER_NAMES)[number];

type Config = {
  token: string;
  guildId: string;
  clientId: string;
  proxy: string;
  hunterProxy: string;
  /**
   * Dedicated proxy for the AI classifier. Must be independent of the hunter
   * proxy so classifier runs can take as long as they need without blocking
   * hunter proxy rotation. Required: startup fails fast if missing.
   */
  classifierProxy: string;
  channelId: string;
  netcraftReportEmail: string;
  urlscanApiKey: string;
  crdfLabsApiKey: string;
  virusTotalApiKey: string;
  microsoftUsername: string;
  microsoftPassword: string;
  /** Yahoo Mail account used by the Taboola hunter. */
  yahooUsername: string;
  yahooPassword: string;
  /**
   * Base32 TOTP secret for the Yahoo account's authenticator-app 2-step
   * verification. Optional; only used when Yahoo asks for a code.
   */
  yahooTotpSecret?: string;
  /**
   * Advertiser domains to skip in the Taboola hunter without clicking.
   * Useful for known-good brands whose ads are unlikely to be scams.
   */
  taboolaSkipAdvertiserDomains?: string[];
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
  /**
   * Per-hunter enable flags for the ad hunter cycle. Absent hunters default
   * to enabled, so omitting this object preserves the original behavior.
   */
  hunters?: Partial<Record<HunterName, boolean>>;
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
  // Discourse reporting
  discourseBaseUrl?: string;
  discourseApiKey?: string;
  discourseApiUsername?: string;
  discourseTopicId?: number;
  discourseBypassHeader?: string;
};

export async function readConfig(): Promise<Config> {
  const config = JSON.parse(
    await fs.readFile("./config.json", { encoding: "utf-8" })
  ) as Config;

  // Fail fast: the classifier must never share the hunter proxy.
  if (
    typeof config.classifierProxy !== "string" ||
    config.classifierProxy.trim() === ""
  ) {
    throw new Error(
      'config.json is missing required "classifierProxy". ' +
        "Set it to the dedicated classifier proxy."
    );
  }

  if (
    isHunterEnabled(config, "taboola") &&
    (typeof config.yahooUsername !== "string" ||
      config.yahooUsername.trim() === "" ||
      typeof config.yahooPassword !== "string" ||
      config.yahooPassword === "")
  ) {
    throw new Error(
      'config.json is missing required "yahooUsername"/"yahooPassword". ' +
        "Set them or disable the taboola hunter."
    );
  }

  return config;
}

/**
 * Hunters that need an explicit opt-in. New hunters that require credentials
 * or otherwise change deployment behavior should be added here so existing
 * configs do not start them accidentally.
 */
const DEFAULT_DISABLED_HUNTERS = new Set<HunterName>(["taboola"]);

/** A hunter is enabled unless explicitly disabled in config. */
export function isHunterEnabled(config: Config, hunter: HunterName): boolean {
  return config.hunters?.[hunter] ?? !DEFAULT_DISABLED_HUNTERS.has(hunter);
}
