import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import pool from "../dbPool.js";
import {
  Config,
  DecisionModelConfig,
  readConfig,
} from "../config.js";

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const DECISION_MODEL_PROMPT_VERSION = "target-v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;

export const DECISION_MODEL_QUESTION = {
  is_target: {
    type: "noul",
    instructions:
      "Is this a Microsoft/Windows or Apple tech-support scareware page? Judge the page content, not the browser URL bar, tabs, or bookmarks.",
    criteria: {
      true:
        "The main content impersonates Microsoft/Windows or Apple and uses a security/virus scare, fake scan, device-locked warning, urgent error, or 'call support' tech-support scam pattern. A visible phone number is a strong indicator but is not required; cropped or partial screenshots still count if the scareware/tech-support scam pattern is clear.",
      false:
        "The page is not a Microsoft/Apple tech-support scareware page. This includes McAfee-branded pages even if they look like tech-support scams, other brands' tech-support scams, other scam types, legitimate Microsoft/Apple settings or support pages, phishing/login pages, and pages with no scareware or tech-support scam element.",
    },
  },
} as const;

export interface DecisionModelResult {
  targetProbability: number | null;
  threshold: number;
  isTarget: boolean | null;
  model: string;
  provider?: string;
  promptVersion: string;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: number;
  error?: string;
  cached?: boolean;
}

export interface DecisionModelAuditInput {
  screenshot: Buffer;
  screenshotHash: string;
  url: string;
  sourceType?: string;
  sourceId?: string;
  adId?: string;
  redirectDestinationId?: number;
  onnxIsScam: boolean;
  onnxEffectiveIsScam?: boolean;
  onnxConfidence: number;
  result: DecisionModelResult;
}

export interface AuditDecision {
  reason: string | null;
  verdictDiff: boolean;
}

type CachedResult = {
  expiresAt: number;
  result: DecisionModelResult;
};

type DecisionThresholds = Pick<
  DecisionModelConfig,
  "strongThreshold" | "reviewThreshold" | "negativeThreshold" | "auditSampleRate"
>;

function sha256(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function getAuditDecision(
  targetProbability: number | null,
  onnxEffectiveIsScam: boolean,
  thresholds: DecisionThresholds,
  randomValue: number = Math.random()
): AuditDecision {
  if (targetProbability == null) {
    return { reason: null, verdictDiff: false };
  }

  const negativeThreshold = thresholds.negativeThreshold ?? 0.1;
  const strong = targetProbability >= thresholds.strongThreshold;
  const negative = targetProbability <= negativeThreshold;
  const uncertain =
    targetProbability >= thresholds.reviewThreshold &&
    targetProbability < thresholds.strongThreshold;

  const verdictDiff =
    (strong && !onnxEffectiveIsScam) || (negative && onnxEffectiveIsScam);

  let reason: string | null = null;
  if (strong && !onnxEffectiveIsScam) {
    reason = "drex_rescue";
  } else if (negative && onnxEffectiveIsScam) {
    reason = "drex_veto";
  } else if (uncertain) {
    reason = "drex_uncertain";
  } else if (randomValue < (thresholds.auditSampleRate ?? 0)) {
    reason = "random_audit";
  }

  return { reason, verdictDiff };
}

export class DecisionModelService {
  private configPromise: Promise<Config> | null = null;
  private cache = new Map<string, CachedResult>();

  private getConfig(): Promise<Config> {
    if (!this.configPromise) {
      this.configPromise = readConfig();
    }
    return this.configPromise;
  }

  public async classifyTarget(screenshot: Buffer): Promise<DecisionModelResult | null> {
    let config: Config;
    try {
      config = await this.getConfig();
    } catch (error) {
      console.error("[DecisionModel] Could not read config:", error);
      return null;
    }

    const settings = config.decisionModel;
    if (!settings?.enabled) {
      return null;
    }

    const apiKey = config.openRouterApiKey;
    if (!apiKey) {
      console.error("[DecisionModel] openRouterApiKey is missing");
      return null;
    }

    const hash = sha256(screenshot);
    const cacheKey = `${hash}:${settings.model}:${DECISION_MODEL_PROMPT_VERSION}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return { ...cached.result, cached: true };
    }

    const startedAt = Date.now();
    try {
      const prepared = await this.prepareImage(screenshot);
      const body = {
        model: settings.model,
        state: [
          "Screenshot of a web page or popup captured from a browser.",
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${prepared.jpeg.toString("base64")}`,
            },
          },
        ],
        questions: DECISION_MODEL_QUESTION,
      };

      const maxRetries = settings.maxRetries ?? 2;
      let text = "";
      let status = 0;
      let ok = false;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const response = await fetch(OPENROUTER_DECISIONS_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(settings.timeoutMs),
        });

        status = response.status;
        text = await response.text();
        ok = response.ok;

        if (ok) {
          break;
        }

        const retryable = status === 429 || status >= 500;
        if (retryable && attempt < maxRetries) {
          const delayMs = 1000 * 2 ** attempt;
          console.warn(
            `[DecisionModel] HTTP ${status}; retrying in ${delayMs}ms ` +
              `(${attempt + 1}/${maxRetries})`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        break;
      }

      if (!ok) {
        throw new Error(`HTTP ${status}: ${text.slice(0, 500)}`);
      }

      const data = JSON.parse(text) as {
        model?: string;
        provider?: string;
        answers?: { is_target?: { noul?: number } };
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cost?: number;
        };
      };

      const probability = data.answers?.is_target?.noul;
      if (typeof probability !== "number" || !Number.isFinite(probability)) {
        throw new Error("response did not contain a numeric is_target.noul");
      }

      const result: DecisionModelResult = {
        targetProbability: probability,
        threshold: settings.strongThreshold,
        isTarget: probability >= settings.strongThreshold,
        model: data.model ?? settings.model,
        provider: data.provider,
        promptVersion: DECISION_MODEL_PROMPT_VERSION,
        latencyMs: Date.now() - startedAt,
        inputTokens: data.usage?.input_tokens,
        outputTokens: data.usage?.output_tokens,
        cost: data.usage?.cost,
        cached: false,
      };

      this.remember(cacheKey, result);
      return result;
    } catch (error) {
      const result: DecisionModelResult = {
        targetProbability: null,
        threshold: settings.strongThreshold,
        isTarget: null,
        model: settings.model,
        promptVersion: DECISION_MODEL_PROMPT_VERSION,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        cached: false,
      };
      console.warn(`[DecisionModel] Classification failed: ${result.error}`);
      return result;
    }
  }

  public async recordAudit(input: DecisionModelAuditInput): Promise<void> {
    let config: Config;
    try {
      config = await this.getConfig();
    } catch (error) {
      console.error("[DecisionModel] Could not read config for audit:", error);
      return;
    }

    const settings = config.decisionModel;
    if (!settings?.enabled) {
      return;
    }

    try {
      const probability = input.result.targetProbability;
      const onnxEffectiveIsScam =
        input.onnxEffectiveIsScam ?? input.onnxIsScam;
      const decision = getAuditDecision(
        probability,
        onnxEffectiveIsScam,
        settings
      );
      const shouldStoreImage =
        decision.reason != null &&
        (await this.underDailyAuditLimit(settings.auditDailyLimit ?? 100));

      let imageId: string | null = null;
      if (shouldStoreImage) {
        imageId = await this.storeImage(input.screenshot, input.screenshotHash);
      }

      await pool.query(
        `INSERT INTO decision_model_checks (
           image_id, screenshot_hash, source_type, source_id, source_url,
           ad_id, redirect_destination_id,
           onnx_is_scam, onnx_effective_is_scam, onnx_confidence, onnx_verdict,
           decision_model_target_probability, decision_model_threshold,
           decision_model_is_target, decision_model_model,
           decision_model_prompt_version, decision_model_latency_ms,
           decision_model_cost, decision_model_error,
           verdict_diff, review_reason
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7,
           $8, $9, $10, $11,
           $12, $13,
           $14, $15,
           $16, $17,
           $18, $19,
           $20, $21
         )`,
        [
          imageId,
          input.screenshotHash,
          input.sourceType ?? "classifier",
          input.sourceId ?? null,
          input.url,
          input.adId ?? null,
          input.redirectDestinationId ?? null,
          input.onnxIsScam,
          onnxEffectiveIsScam,
          input.onnxConfidence,
          input.onnxIsScam ? "scam" : "non_scam",
          probability,
          input.result.threshold,
          input.result.isTarget,
          input.result.model,
          input.result.promptVersion,
          input.result.latencyMs,
          input.result.cost ?? null,
          input.result.error ?? null,
          decision.verdictDiff,
          decision.reason,
        ]
      );

      await this.updateSummary(input, settings);
    } catch (error) {
      console.error("[DecisionModel] Could not record audit:", error);
    }
  }

  public async updateRedirectDestinationSummary(
    redirectDestinationId: number,
    result: DecisionModelResult | null
  ): Promise<void> {
    if (!result) {
      return;
    }
    try {
      await pool.query(
        `UPDATE redirect_destinations SET
           decision_model_target_probability = $2,
           decision_model_is_target = $3,
           decision_model_threshold = $4,
           decision_model_model = $5,
           decision_model_prompt_version = $6,
           decision_model_latency_ms = $7,
           decision_model_cost = $8,
           decision_model_error = $9,
           decision_model_checked_at = NOW()
         WHERE id = $1`,
        [
          redirectDestinationId,
          result.targetProbability,
          result.isTarget,
          result.threshold,
          result.model,
          result.promptVersion,
          result.latencyMs,
          result.cost ?? null,
          result.error ?? null,
        ]
      );
    } catch (error) {
      console.error(
        "[DecisionModel] Could not update redirect destination summary:",
        error
      );
    }
  }

  private async updateSummary(
    input: DecisionModelAuditInput,
    settings: DecisionModelConfig
  ): Promise<void> {
    const values = [
      input.result.targetProbability,
      input.result.isTarget,
      input.result.threshold,
      input.result.model,
      input.result.promptVersion,
      input.result.latencyMs,
      input.result.cost ?? null,
      input.result.error ?? null,
    ];

    if (input.redirectDestinationId != null) {
      await pool.query(
        `UPDATE redirect_destinations SET
           decision_model_target_probability = $2,
           decision_model_is_target = $3,
           decision_model_threshold = $4,
           decision_model_model = $5,
           decision_model_prompt_version = $6,
           decision_model_latency_ms = $7,
           decision_model_cost = $8,
           decision_model_error = $9,
           decision_model_checked_at = NOW()
         WHERE id = $1`,
        [input.redirectDestinationId, ...values]
      );
    }

    if (input.adId != null) {
      await pool.query(
        `UPDATE ads SET
           decision_model_target_probability = $2,
           decision_model_is_target = $3,
           decision_model_threshold = $4,
           decision_model_model = $5,
           decision_model_prompt_version = $6,
           decision_model_latency_ms = $7,
           decision_model_cost = $8,
           decision_model_error = $9,
           decision_model_checked_at = NOW()
         WHERE id = $1`,
        [input.adId, ...values]
      );
    }

    // Keep the setting referenced so future policy changes have an obvious
    // place to use it without changing the call signature.
    void settings;
  }

  private async underDailyAuditLimit(limit: number): Promise<boolean> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM decision_model_checks
       WHERE review_reason IS NOT NULL
         AND created_at >= CURRENT_DATE`
    );
    return Number(result.rows[0]?.count ?? 0) < limit;
  }

  private async storeImage(
    screenshot: Buffer,
    screenshotHash: string
  ): Promise<string> {
    const prepared = await this.prepareImage(screenshot);
    const directory = path.join(
      process.cwd(),
      "data",
      "screenshots",
      "decision_model"
    );
    await fs.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${screenshotHash}.jpg`);

    try {
      await fs.access(filePath);
    } catch {
      await fs.writeFile(filePath, prepared.jpeg);
    }

    const result = await pool.query<{ id: string }>(
      `INSERT INTO decision_model_images (
         screenshot_hash, screenshot_path, image_width, image_height
       ) VALUES ($1, $2, $3, $4)
       ON CONFLICT (screenshot_hash) DO UPDATE SET
         last_seen = NOW(),
         occurrence_count = decision_model_images.occurrence_count + 1
       RETURNING id`,
      [screenshotHash, filePath, prepared.width, prepared.height]
    );

    return result.rows[0]?.id ?? "";
  }

  private async prepareImage(
    screenshot: Buffer
  ): Promise<{ jpeg: Buffer; width: number; height: number }> {
    const config = await this.getConfig();
    const maxSide = config.decisionModel?.maxImageSide ?? 1568;
    const { data, info } = await sharp(screenshot)
      .rotate()
      .resize({
        width: maxSide,
        height: maxSide,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 90 })
      .toBuffer({ resolveWithObject: true });

    return { jpeg: data, width: info.width, height: info.height };
  }

  private remember(cacheKey: string, result: DecisionModelResult): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(cacheKey, {
      expiresAt: Date.now() + CACHE_TTL_MS,
      result,
    });
  }
}

export function hashScreenshot(screenshot: Buffer): string {
  return sha256(screenshot);
}

export const decisionModelService = new DecisionModelService();
