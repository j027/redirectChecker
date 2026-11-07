import { DetectedSignals, hasWeightedSignal } from "./signalService.js";

/** Confidence required when leaning on the classifier alone. */
export const CONFIDENCE_THRESHOLD = 0.80;

/** Lower confidence allowed when strong, independent browser signals agree. */
export const SIGNAL_BACKED_CONFIDENCE_THRESHOLD = 0.55;

export type ScamDecisionReason = "classifier" | "signal_override" | null;

export interface ScamDecision {
  isScam: boolean;
  reason: ScamDecisionReason;
  hasSignal: boolean;
  hasStrongSignals: boolean;
  activeSignalCount: number;
}

/** Active page behaviors; hosting location alone is not enough. */
export function countActiveSignals(signals: DetectedSignals): number {
  return (
    Number(signals.fullscreenRequested) +
    Number(signals.keyboardLockRequested) +
    Number(signals.pointerLockRequested) +
    Number(signals.workerBombDetected)
  );
}

/**
 * Strong scam evidence needs two independent categories:
 * suspicious hosting plus at least one active page behavior.
 */
export function hasStrongScamSignals(signals: DetectedSignals): boolean {
  return (
    (signals.isThirdPartyHosting || signals.isIpAddress) &&
    countActiveSignals(signals) >= 1
  );
}

/**
 * Decides whether a classification is actionable. The classifier must always
 * say scam; signals can then either corroborate a high-confidence result or
 * lower the required confidence when the behavioral evidence is strong.
 */
export function decideScam(
  classifierIsScam: boolean,
  confidenceScore: number,
  signals: DetectedSignals
): ScamDecision {
  const hasSignal = hasWeightedSignal(signals);
  const hasStrongSignals = hasStrongScamSignals(signals);
  const activeSignalCount = countActiveSignals(signals);

  if (!classifierIsScam) {
    return {
      isScam: false,
      reason: null,
      hasSignal,
      hasStrongSignals,
      activeSignalCount,
    };
  }

  if (confidenceScore >= CONFIDENCE_THRESHOLD) {
    return {
      isScam: hasSignal,
      reason: hasSignal ? "classifier" : null,
      hasSignal,
      hasStrongSignals,
      activeSignalCount,
    };
  }

  if (
    confidenceScore >= SIGNAL_BACKED_CONFIDENCE_THRESHOLD &&
    hasStrongSignals
  ) {
    return {
      isScam: true,
      reason: "signal_override",
      hasSignal,
      hasStrongSignals,
      activeSignalCount,
    };
  }

  return {
    isScam: false,
    reason: null,
    hasSignal,
    hasStrongSignals,
    activeSignalCount,
  };
}
