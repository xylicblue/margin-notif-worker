import { formatUnits } from "viem";
import { describe, expect, it } from "vitest";
import {
  decimalToX18,
  rowToLiquidationNotice,
  rowToPositionUpsert,
  type CanonicalPnlRow,
} from "../src/positions/canonical.js";

const MARKET = "0x0000000000000000000000000000000000000000000000000000000000000001";
const USER = "0x00000000000000000000000000000000000000aa";
const TX = "0x00000000000000000000000000000000000000000000000000000000000000ff";

function row(overrides: Partial<CanonicalPnlRow>): CanonicalPnlRow {
  return {
    tx_hash: TX,
    block_number: "10800000",
    transaction_index: 3,
    primary_log_index: 7,
    user_address: USER,
    market_id: MARKET,
    accounting_type: "open",
    new_size: "1.5",
    closed_size: null,
    notional: null,
    liquidation_penalty: null,
    ...overrides,
  };
}

describe("decimalToX18", () => {
  it.each([
    ["0", 0n],
    ["1", 10n ** 18n],
    ["1.5", 15n * 10n ** 17n],
    ["-0.5", -5n * 10n ** 17n],
    ["0.000000000000000001", 1n],
    ["-123456789.123456789123456789", -123456789123456789123456789n],
    ["2.500000000000000000000", 25n * 10n ** 17n],
  ] as const)("converts %s", (input, expected) => {
    expect(decimalToX18(input)).toBe(expected);
  });

  it("round-trips viem formatUnits(…, 18) exactly", () => {
    const values = [1n, -1n, 10n ** 18n, -(10n ** 18n) - 7n, 2n ** 127n - 1n, -(2n ** 200n) + 12345n, 999_999_999_999_999_999n];
    for (const value of values) {
      expect(decimalToX18(formatUnits(value, 18))).toBe(value);
    }
  });

  it.each(["", "abc", "1e18", "1.0000000000000000001", "1,5", "--1"])("rejects %j", (input) => {
    expect(() => decimalToX18(input)).toThrow();
  });
});

describe("rowToPositionUpsert", () => {
  it("maps new_size to the 1e18 last_size with the same upsert arguments as the chain scanner", () => {
    expect(rowToPositionUpsert(row({ new_size: "-2.25", tx_hash: TX.toUpperCase().replace("0X", "0x") }), "H100-PERP")).toEqual({
      account: USER,
      marketId: MARKET,
      marketLabel: "H100-PERP",
      newSize: -2_250_000_000_000_000_000n,
      blockNumber: 10_800_000n,
      txHash: TX,
    });
  });

  it("treats a close row without TradeExecuted as a flat position", () => {
    expect(rowToPositionUpsert(row({ accounting_type: "close", new_size: null }), "H100-PERP")?.newSize).toBe(0n);
  });

  it("keeps an explicit zero size", () => {
    expect(rowToPositionUpsert(row({ accounting_type: "reduce", new_size: "0" }), "H100-PERP")?.newSize).toBe(0n);
  });

  it.each(["margin_added", "margin_removed", "funding_settlement", "liquidation"])("skips %s rows without new_size", (type) => {
    expect(rowToPositionUpsert(row({ accounting_type: type, new_size: null }), "H100-PERP")).toBeNull();
  });

  it("lowercases account and market identifiers", () => {
    const result = rowToPositionUpsert(row({ user_address: USER.toUpperCase().replace("0X", "0x"), market_id: MARKET }), "H100-PERP");
    expect(result?.account).toBe(USER);
  });
});

describe("rowToLiquidationNotice", () => {
  it("rebuilds the LiquidationExecuted notice with the same idempotency inputs", () => {
    const notice = rowToLiquidationNotice(row({
      accounting_type: "liquidation",
      new_size: "0.4",
      closed_size: "0.6",
      notional: "1234.5",
      liquidation_penalty: "24.69",
    }), "H100-PERP");
    expect(notice).toEqual({
      account: USER,
      marketId: MARKET,
      marketLabel: "H100-PERP",
      transactionHash: TX,
      logIndex: 7,
      size: 6n * 10n ** 17n,
      notional: 12345n * 10n ** 17n,
      penalty: 2469n * 10n ** 16n,
      remainingSize: 4n * 10n ** 17n,
      blockNumber: 10_800_000n,
    });
  });

  it("reports unknown remaining size when the liquidation had no TradeExecuted", () => {
    const notice = rowToLiquidationNotice(row({ accounting_type: "liquidation", new_size: null, closed_size: "1", notional: "1", liquidation_penalty: "0" }), "H100-PERP");
    expect(notice?.remainingSize).toBeNull();
  });

  it("ignores non-liquidation rows", () => {
    expect(rowToLiquidationNotice(row({ accounting_type: "close" }), "H100-PERP")).toBeNull();
  });
});
