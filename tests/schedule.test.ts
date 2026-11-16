import { describe, expect, it } from "vitest";
import { buildRiskSnapshot, notionalFromMark } from "../src/chain/client.js";
import { shouldTouchPosition } from "../src/risk/processor.js";
import { isNearThreshold, positionKey, RiskScheduler } from "../src/risk/schedule.js";
import type { ActivePosition } from "../src/types.js";

function position(id: string, account = "0x00000000000000000000000000000000000000aa"): ActivePosition {
  return {
    id,
    chain_id: 11155111,
    account: account as ActivePosition["account"],
    market_id: "0x0000000000000000000000000000000000000000000000000000000000000001",
    market_label: "H100-PERP",
    last_size: "1000000000000000000",
    first_seen_block: 1,
    last_seen_block: 1,
    active: true,
    last_reconciled_at: null,
  };
}

const RECHECK = 300_000;

describe("tiered risk schedule", () => {
  it("classifies near positions with the configured buffer", () => {
    expect(isNearThreshold("healthy", 2.9, 3)).toBe(true);
    expect(isNearThreshold("healthy", 3, 3)).toBe(true);
    expect(isNearThreshold("healthy", 3.01, 3)).toBe(false);
    expect(isNearThreshold("healthy", Number.POSITIVE_INFINITY, 3)).toBe(false);
    expect(isNearThreshold("warning", 10, 3)).toBe(true);
  });

  it("reads unseen positions immediately", () => {
    const scheduler = new RiskScheduler({ healthyRecheckMs: RECHECK, nearCoverage: 3 });
    expect(scheduler.isDue(position("a"), 0)).toBe(true);
  });

  it("reads near positions every tick and healthy ones every HEALTHY_RECHECK_MS", () => {
    const scheduler = new RiskScheduler({ healthyRecheckMs: RECHECK, nearCoverage: 3 });
    const near = position("near", "0x00000000000000000000000000000000000000a1");
    const healthy = position("healthy", "0x00000000000000000000000000000000000000a2");
    scheduler.recordEvaluated(near, 0, "healthy", 2.5);
    scheduler.recordEvaluated(healthy, 0, "healthy", 8);

    expect(scheduler.isDue(near, 30_000)).toBe(true);
    expect(scheduler.isDue(healthy, 30_000)).toBe(false);
    expect(scheduler.isDue(healthy, RECHECK - 1)).toBe(false);
    expect(scheduler.isDue(healthy, RECHECK)).toBe(true);
  });

  it("re-reads a healthy position on the next tick after an event touches it", () => {
    const scheduler = new RiskScheduler({ healthyRecheckMs: RECHECK, nearCoverage: 3 });
    const p = position("p");
    scheduler.recordEvaluated(p, 0, "healthy", 8);
    expect(scheduler.isDue(p, 30_000)).toBe(false);

    scheduler.markTouched(positionKey(p.account.toUpperCase().replace("0X", "0x"), p.market_id));
    expect(scheduler.isDue(p, 30_000)).toBe(true);

    scheduler.recordEvaluated(p, 30_000, "healthy", 8);
    expect(scheduler.isDue(p, 60_000)).toBe(false);
  });

  it("re-reads failed or closed positions on the next tick", () => {
    const scheduler = new RiskScheduler({ healthyRecheckMs: RECHECK, nearCoverage: 3 });
    const p = position("p");
    scheduler.recordEvaluated(p, 0, "healthy", 8);
    scheduler.forget(p);
    expect(scheduler.isDue(p, 1)).toBe(true);
  });

  it("drops state and touch marks for positions that are no longer active", () => {
    const scheduler = new RiskScheduler({ healthyRecheckMs: RECHECK, nearCoverage: 3 });
    const kept = position("kept", "0x00000000000000000000000000000000000000a1");
    const gone = position("gone", "0x00000000000000000000000000000000000000a2");
    scheduler.recordEvaluated(kept, 0, "healthy", 8);
    scheduler.recordEvaluated(gone, 0, "healthy", 8);
    scheduler.markTouched(positionKey(gone.account, gone.market_id));
    scheduler.retain([kept]);
    expect(scheduler.size).toBe(1);
    expect(scheduler.isDue(kept, 1)).toBe(false);
  });
});

describe("position reconciliation writes", () => {
  const now = Date.parse("2026-11-16T12:00:00Z");

  it("writes when the size changed", () => {
    expect(shouldTouchPosition({ last_size: "1", last_reconciled_at: new Date(now).toISOString() }, 2n, now, RECHECK)).toBe(true);
  });

  it("skips when unchanged and recently reconciled", () => {
    expect(shouldTouchPosition({ last_size: "1000000000000000000", last_reconciled_at: new Date(now - 60_000).toISOString() }, 10n ** 18n, now, RECHECK)).toBe(false);
  });

  it("refreshes last_reconciled_at once per HEALTHY_RECHECK_MS", () => {
    expect(shouldTouchPosition({ last_size: "5", last_reconciled_at: new Date(now - RECHECK).toISOString() }, 5n, now, RECHECK)).toBe(true);
    expect(shouldTouchPosition({ last_size: "5", last_reconciled_at: null }, 5n, now, RECHECK)).toBe(true);
  });
});

describe("snapshot from batched reads", () => {
  it("computes notional as abs(size) * mark / 1e18 (ClearingHouse._getNotional)", () => {
    expect(notionalFromMark(-3n * 10n ** 18n, 2n * 10n ** 18n)).toBe(6n * 10n ** 18n);
    expect(notionalFromMark(1n, 10n ** 18n - 1n)).toBe(0n);
    expect(notionalFromMark(0n, 10n ** 18n)).toBe(0n);
  });

  it("matches the previous per-position formula", () => {
    const snapshot = buildRiskSnapshot(
      position("p"),
      { size: -2n * 10n ** 18n, margin: 50n * 10n ** 18n },
      10n ** 17n,
      false,
      { mmrBps: 250n, indexPrice: 2n * 10n ** 18n, markPrice: 21n * 10n ** 17n },
      new Date(0),
    );
    expect(snapshot?.markNotional).toBe(42n * 10n ** 17n);
    expect(snapshot?.effectiveMargin).toBe(42n * 10n ** 16n);
    expect(snapshot?.maintenanceMargin).toBe(1n * 10n ** 17n);
    expect(snapshot?.coverageMultiple).toBe(4.2);
  });

  it("returns null for a closed position", () => {
    expect(buildRiskSnapshot(position("p"), { size: 0n, margin: 0n }, 0n, false, { mmrBps: 250n, indexPrice: 1n, markPrice: 1n })).toBeNull();
  });
});
