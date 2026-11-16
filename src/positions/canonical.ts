import type { Address, Hex } from "viem";
import type { LiquidationNotice } from "../types.js";

/**
 * Row shape read from public.canonical_pnl_events (written by the canonical PnL indexer).
 * Numeric columns are selected with a ::text cast so 18-decimal values keep full precision.
 */
export interface CanonicalPnlRow {
  tx_hash: string;
  block_number: string;
  transaction_index: number;
  primary_log_index: number;
  user_address: string;
  market_id: string;
  accounting_type: string;
  new_size: string | null;
  closed_size: string | null;
  notional: string | null;
  liquidation_penalty: string | null;
}

export const CANONICAL_ROW_SELECT = [
  "id",
  "tx_hash",
  "block_number::text",
  "transaction_index",
  "primary_log_index",
  "user_address",
  "market_id",
  "accounting_type",
  "new_size::text",
  "closed_size::text",
  "notional::text",
  "liquidation_penalty::text",
].join(",");

const DECIMAL_PATTERN = /^([+-])?(\d+)(?:\.(\d+))?$/;

/**
 * Converts a decimal string produced by viem `formatUnits(x, 18)` (as stored by the indexer)
 * back into its exact 1e18-scaled integer. Throws rather than rounding if the value has
 * non-zero digits past 18 decimals or is not a plain decimal.
 */
export function decimalToX18(value: string): bigint {
  const match = DECIMAL_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal value: ${JSON.stringify(value)}`);
  const [, sign, whole = "0", fractionRaw = ""] = match;
  const fraction = fractionRaw.replace(/0+$/, "");
  if (fraction.length > 18) throw new Error(`Decimal value has more than 18 fractional digits: ${value}`);
  const scaled = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0") || "0");
  return sign === "-" ? -scaled : scaled;
}

export interface PositionUpsert {
  account: Address;
  marketId: Hex;
  marketLabel: string;
  newSize: bigint;
  blockNumber: bigint;
  txHash: Hex;
}

/**
 * Maps a canonical row to the upsert_margin_active_position arguments the legacy scanner
 * produced from TradeExecuted.newSize. Returns null when the row carries no position size
 * (margin/funding rows, or liquidation rows without a TradeExecuted). A close row without a
 * TradeExecuted (PositionClosed only) means the position is now flat.
 */
export function rowToPositionUpsert(row: CanonicalPnlRow, marketLabel: string): PositionUpsert | null {
  let newSize: bigint;
  if (row.new_size !== null && row.new_size !== undefined) {
    newSize = decimalToX18(row.new_size);
  } else if (row.accounting_type === "close") {
    newSize = 0n;
  } else {
    return null;
  }
  return {
    account: row.user_address.toLowerCase() as Address,
    marketId: row.market_id.toLowerCase() as Hex,
    marketLabel,
    newSize,
    blockNumber: BigInt(row.block_number),
    txHash: row.tx_hash.toLowerCase() as Hex,
  };
}

/**
 * Rebuilds the B1/B2 liquidation notice the legacy scanner built from LiquidationExecuted.
 * logIndex is the LiquidationExecuted log index (the row's primary_log_index), so the
 * notification idempotency key is unchanged. remainingSize is the TradeExecuted.newSize of the
 * same (tx, account, market), or null when the liquidation emitted no TradeExecuted.
 */
export function rowToLiquidationNotice(row: CanonicalPnlRow, marketLabel: string): LiquidationNotice | null {
  if (row.accounting_type !== "liquidation") return null;
  return {
    account: row.user_address.toLowerCase() as Address,
    marketId: row.market_id.toLowerCase() as Hex,
    marketLabel,
    transactionHash: row.tx_hash.toLowerCase() as Hex,
    logIndex: Number(row.primary_log_index),
    size: decimalToX18(row.closed_size ?? "0"),
    notional: decimalToX18(row.notional ?? "0"),
    penalty: decimalToX18(row.liquidation_penalty ?? "0"),
    remainingSize: row.new_size === null || row.new_size === undefined ? null : decimalToX18(row.new_size),
    blockNumber: BigInt(row.block_number),
  };
}
