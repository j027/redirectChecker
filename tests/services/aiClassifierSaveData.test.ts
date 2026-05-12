import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("fs", () => ({
  promises: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(JSON.stringify({ domains: [] })),
  },
}));

vi.mock("../../src/dbPool.js", () => ({
  default: {
    connect: vi.fn(),
  },
}));

vi.mock("../../src/utils/trainingDataDedupe.js", () => ({
  buildTrainingDataFingerprint: vi.fn(),
  decideTrainingDataSave: vi.fn(),
  readTrainingDataDedupeConfig: vi.fn().mockResolvedValue({
    htmlTlshDistanceThreshold: 35,
    imageDhashDistanceThreshold: 10,
    maxImagesPerHtmlCluster: 100,
    includeTlshLengthDiff: true,
  }),
}));

import { promises as fs } from "fs";
import pool from "../../src/dbPool.js";
import { AiClassifierService } from "../../src/services/aiClassifierService.js";
import {
  buildTrainingDataFingerprint,
  decideTrainingDataSave,
} from "../../src/utils/trainingDataDedupe.js";

const mockFsMkdir = vi.mocked(fs.mkdir);
const mockFsWriteFile = vi.mocked(fs.writeFile);
const mockPoolConnect = vi.mocked(pool.connect);
const mockBuildTrainingDataFingerprint = vi.mocked(buildTrainingDataFingerprint);
const mockDecideTrainingDataSave = vi.mocked(decideTrainingDataSave);

describe("AiClassifierService.saveData", () => {
  const client = {
    query: vi.fn(),
    release: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPoolConnect.mockResolvedValue(client as any);
    mockBuildTrainingDataFingerprint.mockResolvedValue({
      htmlSha256: "html-sha",
      htmlTlsh: "T1HASH",
      imageSha256: "image-sha",
      imageDhash: "0f0f0f0f0f0f0f0f",
    });
    mockDecideTrainingDataSave.mockReturnValue({ shouldSave: true });
    client.query.mockReset();
    client.release.mockReset();
  });

  it("writes hashes into the training dataset when the sample is kept", async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const service = new AiClassifierService();

    await service.saveData(
      "https://example.test/path",
      Buffer.from("screenshot"),
      "<html>content</html>",
      true,
      0.5
    );

    expect(client.query).toHaveBeenNthCalledWith(
      1,
      "SELECT 1 FROM url_training_dataset WHERE url = $1",
      ["https://example.test/path"]
    );
    expect(client.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SELECT uuid, html_sha256, html_tlsh, image_sha256, image_dhash"),
      [true]
    );
    expect(client.query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO url_training_dataset"),
      [
        expect.any(String),
        "https://example.test/path",
        true,
        0.5,
        "html-sha",
        "T1HASH",
        "image-sha",
        "0f0f0f0f0f0f0f0f",
        1,
      ]
    );
    expect(mockFsMkdir).toHaveBeenCalledTimes(2);
    expect(mockFsWriteFile).toHaveBeenCalledTimes(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("skips inserts and file writes when dedupe rejects the sample", async () => {
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ uuid: "existing" }] });
    mockDecideTrainingDataSave.mockReturnValue({
      shouldSave: false,
      reason: "exact content duplicate",
      matchedUuid: "existing",
    });

    const service = new AiClassifierService();

    await service.saveData(
      "https://example.test/path",
      Buffer.from("screenshot"),
      "<html>content</html>",
      true,
      0.5
    );

    expect(client.query).toHaveBeenCalledTimes(2);
    expect(mockFsMkdir).not.toHaveBeenCalled();
    expect(mockFsWriteFile).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("returns early before touching the database for confident predictions", async () => {
    const service = new AiClassifierService();

    await service.saveData(
      "https://example.test/path",
      Buffer.from("screenshot"),
      "<html>content</html>",
      true,
      0.95
    );

    expect(mockPoolConnect).not.toHaveBeenCalled();
    expect(mockBuildTrainingDataFingerprint).not.toHaveBeenCalled();
    expect(mockDecideTrainingDataSave).not.toHaveBeenCalled();
  });
});