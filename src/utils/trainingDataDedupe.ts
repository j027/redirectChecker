import crypto from "crypto";
import { createRequire } from "module";
import sharp from "sharp";
import { readConfig } from "../config.js";

const require = createRequire(import.meta.url);
const tlshHash = require("tlsh") as (input: string) => string;

type TlshDigest = {
  calculateDifference(other: TlshDigest, includeLengthDiff: boolean): number;
};

type DigestHashBuilderInstance = {
  withHash(hash: string): DigestHashBuilderInstance;
  build(): TlshDigest;
};

type DigestHashBuilderConstructor = new () => DigestHashBuilderInstance;

const DigestHashBuilder = require("tlsh/lib/digests/digest-hash-builder") as DigestHashBuilderConstructor;

export type TrainingDataDedupeConfig = {
  htmlTlshDistanceThreshold: number;
  imageDhashDistanceThreshold: number;
  maxImagesPerHtmlCluster: number;
  includeTlshLengthDiff: boolean;
};

export type TrainingDataFingerprint = {
  htmlSha256: string;
  htmlTlsh: string | null;
  imageSha256: string;
  imageDhash: string;
};

export type ExistingTrainingFingerprint = {
  uuid: string;
  htmlSha256: string | null;
  htmlTlsh: string | null;
  imageSha256: string | null;
  imageDhash: string | null;
};

export type TrainingDataSaveDecision = {
  shouldSave: boolean;
  reason?: string;
  matchedUuid?: string;
  clusterSize?: number;
};

const DEFAULT_CONFIG: TrainingDataDedupeConfig = {
  htmlTlshDistanceThreshold: 35,
  imageDhashDistanceThreshold: 10,
  maxImagesPerHtmlCluster: 100,
  includeTlshLengthDiff: true,
};

type ConfigWithTrainingDataDedupe = Awaited<ReturnType<typeof readConfig>> & {
  trainingDataDedupe?: Partial<TrainingDataDedupeConfig>;
};

export async function readTrainingDataDedupeConfig(): Promise<TrainingDataDedupeConfig> {
  try {
    const config = await readConfig() as ConfigWithTrainingDataDedupe;
    return {
      ...DEFAULT_CONFIG,
      ...config.trainingDataDedupe,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function buildTrainingDataFingerprint(
  html: string,
  screenshot: Buffer
): Promise<TrainingDataFingerprint> {
  return {
    htmlSha256: calculateSha256Hex(html),
    htmlTlsh: calculateHtmlTlsh(html),
    imageSha256: calculateSha256Hex(screenshot),
    imageDhash: await calculateImageDhashHex(screenshot),
  };
}

export function calculateHtmlTlsh(html: string): string | null {
  if (html.length < 512) {
    return null;
  }

  try {
    return tlshHash(html);
  } catch {
    return null;
  }
}

export function calculateTlshDistance(
  leftHash: string,
  rightHash: string,
  includeLengthDiff: boolean
): number {
  const leftDigest = new DigestHashBuilder().withHash(leftHash).build();
  const rightDigest = new DigestHashBuilder().withHash(rightHash).build();
  return leftDigest.calculateDifference(rightDigest, includeLengthDiff);
}

export async function calculateImageDhashHex(imageBuffer: Buffer): Promise<string> {
  const pixels = await sharp(imageBuffer)
    .grayscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();

  let hash = 0n;

  for (let row = 0; row < 8; row++) {
    for (let column = 0; column < 8; column++) {
      const leftPixel = pixels[row * 9 + column];
      const rightPixel = pixels[row * 9 + column + 1];
      hash = (hash << 1n) | (leftPixel < rightPixel ? 1n : 0n);
    }
  }

  return hash.toString(16).padStart(16, "0");
}

export function calculateHexHammingDistance(leftHex: string, rightHex: string): number {
  let xor = BigInt(`0x${leftHex}`) ^ BigInt(`0x${rightHex}`);
  let distance = 0;

  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }

  return distance;
}

export function decideTrainingDataSave(
  fingerprint: TrainingDataFingerprint,
  existingFingerprints: ExistingTrainingFingerprint[],
  config: TrainingDataDedupeConfig
): TrainingDataSaveDecision {
  const exactMatch = existingFingerprints.find(
    ({ htmlSha256, imageSha256 }) =>
      htmlSha256 === fingerprint.htmlSha256 || imageSha256 === fingerprint.imageSha256
  );

  if (exactMatch) {
    return {
      shouldSave: false,
      reason: "exact content duplicate",
      matchedUuid: exactMatch.uuid,
    };
  }

  if (fingerprint.htmlTlsh) {
    const htmlCluster = existingFingerprints.filter(({ htmlTlsh }) => {
      if (!htmlTlsh) {
        return false;
      }

      return (
        calculateTlshDistance(
          fingerprint.htmlTlsh!,
          htmlTlsh,
          config.includeTlshLengthDiff
        ) <= config.htmlTlshDistanceThreshold
      );
    });

    if (htmlCluster.length === 0) {
      return { shouldSave: true };
    }

    const similarImage = htmlCluster.find(({ imageDhash }) => {
      if (!imageDhash) {
        return false;
      }

      return (
        calculateHexHammingDistance(fingerprint.imageDhash, imageDhash) <=
        config.imageDhashDistanceThreshold
      );
    });

    if (similarImage) {
      return {
        shouldSave: false,
        reason: "near-duplicate screenshot in HTML cluster",
        matchedUuid: similarImage.uuid,
        clusterSize: htmlCluster.length,
      };
    }

    if (htmlCluster.length >= config.maxImagesPerHtmlCluster) {
      return {
        shouldSave: false,
        reason: "HTML cluster already has the maximum number of screenshot variants",
        matchedUuid: htmlCluster[0]?.uuid,
        clusterSize: htmlCluster.length,
      };
    }

    return { shouldSave: true };
  }

  const similarImage = existingFingerprints.find(({ imageDhash }) => {
    if (!imageDhash) {
      return false;
    }

    return (
      calculateHexHammingDistance(fingerprint.imageDhash, imageDhash) <=
      config.imageDhashDistanceThreshold
    );
  });

  if (similarImage) {
    return {
      shouldSave: false,
      reason: "near-duplicate screenshot",
      matchedUuid: similarImage.uuid,
    };
  }

  return { shouldSave: true };
}

function calculateSha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}
