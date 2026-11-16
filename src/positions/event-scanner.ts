import type { Address, Hex } from "viem";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getState, setState, supabase } from "../db/client.js";
import { upsertPosition } from "../db/repository.js";
import type { LiquidationNotice } from "../types.js";
import { liquidationExecutedEvent, tradeExecutedEvent } from "../chain/abi.js";
import { publicClient } from "../chain/client.js";
import { positionKey } from "../risk/schedule.js";
import {
  CANONICAL_ROW_SELECT,
  rowToLiquidationNotice,
  rowToPositionUpsert,
  type CanonicalPnlRow,
} from "./canonical.js";

const cursorKey = `events:${env.CHAIN_ID}:${env.CLEARING_HOUSE_ADDRESS.toLowerCase()}:cursor`;
const bootstrapKey = `events:${env.CHAIN_ID}:${env.CLEARING_HOUSE_ADDRESS.toLowerCase()}:bootstrapped`;
const marketLabels = new Map(env.markets.map((market) => [market.id.toLowerCase(), market.label]));

export interface ScanResult {
  fromBlock: bigint;
  toBlock: bigint;
  tradeEvents: number;
  liquidationEvents: number;
  liquidationNotices: LiquidationNotice[];
  bootstrapped: boolean;
  /** `account:market` keys of positions changed by the scanned events. */
  touchedPositions: string[];
  source: "indexer" | "chain";
}

function tradeKey(txHash: Hex, account: Address, marketId: Hex): string {
  return `${txHash.toLowerCase()}:${account.toLowerCase()}:${marketId.toLowerCase()}`;
}

export async function scanConfirmedEvents(): Promise<ScanResult | null> {
  return env.EVENT_SOURCE === "chain" ? scanChainEvents() : scanIndexerEvents();
}

/** Legacy scanner: reads TradeExecuted/LiquidationExecuted with eth_getLogs (EVENT_SOURCE=chain). */
export async function scanChainEvents(): Promise<ScanResult | null> {
  const head = await publicClient.getBlockNumber();
  const confirmations = BigInt(env.BLOCK_CONFIRMATIONS);
  if (head < confirmations) return null;
  const safeHead = head - confirmations;

  const savedCursor = await getState(cursorKey);
  let cursor = savedCursor === null ? BigInt(env.DEPLOYMENT_BLOCK) - 1n : BigInt(savedCursor);
  if (cursor >= safeHead) return null;

  const wasBootstrapped = (await getState(bootstrapKey)) === "true";
  const initialSafeHead = safeHead;
  let tradeCount = 0;
  let liquidationCount = 0;
  const notices: LiquidationNotice[] = [];
  const touched = new Set<string>();
  const firstBlock = cursor + 1n;

  while (cursor < safeHead) {
    const fromBlock = cursor + 1n;
    const toBlock = fromBlock + BigInt(env.EVENT_CHUNK_SIZE - 1) > safeHead
      ? safeHead
      : fromBlock + BigInt(env.EVENT_CHUNK_SIZE - 1);

    const [trades, liquidations] = await Promise.all([
      publicClient.getLogs({
        address: env.CLEARING_HOUSE_ADDRESS,
        event: tradeExecutedEvent,
        fromBlock,
        toBlock,
      }),
      publicClient.getLogs({
        address: env.CLEARING_HOUSE_ADDRESS,
        event: liquidationExecutedEvent,
        fromBlock,
        toBlock,
      }),
    ]);

    const finalSizes = new Map<string, bigint>();
    for (const log of trades) {
      const { user, marketId, newSize } = log.args;
      if (!user || !marketId || newSize === undefined || !log.transactionHash) continue;
      const marketLabel = marketLabels.get(marketId.toLowerCase());
      if (!marketLabel) continue;
      await upsertPosition({
        account: user,
        marketId,
        marketLabel,
        newSize,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      });
      finalSizes.set(tradeKey(log.transactionHash, user, marketId), newSize);
      touched.add(positionKey(user, marketId));
      tradeCount += 1;
    }

    if (wasBootstrapped) {
      for (const log of liquidations) {
        const { account, marketId, size, notional, penalty } = log.args;
        if (!account || !marketId || size === undefined || notional === undefined
          || penalty === undefined || !log.transactionHash || log.logIndex === null) continue;
        const marketLabel = marketLabels.get(marketId.toLowerCase());
        if (!marketLabel) continue;
        notices.push({
          account,
          marketId,
          marketLabel,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          size,
          notional,
          penalty,
          remainingSize: finalSizes.get(tradeKey(log.transactionHash, account, marketId)) ?? null,
          blockNumber: log.blockNumber,
        });
        liquidationCount += 1;
      }
    }

    cursor = toBlock;
    await setState(cursorKey, cursor.toString());
    logger.debug({ fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), trades: trades.length, liquidations: liquidations.length }, "Scanned confirmed chain events");
  }

  if (!wasBootstrapped && cursor >= initialSafeHead) {
    await setState(bootstrapKey, "true");
  }

  return {
    fromBlock: firstBlock,
    toBlock: cursor,
    tradeEvents: tradeCount,
    liquidationEvents: liquidationCount,
    liquidationNotices: notices,
    bootstrapped: wasBootstrapped || cursor >= initialSafeHead,
    touchedPositions: [...touched],
    source: "chain",
  };
}

interface IndexerCheckpoint {
  blockNumber: bigint;
  updatedAt: string | null;
}

async function readIndexerCheckpoint(): Promise<IndexerCheckpoint | null> {
  const { data, error } = await supabase
    .from("canonical_indexer_checkpoints")
    .select("last_block_number::text,updated_at")
    .eq("indexer_name", env.INDEXER_NAME)
    .eq("chain_id", env.CHAIN_ID)
    .maybeSingle();
  if (error) throw new Error(`Unable to read canonical indexer checkpoint: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as { last_block_number: string; updated_at: string | null };
  return { blockNumber: BigInt(row.last_block_number), updatedAt: row.updated_at };
}

async function readCanonicalRows(afterBlock: bigint, toBlock: bigint, offset: number, limit: number): Promise<CanonicalPnlRow[]> {
  const { data, error } = await supabase
    .from("canonical_pnl_events")
    .select(CANONICAL_ROW_SELECT)
    .eq("chain_id", env.CHAIN_ID)
    .eq("clearing_house", env.CLEARING_HOUSE_ADDRESS.toLowerCase())
    .gt("block_number", afterBlock.toString())
    .lte("block_number", toBlock.toString())
    .order("block_number", { ascending: true })
    .order("transaction_index", { ascending: true })
    .order("primary_log_index", { ascending: true })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`Unable to read canonical PnL events: ${error.message}`);
  return (data ?? []) as unknown as CanonicalPnlRow[];
}

/**
 * Default scanner: replays position changes from canonical_pnl_events (written by the canonical
 * indexer), so no RPC calls are made. Only blocks at or below the indexer checkpoint are read; the
 * indexer writes every row of a block before advancing its checkpoint past it. The cursor and
 * bootstrap flag use the same margin_worker_state keys as the chain scanner.
 */
export async function scanIndexerEvents(): Promise<ScanResult | null> {
  const checkpoint = await readIndexerCheckpoint();
  if (!checkpoint) {
    logger.warn({ indexerName: env.INDEXER_NAME, chainId: env.CHAIN_ID }, "Canonical indexer checkpoint not found; skipping event scan");
    return null;
  }
  if (checkpoint.updatedAt) {
    const lagMs = Date.now() - new Date(checkpoint.updatedAt).getTime();
    if (lagMs > env.INDEXER_STALE_WARN_MS) {
      logger.warn({ checkpointBlock: checkpoint.blockNumber.toString(), checkpointUpdatedAt: checkpoint.updatedAt, lagMs }, "Canonical indexer checkpoint is stale; position changes and liquidation notices are delayed");
    }
  }

  const target = checkpoint.blockNumber;
  const savedCursor = await getState(cursorKey);
  const startCursor = savedCursor === null ? BigInt(env.DEPLOYMENT_BLOCK) - 1n : BigInt(savedCursor);
  if (startCursor >= target) return null;

  const wasBootstrapped = (await getState(bootstrapKey)) === "true";
  let cursor = startCursor;
  let tradeCount = 0;
  let liquidationCount = 0;
  const notices: LiquidationNotice[] = [];
  const touched = new Set<string>();
  const pageSize = env.INDEXER_PAGE_SIZE;

  for (let offset = 0; ; offset += pageSize) {
    const rows = await readCanonicalRows(startCursor, target, offset, pageSize);

    for (const row of rows) {
      const marketLabel = marketLabels.get(row.market_id.toLowerCase());
      if (!marketLabel) continue;
      const upsert = rowToPositionUpsert(row, marketLabel);
      if (upsert) {
        await upsertPosition(upsert);
        touched.add(positionKey(upsert.account, upsert.marketId));
        tradeCount += 1;
      }
      if (wasBootstrapped) {
        const notice = rowToLiquidationNotice(row, marketLabel);
        if (notice) {
          notices.push(notice);
          touched.add(positionKey(notice.account, notice.marketId));
          liquidationCount += 1;
        }
      }
    }

    if (rows.length < pageSize) break;

    // Persist progress at the last fully processed block so a restart resumes close to here.
    // Rows of the boundary block may be replayed; upserts and notifications are idempotent.
    const last = rows.at(-1);
    if (last) {
      const completed = BigInt(last.block_number) - 1n;
      if (completed > cursor) {
        cursor = completed;
        await setState(cursorKey, cursor.toString());
      }
    }
  }

  cursor = target;
  await setState(cursorKey, cursor.toString());
  if (!wasBootstrapped) await setState(bootstrapKey, "true");

  return {
    fromBlock: startCursor + 1n,
    toBlock: cursor,
    tradeEvents: tradeCount,
    liquidationEvents: liquidationCount,
    liquidationNotices: notices,
    bootstrapped: true,
    touchedPositions: [...touched],
    source: "indexer",
  };
}
