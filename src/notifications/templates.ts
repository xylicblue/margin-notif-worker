import { formatUnits } from "viem";
import type { LiquidationNotice, NotificationCode, RiskEvaluation, RiskLevel } from "../types.js";

export interface NotificationContent {
  code: NotificationCode;
  category: "A" | "B";
  priority: "critical" | "high" | "medium" | "low";
  title: string;
  body: string;
  actions: Array<{ label: string; href: string }>;
  data: Record<string, unknown>;
}

const money = (value: bigint) => Number(formatUnits(value, 18)).toLocaleString("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percent = (value: bigint) => `${(Number(formatUnits(value, 18)) * 100).toFixed(2)}%`;

function riskData(evaluation: RiskEvaluation): Record<string, unknown> {
  const s = evaluation.snapshot;
  return {
    risk_level: evaluation.level,
    coverage_multiple: Number.isFinite(s.coverageMultiple) ? s.coverageMultiple : null,
    effective_margin: formatUnits(s.effectiveMargin, 18),
    maintenance_margin: formatUnits(s.maintenanceMargin, 18),
    liquidation_buffer: formatUnits(s.liquidationBuffer, 18),
    margin_ratio: percent(s.marginRatioX18),
    mmr_bps: s.mmrBps.toString(),
    mark_price: formatUnits(s.markPrice, 18),
    index_price: formatUnits(s.indexPrice, 18),
    observed_at: s.observedAt.toISOString(),
  };
}

export function buildRiskNotification(evaluation: RiskEvaluation): NotificationContent {
  const s = evaluation.snapshot;
  const href = `/trade?market=${encodeURIComponent(s.marketLabel)}`;
  const common = {
    category: "A" as const,
    actions: [
      { label: "Add collateral", href },
      { label: "Review position", href },
    ],
    data: riskData(evaluation),
  };

  if (evaluation.level === "liquidatable") {
    return {
      ...common,
      code: "A3",
      priority: "critical",
      title: `Position eligible for liquidation - ${s.marketLabel}`,
      body: `Effective margin ($${money(s.effectiveMargin)}) is below the $${money(s.maintenanceMargin)} maintenance requirement. Liquidation may occur without further notice.`,
      actions: [{ label: "Add collateral", href }],
    };
  }
  if (evaluation.level === "near_liquidation") {
    return {
      ...common,
      code: "A3",
      priority: "critical",
      title: `Liquidation risk is critical - ${s.marketLabel}`,
      body: `Your margin is ${s.coverageMultiple.toFixed(2)}x the maintenance requirement. Add collateral or reduce the position immediately.`,
    };
  }
  if (evaluation.level === "danger") {
    return {
      ...common,
      code: "A2",
      priority: "high",
      title: `High liquidation risk - ${s.marketLabel}`,
      body: `Your margin is ${s.coverageMultiple.toFixed(2)}x the maintenance requirement. Prompt action is recommended.`,
    };
  }
  return {
    ...common,
    code: "A1",
    priority: "medium",
    title: `Margin warning - ${s.marketLabel}`,
    body: `Your margin has fallen to ${s.coverageMultiple.toFixed(2)}x the maintenance requirement. Consider adding collateral or reducing the position.`,
  };
}

export function buildRecoveryNotification(
  marketLabel: string,
  previousLevel: RiskLevel,
  evaluation: RiskEvaluation,
): NotificationContent {
  return {
    code: "A0",
    category: "A",
    priority: "low",
    title: `Margin condition cleared - ${marketLabel}`,
    body: "Your position is now above the configured margin-warning threshold.",
    actions: [{ label: "Review position", href: `/trade?market=${encodeURIComponent(marketLabel)}` }],
    data: { ...riskData(evaluation), previous_level: previousLevel },
  };
}

export function buildLiquidationNotification(notice: LiquidationNotice): NotificationContent {
  const partial = notice.remainingSize !== null && notice.remainingSize !== 0n;
  return {
    code: partial ? "B1" : "B2",
    category: "B",
    priority: "critical",
    title: `${partial ? "Partial" : "Full"} liquidation - ${notice.marketLabel}`,
    body: partial
      ? `${formatUnits(notice.size, 18)} units were liquidated. Penalty: $${money(notice.penalty)}. Remaining position: ${formatUnits(notice.remainingSize ?? 0n, 18)} units.`
      : `Your position with notional value $${money(notice.notional)} was fully liquidated. Penalty: $${money(notice.penalty)}.`,
    actions: [{ label: "View history", href: "/portfolio" }],
    data: {
      market_id: notice.marketId,
      size: formatUnits(notice.size, 18),
      notional: formatUnits(notice.notional, 18),
      penalty: formatUnits(notice.penalty, 18),
      remaining_size: notice.remainingSize === null ? null : formatUnits(notice.remainingSize, 18),
      transaction_hash: notice.transactionHash,
      block_number: notice.blockNumber.toString(),
    },
  };
}
