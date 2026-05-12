import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  buildTrainingDataFingerprint,
  decideTrainingDataSave,
  TrainingDataDedupeConfig,
} from "../../src/utils/trainingDataDedupe.js";

const config: TrainingDataDedupeConfig = {
  htmlTlshDistanceThreshold: 35,
  imageDhashDistanceThreshold: 10,
  maxImagesPerHtmlCluster: 100,
  includeTlshLengthDiff: true,
};

describe("trainingDataDedupe", () => {
  it("skips exact content duplicates", async () => {
    const fingerprint = await buildTrainingDataFingerprint(
      makeHtml("alpha"),
      await makeImageBuffer(10)
    );

    const decision = decideTrainingDataSave(
      fingerprint,
      [
        {
          uuid: "existing-exact",
          htmlSha256: fingerprint.htmlSha256,
          htmlTlsh: fingerprint.htmlTlsh,
          imageSha256: "different-image",
          imageDhash: "ffffffffffffffff",
        },
      ],
      config
    );

    expect(decision).toEqual({
      shouldSave: false,
      reason: "exact content duplicate",
      matchedUuid: "existing-exact",
    });
  });

  it("skips near-duplicate screenshots inside the same HTML cluster", async () => {
    const fingerprint = await buildTrainingDataFingerprint(
      makeHtml("clustered-template"),
      await makeImageBuffer(20)
    );

    const decision = decideTrainingDataSave(
      fingerprint,
      [
        {
          uuid: "existing-cluster",
          htmlSha256: "different-html",
          htmlTlsh: fingerprint.htmlTlsh,
          imageSha256: "different-image",
          imageDhash: fingerprint.imageDhash,
        },
      ],
      config
    );

    expect(decision).toEqual({
      shouldSave: false,
      reason: "near-duplicate screenshot in HTML cluster",
      matchedUuid: "existing-cluster",
      clusterSize: 1,
    });
  });

  it("keeps novel HTML even when the screenshot hash matches", async () => {
    const fingerprint = await buildTrainingDataFingerprint(
      makeHtml("novel-template"),
      await makeImageBuffer(30)
    );
    const existing = await buildTrainingDataFingerprint(
      makeHtml("different-template-family"),
      await makeImageBuffer(30)
    );

    const decision = decideTrainingDataSave(
      fingerprint,
      [
        {
          uuid: "same-image-different-html",
          htmlSha256: existing.htmlSha256,
          htmlTlsh: existing.htmlTlsh,
          imageSha256: "different-image-sha",
          imageDhash: fingerprint.imageDhash,
        },
      ],
      config
    );

    expect(decision).toEqual({ shouldSave: true });
  });

  it("skips new variants when an HTML cluster already has 100 kept screenshots", async () => {
    const fingerprint = await buildTrainingDataFingerprint(
      makeHtml("cluster-limit-template"),
      await makeImageBuffer(40)
    );

    const existingCluster = Array.from({ length: 100 }, (_, index) => ({
      uuid: `cluster-${index}`,
      htmlSha256: `html-${index}`,
      htmlTlsh: fingerprint.htmlTlsh,
      imageSha256: `image-${index}`,
      imageDhash: BigInt(index + 1).toString(16).padStart(16, "0"),
    }));

    const decision = decideTrainingDataSave(
      {
        ...fingerprint,
        imageDhash: "8000000000000000",
      },
      existingCluster,
      {
        ...config,
        imageDhashDistanceThreshold: 0,
      }
    );

    expect(decision).toEqual({
      shouldSave: false,
      reason: "HTML cluster already has the maximum number of screenshot variants",
      matchedUuid: "cluster-0",
      clusterSize: 100,
    });
  });
});

function makeHtml(templateName: string): string {
  const repeatedBody = Array.from({ length: 180 }, (_, index) => {
    return `<div class="${templateName}">support warning ${templateName} ${index} ${(index * 17) % 23} ${index % 7}</div>`;
  }).join("");

  return `<!doctype html><html><body>${repeatedBody}</body></html>`;
}

async function makeImageBuffer(seed: number): Promise<Buffer> {
  const width = 32;
  const height = 32;
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      pixels[offset] = (x * 7 + seed) % 256;
      pixels[offset + 1] = (y * 11 + seed * 3) % 256;
      pixels[offset + 2] = ((x + y) * 13 + seed * 5) % 256;
    }
  }

  return sharp(pixels, { raw: { width, height, channels } }).png().toBuffer();
}