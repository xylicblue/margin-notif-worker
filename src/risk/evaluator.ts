import { env } from "../config/env.js";
import type { NotificationCode, RiskEvaluation, RiskLevel, RiskSnapshot } from "../types.js";

const RANK: Record<RiskLevel, number> = {
  healthy: 0,
  warning: 1,
  danger: 2,
  near_liquidation: 3,
  liquidatable: 4,
};

export function riskRank(level: RiskLevel): number {
  return RANK[level];
}

export function highestRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return riskRank(a) >= riskRank(b) ? a : b;
}

export interface Thresholds {
  warning: number;
  danger: number;
  nearLiquidation: number;
}

export const configuredThresholds: Thresholds = {
  warning: env.WARNING_MULTIPLIER,
  danger: env.DANGER_MULTIPLIER,
  nearLiquidation: env.NEAR_LIQUIDATION_MULTIPLIER,
};

export function evaluateRisk(snapshot: RiskSnapshot, thresholds: Thresholds = configuredThresholds): RiskEvaluation {
  let level: RiskLevel = "healthy";
  let code: NotificationCode | null = null;
  let priority: RiskEvaluation["priority"] = "low";

  if (snapshot.isLiquidatable || snapshot.effectiveMargin < snapshot.maintenanceMargin) {
    level = "liquidatable";
    code = "A3";
    priority = "critical";
  } else if (snapshot.coverageMultiple <= thresholds.nearLiquidation) {
    level = "near_liquidation";
    code = "A3";
    priority = "critical";
  } else if (snapshot.coverageMultiple <= thresholds.danger) {
    level = "danger";
    code = "A2";
    priority = "high";
  } else if (snapshot.coverageMultiple <= thresholds.warning) {
    level = "warning";
    code = "A1";
    priority = "medium";
  }

  return { level, code, priority, snapshot };
}

export function reminderIntervalMs(level: RiskLevel): number | null {
  if (level === "warning") return env.A1_REMINDER_SECONDS * 1_000;
  if (level === "danger") return env.A2_REMINDER_SECONDS * 1_000;
  if (level === "near_liquidation" || level === "liquidatable") return env.A3_REMINDER_SECONDS * 1_000;
  return null;
}

export function reminderDue(level: RiskLevel, lastNotifiedAt: string | null, now = Date.now()): boolean {
  const interval = reminderIntervalMs(level);
  if (interval === null) return false;
  if (!lastNotifiedAt) return true;
  return now - new Date(lastNotifiedAt).getTime() >= interval;
}
