import { describe, it, expect } from "vitest";
// hunterService must load first: it instantiates the hunters and the
// hunterService <-> adsenseHunter cycle deadlocks if the hunter loads first.
import "../../src/services/hunterService.js";
import {
  AdClickCandidate,
  rankAdCandidates,
  rankAdCandidatesOrdered,
} from "../../src/services/adsenseHunter.js";

function candidate(overrides: Partial<AdClickCandidate>): AdClickCandidate {
  return {
    text: "",
    href: null,
    area: 10000,
    hasImage: false,
    visible: true,
    ...overrides,
  };
}

describe("rankAdCandidates", () => {
  it("prefers CTA text over a larger image anchor", () => {
    const candidates = [
      candidate({ text: "truck photo", href: "https://scam.example/a", hasImage: true, area: 90000 }),
      candidate({ text: "C0ntinue to our site", href: "https://scam.example/landing", area: 5000 }),
    ];

    expect(rankAdCandidates(candidates)).toBe(1);
  });

  it("never picks AdChoices or privacy links", () => {
    const candidates = [
      candidate({ text: "i", href: "https://adssettings.google.com/whythisad", area: 196 }),
      candidate({ text: "AdChoices", href: "https://www.google.com/settings/ads", area: 5000 }),
      candidate({ text: "privacy", href: "https://admaster.cc/privacy", area: 5000 }),
    ];

    expect(rankAdCandidates(candidates)).toBeNull();
  });

  it("ignores tiny and invisible candidates", () => {
    const candidates = [
      candidate({ text: "Download", href: "https://scam.example/a", area: 100 }),
      candidate({ text: "Download", href: "https://scam.example/b", area: 40000, visible: false }),
    ];

    expect(rankAdCandidates(candidates)).toBeNull();
  });

  it("returns null when there are no candidates", () => {
    expect(rankAdCandidates([])).toBeNull();
  });
});

describe("rankAdCandidatesOrdered", () => {
  it("orders CTA links before larger non-CTA links", () => {
    const candidates = [
      candidate({ text: "truck photo", href: "https://scam.example/a", hasImage: true, area: 90000 }),
      candidate({ text: "Download now", href: "https://scam.example/b", area: 5000 }),
    ];

    expect(rankAdCandidatesOrdered(candidates)).toEqual([1, 0]);
  });
});
