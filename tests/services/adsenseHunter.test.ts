import { describe, it, expect } from "vitest";
// hunterService must load first: it instantiates the hunters and the
// hunterService <-> adsenseHunter cycle deadlocks if the hunter loads first.
import "../../src/services/hunterService.js";
import {
  AdClickCandidate,
  rankAdCandidates,
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

  it("prefers the largest CTA when several match", () => {
    const candidates = [
      candidate({ text: "Download", href: "https://scam.example/a", area: 2000 }),
      candidate({ text: "Continue to our site", href: "https://scam.example/b", area: 8000 }),
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

  it("picks an image-bearing anchor over a larger textless one", () => {
    const candidates = [
      candidate({ text: "", href: "https://scam.example/overlay", area: 120000 }),
      candidate({ text: "", href: "https://scam.example/banner", hasImage: true, area: 90000 }),
    ];

    expect(rankAdCandidates(candidates)).toBe(1);
  });

  it("falls back to the largest visible anchor when nothing has an image", () => {
    const candidates = [
      candidate({ text: "0", href: "https://scam.example/a", area: 3000 }),
      candidate({ text: "1", href: "https://scam.example/b", area: 4000 }),
    ];

    expect(rankAdCandidates(candidates)).toBe(1);
  });

  it("treats button creatives as candidates", () => {
    const candidates = [
      candidate({ text: "Download", href: null, area: 40000 }),
    ];

    expect(rankAdCandidates(candidates)).toBe(0);
  });

  it("ignores tiny and invisible candidates", () => {
    const candidates = [
      candidate({ text: "Download", href: null, area: 100 }),
      candidate({ text: "Download", href: null, area: 40000, visible: false }),
    ];

    expect(rankAdCandidates(candidates)).toBeNull();
  });

  it("returns null when there are no candidates", () => {
    expect(rankAdCandidates([])).toBeNull();
  });
});
