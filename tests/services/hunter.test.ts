import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { HunterService } from "../../src/services/hunterService.js";

describe("Test the hunter service can operate successfully", () => {
  let service: HunterService;

  beforeAll(async () => {
    service = new HunterService();
    await service.init(false);
  });

  afterAll(async () => {
    await service.close();
  });

  it("work with search ads", async () => {
    const result = await service.huntSearchAds();

    expect(result).toBe(true);
  });

  it("work with pornhub ads", async () => {
    const result = await service.huntPornhubAds();

    expect(result).toBe(true);
  })

  it("work with adspyglass ads", async () => {
    const result = await service.huntAdSpyGlassAds();

    expect(result).toBe(true);
  });

  it("work with typosquat ads", async () => {
    const result = await service.huntTyposquat();

    expect(result).toBe(true);
  });
});
