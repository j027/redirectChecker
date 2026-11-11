import "dotenv/config";
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

export type DecisionModelMode = "advisory" | "signal";

export interface DecisionModelConfig {
  enabled: boolean;
  mode: DecisionModelMode;
  model: string;
  strongThreshold: number;
  reviewThreshold: number;
  negativeThreshold?: number;
  timeoutMs: number;
  maxRetries?: number;
  maxImageSide?: number;
  auditDailyLimit?: number;
  auditSampleRate?: number;
}

export type Config = {
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
  /** OpenRouter key used by the advisory decision model. */
  openRouterApiKey?: string;
  /** Optional advisory decision-model settings. */
  decisionModel?: DecisionModelConfig;
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

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Replaces ${ENV_VAR} references in config.json with values from the
 * environment. dotenv loads .env at import time, so local runs and the
 * bind-mounted Docker container both resolve the same way.
 */
function resolveEnvRefs(value: unknown, path = "config"): unknown {
  if (typeof value === "string") {
    if (!value.includes("${")) {
      return value;
    }

    return value.replace(ENV_REF, (_match, name: string) => {
      const resolved = process.env[name];
      if (resolved === undefined) {
        throw new Error(
          `Missing environment variable "${name}" referenced at ${path}`
        );
      }
      return resolved;
    });
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      resolveEnvRefs(item, `${path}[${index}]`)
    );
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        resolveEnvRefs(item, `${path}.${key}`),
      ])
    );
  }

  return value;
}

export async function readConfig(): Promise<Config> {
  const parsed = JSON.parse(
    await fs.readFile("./config.json", { encoding: "utf-8" })
  );
  const config = resolveEnvRefs(parsed) as Config;

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

  const decisionModel = config.decisionModel;
  if (decisionModel?.enabled) {
    if (
      typeof config.openRouterApiKey !== "string" ||
      config.openRouterApiKey.trim() === ""
    ) {
      throw new Error(
        'config.json has decisionModel.enabled but "openRouterApiKey" is missing. ' +
          "Set it to ${OPENROUTER_API_KEY} and define the env var."
      );
    }
    if (typeof decisionModel.model !== "string" || decisionModel.model.trim() === "") {
      throw new Error(
        'config.json has decisionModel.enabled but "decisionModel.model" is missing.'
      );
    }
    if (
      typeof decisionModel.strongThreshold !== "number" ||
      typeof decisionModel.reviewThreshold !== "number" ||
      decisionModel.strongThreshold <= decisionModel.reviewThreshold
    ) {
      throw new Error(
        "config.json decisionModel thresholds must be numbers and strongThreshold " +
          "must be greater than reviewThreshold."
      );
    }
    if (
      decisionModel.negativeThreshold !== undefined &&
      (typeof decisionModel.negativeThreshold !== "number" ||
        decisionModel.negativeThreshold >= decisionModel.reviewThreshold)
    ) {
      throw new Error(
        "config.json decisionModel.negativeThreshold must be a number below reviewThreshold."
      );
    }
    if (decisionModel.mode !== "advisory" && decisionModel.mode !== "signal") {
      throw new Error('config.json decisionModel.mode must be "advisory" or "signal".');
    }
    if (typeof decisionModel.timeoutMs !== "number" || decisionModel.timeoutMs <= 0) {
      throw new Error("config.json decisionModel.timeoutMs must be a positive number.");
    }
    if (
      decisionModel.maxRetries !== undefined &&
      (!Number.isInteger(decisionModel.maxRetries) || decisionModel.maxRetries < 0)
    ) {
      throw new Error("config.json decisionModel.maxRetries must be a non-negative integer.");
    }
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
