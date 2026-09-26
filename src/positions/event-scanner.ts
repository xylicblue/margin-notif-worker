import type { Address, Hex } from "viem";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { getState, setState } from "../db/client.js";
import { upsertPosition } from "../db/repository.js";
import type { LiquidationNotice } from "../types.js";
import { liquidationExecutedEvent, tradeExecutedEvent } from "../chain/abi.js";
import { publicClient } from "../chain/client.js";

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
}

function tradeKey(txHash: Hex, account: Address, marketId: Hex): string {
  return `${txHash.toLowerCase()}:${account.toLowerCase()}:${marketId.toLowerCase()}`;
}

export async function scanConfirmedEvents(): Promise<ScanResult | null> {
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
  };
}
