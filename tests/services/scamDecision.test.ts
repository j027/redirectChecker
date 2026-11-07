import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_THRESHOLD,
  SIGNAL_BACKED_CONFIDENCE_THRESHOLD,
  countActiveSignals,
  decideScam,
  hasStrongScamSignals,
} from "../../src/services/scamDecision.js";
import { createEmptySignals, DetectedSignals } from "../../src/services/signalService.js";

function signals(overrides: Partial<DetectedSignals>): DetectedSignals {
  return { ...createEmptySignals(), ...overrides };
}

describe("decideScam", () => {
  it("keeps the high-confidence classifier path", () => {
    const decision = decideScam(
      true,
      CONFIDENCE_THRESHOLD,
      signals({ fullscreenRequested: true })
    );

    expect(decision.isScam).toBe(true);
    expect(decision.reason).toBe("classifier");
  });

  it("does not trust a high-confidence classifier without a signal", () => {
    const decision = decideScam(true, 0.997, createEmptySignals());

    expect(decision.isScam).toBe(false);
    expect(decision.reason).toBeNull();
  });

  it("promotes the ironwave-style low-confidence tech-support scam", () => {
    const decision = decideScam(
      true,
      0.559,
      signals({
        fullscreenRequested: true,
        keyboardLockRequested: true,
        isThirdPartyHosting: true,
      })
    );

    expect(decision.isScam).toBe(true);
    expect(decision.reason).toBe("signal_override");
    expect(decision.hasStrongSignals).toBe(true);
  });

  it("does not promote hosting-only pages", () => {
    const decision = decideScam(
      true,
      0.60,
      signals({ isThirdPartyHosting: true })
    );

    expect(decision.isScam).toBe(false);
  });

  it("does not promote active behavior without suspicious hosting", () => {
    const decision = decideScam(
      true,
      0.60,
      signals({ fullscreenRequested: true, keyboardLockRequested: true })
    );

    expect(decision.isScam).toBe(false);
  });

  it("promotes IP-hosted pages with an active behavior", () => {
    const decision = decideScam(
      true,
      0.56,
      signals({ isIpAddress: true, workerBombDetected: true })
    );

    expect(decision.isScam).toBe(true);
    expect(decision.reason).toBe("signal_override");
  });

  it("keeps the signal-backed threshold at 0.55", () => {
    const below = decideScam(
      true,
      SIGNAL_BACKED_CONFIDENCE_THRESHOLD - 0.001,
      signals({ isThirdPartyHosting: true, pointerLockRequested: true })
    );
    const at = decideScam(
      true,
      SIGNAL_BACKED_CONFIDENCE_THRESHOLD,
      signals({ isThirdPartyHosting: true, pointerLockRequested: true })
    );

    expect(below.isScam).toBe(false);
    expect(at.isScam).toBe(true);
  });

  it("never promotes when the classifier says non-scam", () => {
    const decision = decideScam(
      false,
      0.99,
      signals({
        fullscreenRequested: true,
        keyboardLockRequested: true,
        isThirdPartyHosting: true,
      })
    );

    expect(decision.isScam).toBe(false);
  });
});

describe("signal helpers", () => {
  it("counts only active behaviors", () => {
    expect(
      countActiveSignals(
        signals({
          fullscreenRequested: true,
          keyboardLockRequested: true,
          isThirdPartyHosting: true,
          isIpAddress: true,
        })
      )
    ).toBe(2);
  });

  it("requires hosting plus an active behavior", () => {
    expect(hasStrongScamSignals(signals({ isThirdPartyHosting: true }))).toBe(
      false
    );
    expect(hasStrongScamSignals(signals({ keyboardLockRequested: true }))).toBe(
      false
    );
    expect(
      hasStrongScamSignals(
        signals({ isThirdPartyHosting: true, keyboardLockRequested: true })
      )
    ).toBe(true);
  });
});
