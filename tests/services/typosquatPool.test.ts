import { describe, expect, it } from "vitest";
import {
  classifyTyposquatTier,
  getTyposquatRunContext,
  normalizeTyposquatDomain,
  selectTyposquatFromPool,
  type TyposquatPoolEntry,
  type TyposquatPoolStats,
  type TyposquatTier,
} from "../../src/services/typosquatPoolService.js";

function stats(
  overrides: Partial<TyposquatPoolStats> = {}
): TyposquatPoolStats {
  return {
    offpeakRows: 20,
    distinctFinalParents: 25,
    distinctFinalHosts: 40,
    meanDistinctHosts: 5,
    maxFanIn: 10,
    pctShortPaths: 0.1,
    pctTrackerPaths: 0.05,
    recentScams: 0,
    recentErrors: 0,
    recentCycles: 0,
    lastSeen: null,
    ...overrides,
  };
}

function entry(
  domain: string,
  tier: TyposquatTier,
  overrides: Partial<TyposquatPoolStats> = {}
): TyposquatPoolEntry {
  return { domain, tier, stats: stats(overrides) };
}

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("typosquatPoolService", () => {
  it("normalizes domains from URLs and the JSON list", () => {
    expect(normalizeTyposquatDomain("http://www.Faceb00k.com/path?q=1")).toBe(
      "faceb00k.com"
    );
    expect(normalizeTyposquatDomain("https://gmajil.com")).toBe("gmajil.com");
    expect(normalizeTyposquatDomain("  GMAILK.COM  ")).toBe("gmailk.com");
  });

  it("classifies hot when a source produced a recent scam", () => {
    expect(classifyTyposquatTier(stats({ recentScams: 1 }))).toBe("hot");
    expect(
      classifyTyposquatTier(
        stats({ recentScams: 1, distinctFinalParents: 1, meanDistinctHosts: 1 })
      )
    ).toBe("hot");
  });

  it("classifies static single-destination sources as cold", () => {
    expect(
      classifyTyposquatTier(
        stats({ distinctFinalParents: 1, meanDistinctHosts: 1, offpeakRows: 1 })
      )
    ).toBe("cold");
    expect(
      classifyTyposquatTier(
        stats({ distinctFinalParents: 8, meanDistinctHosts: 1.5 })
      )
    ).toBe("cold");
  });

  it("classifies some rotation as low and broad rotation as normal", () => {
    expect(
      classifyTyposquatTier(
        stats({ distinctFinalParents: 5, meanDistinctHosts: 5 })
      )
    ).toBe("low");
    expect(
      classifyTyposquatTier(
        stats({ distinctFinalParents: 20, meanDistinctHosts: 5 })
      )
    ).toBe("normal");
  });

  it("uses unknown when there is not enough off-peak evidence", () => {
    expect(
      classifyTyposquatTier(
        stats({
          offpeakRows: 2,
          distinctFinalParents: 20,
          meanDistinctHosts: 5,
        })
      )
    ).toBe("unknown");
    expect(classifyTyposquatTier(null)).toBe("unknown");
  });

  it("detects the ET peak window and weekends", () => {
    expect(getTyposquatRunContext(new Date("2026-11-10T15:00:00Z"))).toEqual({
      isPeak: true,
      hourEt: 10,
      isodow: 2,
    });
    expect(getTyposquatRunContext(new Date("2026-11-10T02:00:00Z"))).toEqual({
      isPeak: false,
      hourEt: 21,
      isodow: 1,
    });
    expect(getTyposquatRunContext(new Date("2026-11-14T15:00:00Z"))).toEqual({
      isPeak: false,
      hourEt: 10,
      isodow: 6,
    });
  });

  it("returns null for an empty pool", () => {
    const context = getTyposquatRunContext(new Date("2026-11-10T15:00:00Z"));
    expect(selectTyposquatFromPool([], context, () => 0)).toBeNull();
  });

  it("prefers hot domains during peak hours", () => {
    const context = getTyposquatRunContext(new Date("2026-11-10T15:00:00Z"));
    const entries = [
      entry("hot.example", "hot"),
      entry("normal.example", "normal"),
      entry("cold.example", "cold"),
    ];

    const selected = selectTyposquatFromPool(entries, context, () => 0);
    expect(selected?.domain).toBe("hot.example");
    expect(selected?.tier).toBe("hot");
    expect(selected?.context.isPeak).toBe(true);
  });

  it("prefers cold/unknown domains off peak", () => {
    const context = getTyposquatRunContext(new Date("2026-11-10T02:00:00Z"));
    const entries = [
      entry("hot.example", "hot"),
      entry("cold.example", "cold"),
    ];

    const selected = selectTyposquatFromPool(entries, context, () => 0.99);
    expect(selected?.domain).toBe("cold.example");
    expect(selected?.tier).toBe("cold");
    expect(selected?.context.isPeak).toBe(false);
  });

  it("falls back to an available tier when preferred tiers are empty", () => {
    const context = getTyposquatRunContext(new Date("2026-11-10T15:00:00Z"));
    const entries = [entry("cold.example", "cold")];

    const selected = selectTyposquatFromPool(entries, context, () => 0.5);
    expect(selected?.domain).toBe("cold.example");
    expect(selected?.tier).toBe("cold");
  });

  it("removes persistently blocked domains from the peak rotation", () => {
    const context = getTyposquatRunContext(new Date("2026-11-10T15:00:00Z"));
    const blocked = entry("blocked.example", "cold", {
      recentErrors: 10,
      recentCycles: 10,
    });
    const healthy = entry("healthy.example", "cold", {
      recentErrors: 0,
      recentCycles: 10,
    });

    const random = lcg(42);
    for (let i = 0; i < 2000; i++) {
      const selected = selectTyposquatFromPool(
        [blocked, healthy],
        context,
        random
      );
      expect(selected?.domain).toBe("healthy.example");
    }
  });

  it("keeps a small off-hours retry for blocked domains", () => {
    const context = getTyposquatRunContext(new Date("2026-11-10T02:00:00Z"));
    const blocked = entry("blocked.example", "cold", {
      recentErrors: 10,
      recentCycles: 10,
    });
    const healthy = entry("healthy.example", "cold", {
      recentErrors: 0,
      recentCycles: 10,
    });

    const random = lcg(7);
    let blockedPicks = 0;
    for (let i = 0; i < 3000; i++) {
      const selected = selectTyposquatFromPool(
        [blocked, healthy],
        context,
        random
      );
      if (selected?.domain === "blocked.example") {
        blockedPicks++;
      }
    }

    // blocked weight 0.8 vs healthy 4 -> about 17%, not zero and not dominant.
    expect(blockedPicks).toBeGreaterThan(100);
    expect(blockedPicks).toBeLessThan(900);
  });
});
