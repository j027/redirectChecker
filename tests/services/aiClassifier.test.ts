import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { AiClassifierService } from "../../src/services/aiClassifierService.js";

describe("Test AI Classifier on various websites", () => {
  let service: AiClassifierService;

  beforeAll(async () => {
    service = new AiClassifierService();
    await service.init();
  });

  afterAll(async () => {
    await service.close();
  });

  it("should correctly classify non-scam website", async () => {
    // legitimate website that an actual scam redirect has gone to
    const url = "https://www.nordic.com/omega-3s/";

    const result = await service.classifyUrl(url);

    if (result == null) {
      throw new Error("Failed to classify url");
    }

    expect(result.isScam).toBe(false);
  });
});
