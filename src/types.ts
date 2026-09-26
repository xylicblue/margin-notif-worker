import type { Address, Hex } from "viem";

export type DeliveryMode = "shadow" | "in_app" | "all";
export type RiskLevel = "healthy" | "warning" | "danger" | "near_liquidation" | "liquidatable";
export type NotificationCode = "A0" | "A1" | "A2" | "A3" | "B1" | "B2";

export interface MarketConfig {
  id: Hex;
  label: string;
}

export interface ActivePosition {
  id: string;
  chain_id: number;
  account: Address;
  market_id: Hex;
  market_label: string;
  last_size: string;
  first_seen_block: number;
  last_seen_block: number;
  active: boolean;
  last_reconciled_at: string | null;
}

export interface RiskSnapshot {
  positionId: string;
  account: Address;
  marketId: Hex;
  marketLabel: string;
  size: bigint;
  positionMargin: bigint;
  effectiveMargin: bigint;
  maintenanceMargin: bigint;
  liquidationBuffer: bigint;
  coverageMultiple: number;
  marginRatioX18: bigint;
  mmrBps: bigint;
  markPrice: bigint;
  indexPrice: bigint;
  markNotional: bigint;
  pendingFundingEstimate: bigint | null;
  isLiquidatable: boolean;
  observedAt: Date;
}

export interface RiskEvaluation {
  level: RiskLevel;
  code: NotificationCode | null;
  priority: "critical" | "high" | "medium" | "low";
  snapshot: RiskSnapshot;
}

export interface RiskEpisode {
  id: string;
  position_id: string;
  current_level: RiskLevel;
  highest_level: RiskLevel;
  started_at: string;
  last_evaluated_at: string;
  last_notified_at: string | null;
  ended_at: string | null;
}

export interface LiquidationNotice {
  account: Address;
  marketId: Hex;
  marketLabel: string;
  transactionHash: Hex;
  logIndex: number;
  size: bigint;
  notional: bigint;
  penalty: bigint;
  remainingSize: bigint | null;
  blockNumber: bigint;
}

export interface WorkerHealth {
  startedAt: string;
  leader: boolean;
  ready: boolean;
  lastEventScanAt: string | null;
  lastRiskPassAt: string | null;
  lastDeliveryPassAt: string | null;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  activePositions: number;
  evaluatedPositions: number;
}
