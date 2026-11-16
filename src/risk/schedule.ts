import type { ActivePosition, RiskLevel } from "../types.js";

export interface TierConfig {
  /** How often a healthy position far from the thresholds is re-read. */
  healthyRecheckMs: number;
  /** Coverage at or below this multiple is "near" and read every tick. */
  nearCoverage: number;
}

interface PositionTierState {
  checkedAt: number;
  near: boolean;
}

export function positionKey(account: string, marketId: string): string {
  return `${account.toLowerCase()}:${marketId.toLowerCase()}`;
}

/** Near = any non-healthy level, or a healthy coverage multiple within the buffer above the warning threshold. */
export function isNearThreshold(level: RiskLevel, coverageMultiple: number, nearCoverage: number): boolean {
  if (level !== "healthy") return true;
  return coverageMultiple <= nearCoverage;
}

/**
 * In-memory tiered schedule for the risk pass.
 * - positions never seen by this process, or touched by a new event: due on the next tick;
 * - positions near the alert thresholds: due every tick;
 * - other positions: due once `healthyRecheckMs` has elapsed since the last successful read.
 */
export class RiskScheduler {
  private readonly state = new Map<string, PositionTierState>();
  private readonly touched = new Set<string>();

  constructor(private readonly config: TierConfig) {}

  markTouched(key: string): void {
    this.touched.add(key);
  }

  isDue(position: ActivePosition, now: number): boolean {
    if (this.touched.has(positionKey(position.account, position.market_id))) return true;
    const state = this.state.get(position.id);
    if (!state) return true;
    if (state.near) return true;
    return now - state.checkedAt >= this.config.healthyRecheckMs;
  }

  recordEvaluated(position: ActivePosition, now: number, level: RiskLevel, coverageMultiple: number): void {
    this.state.set(position.id, { checkedAt: now, near: isNearThreshold(level, coverageMultiple, this.config.nearCoverage) });
    this.touched.delete(positionKey(position.account, position.market_id));
  }

  /** The position was closed or failed to read: forget it so it is re-read on the next tick. */
  forget(position: ActivePosition, clearTouched = false): void {
    this.state.delete(position.id);
    if (clearTouched) this.touched.delete(positionKey(position.account, position.market_id));
  }

  /**
   * Drop state for positions that are no longer listed as active. Touch marks for unlisted
   * positions are dropped too: a position created after the listing has no state and is due anyway.
   */
  retain(positions: ActivePosition[]): void {
    const ids = new Set(positions.map((p) => p.id));
    const keys = new Set(positions.map((p) => positionKey(p.account, p.market_id)));
    for (const id of this.state.keys()) {
      if (!ids.has(id)) this.state.delete(id);
    }
    for (const key of this.touched) {
      if (!keys.has(key)) this.touched.delete(key);
    }
  }

  get size(): number {
    return this.state.size;
  }
}
