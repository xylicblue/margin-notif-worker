import { describe, expect, it } from "vitest";
import { buildRiskNotification } from "../src/notifications/templates.js";
import { evaluateRisk } from "../src/risk/evaluator.js";
import type { RiskSnapshot } from "../src/types.js";

describe("risk notification template", () => {
  it("gives the client direct risk-reduction actions", () => {
    const snapshot: RiskSnapshot = {
      positionId: "position-id",
      account: "0x0000000000000000000000000000000000000001",
      marketId: "0x0000000000000000000000000000000000000000000000000000000000000001",
      marketLabel: "H100-PERP",
      size: 1n,
      positionMargin: 200n * 10n ** 18n,
      effectiveMargin: 150n * 10n ** 18n,
      maintenanceMargin: 100n * 10n ** 18n,
      liquidationBuffer: 50n * 10n ** 18n,
      coverageMultiple: 1.5,
      marginRatioX18: 75_000_000_000_000_000n,
      mmrBps: 500n,
      markPrice: 2n * 10n ** 18n,
      indexPrice: 2n * 10n ** 18n,
      markNotional: 2_000n * 10n ** 18n,
      pendingFundingEstimate: null,
      isLiquidatable: false,
      observedAt: new Date("2026-09-26T00:00:00Z"),
    };
    const content = buildRiskNotification(evaluateRisk(snapshot, { warning: 2, danger: 1.5, nearLiquidation: 1.1 }));
    expect(content.code).toBe("A2");
    expect(content.actions.map((action) => action.label)).toEqual(["Add collateral", "Review position"]);
  });
});
