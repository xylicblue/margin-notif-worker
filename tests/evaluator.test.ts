import { describe, expect, it } from "vitest";
import type { RiskSnapshot } from "../src/types.js";
import { evaluateRisk } from "../src/risk/evaluator.js";

function snapshot(coverageMultiple: number, liquidatable = false): RiskSnapshot {
  const maintenance = 100n * 10n ** 18n;
  return {
    positionId: "position-id",
    account: "0x0000000000000000000000000000000000000001",
    marketId: "0x0000000000000000000000000000000000000000000000000000000000000001",
    marketLabel: "H100-PERP",
    size: 10n ** 18n,
    positionMargin: BigInt(Math.round(coverageMultiple * 100)) * 10n ** 18n,
    effectiveMargin: BigInt(Math.round(coverageMultiple * 100)) * 10n ** 18n,
    maintenanceMargin: maintenance,
    liquidationBuffer: BigInt(Math.round((coverageMultiple - 1) * 100)) * 10n ** 18n,
    coverageMultiple,
    marginRatioX18: 10n ** 17n,
    mmrBps: 500n,
    markPrice: 2n * 10n ** 18n,
    indexPrice: 2n * 10n ** 18n,
    markNotional: 2_000n * 10n ** 18n,
    pendingFundingEstimate: null,
    isLiquidatable: liquidatable,
    observedAt: new Date("2026-09-26T00:00:00Z"),
  };
}

describe("margin risk evaluator", () => {
  const thresholds = { warning: 2, danger: 1.5, nearLiquidation: 1.1 };

  it.each([
    [2.01, "healthy", null],
    [2, "warning", "A1"],
    [1.5, "danger", "A2"],
    [1.1, "near_liquidation", "A3"],
  ] as const)("maps %s coverage to %s", (coverage, level, code) => {
    expect(evaluateRisk(snapshot(coverage), thresholds)).toMatchObject({ level, code });
  });

  it("always treats a liquidatable position as critical", () => {
    expect(evaluateRisk(snapshot(3, true), thresholds)).toMatchObject({
      level: "liquidatable",
      code: "A3",
      priority: "critical",
    });
  });

  it("treats margin below maintenance as liquidatable", () => {
    expect(evaluateRisk(snapshot(0.99), thresholds).level).toBe("liquidatable");
  });
});
