import { describe, expect, it } from "vitest";
import { getAuditDecision } from "../../src/services/decisionModelService.js";

const thresholds = {
  strongThreshold: 0.9,
  reviewThreshold: 0.5,
  negativeThreshold: 0.1,
  auditSampleRate: 0.02,
};

describe("decision model audit decisions", () => {
  it("marks a strong Drex target that ONNX rejected as a rescue", () => {
    const decision = getAuditDecision(0.95, false, thresholds, 0.99);
    expect(decision.reason).toBe("drex_rescue");
    expect(decision.verdictDiff).toBe(true);
  });

  it("marks a strong Drex negative that ONNX accepted as a veto", () => {
    const decision = getAuditDecision(0.05, true, thresholds, 0.99);
    expect(decision.reason).toBe("drex_veto");
    expect(decision.verdictDiff).toBe(true);
  });

  it("marks the middle band as uncertain without a verdict diff", () => {
    const decision = getAuditDecision(0.7, true, thresholds, 0.99);
    expect(decision.reason).toBe("drex_uncertain");
    expect(decision.verdictDiff).toBe(false);
  });

  it("does not mark agreement as a diff", () => {
    const decision = getAuditDecision(0.95, true, thresholds, 0.99);
    expect(decision.reason).toBeNull();
    expect(decision.verdictDiff).toBe(false);
  });

  it("takes a random audit sample when both models agree", () => {
    const decision = getAuditDecision(0.95, true, thresholds, 0.01);
    expect(decision.reason).toBe("random_audit");
    expect(decision.verdictDiff).toBe(false);
  });

  it("handles a missing probability", () => {
    const decision = getAuditDecision(null, true, thresholds);
    expect(decision.reason).toBeNull();
    expect(decision.verdictDiff).toBe(false);
  });
});
