import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { env } from "../config/env.js";
import type { ActivePosition, RiskSnapshot } from "../types.js";
import { clearingHouseAbi, marketRegistryAbi, oracleAbi, vammAbi } from "./abi.js";
import { countingTransport, rpcStats } from "./rpc-stats.js";

const WAD = 10n ** 18n;
const BPS = 10_000n;
const UINT256_MAX = 2n ** 256n - 1n;
const MARKET_CACHE_TTL_MS = 10 * 60_000;

const monitoredChain = defineChain({
  id: env.CHAIN_ID,
  name: `ByteStrike monitored chain ${env.CHAIN_ID}`,
  nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL] } },
  contracts: {
    multicall3: { address: env.MULTICALL3_ADDRESS as Address },
  },
});

export const publicClient = createPublicClient({
  chain: monitoredChain,
  transport: countingTransport(http(env.RPC_URL, {
    timeout: 15_000,
    retryCount: 2,
    retryDelay: 500,
    onFetchRequest: () => rpcStats.recordHttp(),
  })),
  batch: { multicall: true },
});

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function mulDivUp(a: bigint, b: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero");
  const product = a * b;
  return product === 0n ? 0n : ((product - 1n) / denominator) + 1n;
}

export interface PositionData {
  size: bigint;
  margin: bigint;
}

export interface MarketValues {
  mmrBps: bigint;
  indexPrice: bigint;
  markPrice: bigint;
}

/**
 * ClearingHouse.getNotional(account, market) is `abs(size) * vamm.getMarkPrice() / 1e18`
 * (floor mulDiv, see ClearingHouse._getNotional). Reading the mark price once per market in
 * the same multicall (same block) as the position therefore yields the identical value.
 */
export function notionalFromMark(size: bigint, markPrice: bigint): bigint {
  if (size === 0n) return 0n;
  return (abs(size) * markPrice) / WAD;
}

/** Pure snapshot computation, identical to the previous per-position read path. */
export function buildRiskSnapshot(
  position: ActivePosition,
  positionData: PositionData,
  marginRatioX18: bigint,
  liquidatable: boolean,
  market: MarketValues,
  observedAt: Date = new Date(),
): RiskSnapshot | null {
  if (positionData.size === 0n) return null;

  const markNotional = notionalFromMark(positionData.size, market.markPrice);
  const size = abs(positionData.size);
  const indexNotional = mulDivUp(size, market.indexPrice, WAD);
  const maintenanceMargin = mulDivUp(indexNotional, market.mmrBps, BPS);
  const effectiveMargin = marginRatioX18 === UINT256_MAX
    ? positionData.margin
    : (marginRatioX18 * markNotional) / WAD;
  const liquidationBuffer = effectiveMargin - maintenanceMargin;
  const coverageMultiple = maintenanceMargin === 0n
    ? Number.POSITIVE_INFINITY
    : Number((effectiveMargin * 1_000_000n) / maintenanceMargin) / 1_000_000;

  return {
    positionId: position.id,
    account: position.account,
    marketId: position.market_id,
    marketLabel: position.market_label,
    size: positionData.size,
    positionMargin: positionData.margin,
    effectiveMargin,
    maintenanceMargin,
    liquidationBuffer,
    coverageMultiple,
    marginRatioX18,
    mmrBps: market.mmrBps,
    markPrice: market.markPrice,
    indexPrice: market.indexPrice,
    markNotional,
    pendingFundingEstimate: null,
    isLiquidatable: liquidatable,
    observedAt,
  };
}

interface MarketAddresses {
  vamm: Address;
  oracle: Address;
}

let registryCache: { address: Address; expiresAt: number } | null = null;
const marketCache = new Map<string, { value: MarketAddresses; expiresAt: number }>();

async function getMarketRegistry(now: number): Promise<Address> {
  if (registryCache && registryCache.expiresAt > now) return registryCache.address;
  const address = await publicClient.readContract({
    address: env.CLEARING_HOUSE_ADDRESS as Address,
    abi: clearingHouseAbi,
    functionName: "marketRegistry",
  });
  registryCache = { address, expiresAt: now + MARKET_CACHE_TTL_MS };
  return address;
}

/** Market addresses (vAMM, oracle) from the MarketRegistry, cached for 10 minutes. */
async function getMarketAddresses(marketIds: Hex[], now = Date.now()): Promise<Map<string, MarketAddresses>> {
  const result = new Map<string, MarketAddresses>();
  const missing: Hex[] = [];
  for (const id of marketIds) {
    const cached = marketCache.get(id.toLowerCase());
    if (cached && cached.expiresAt > now) result.set(id.toLowerCase(), cached.value);
    else missing.push(id);
  }
  if (missing.length === 0) return result;

  const registry = await getMarketRegistry(now);
  const markets = await publicClient.multicall({
    contracts: missing.map((id) => ({
      address: registry,
      abi: marketRegistryAbi,
      functionName: "getMarket",
      args: [id],
    } as const)),
    allowFailure: false,
    batchSize: 0,
  });
  missing.forEach((id, index) => {
    const market = markets[index];
    if (!market) return;
    const value = { vamm: market.vamm, oracle: market.oracle };
    marketCache.set(id.toLowerCase(), { value, expiresAt: now + MARKET_CACHE_TTL_MS });
    result.set(id.toLowerCase(), value);
  });
  return result;
}

type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: Error };

function unwrap<T>(entry: CallResult | undefined, label: string): T {
  if (!entry) throw new Error(`Missing multicall result for ${label}`);
  if (entry.status === "failure") throw entry.error;
  return entry.result as T;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export type SnapshotResult = RiskSnapshot | null | Error;

/**
 * Reads risk snapshots for many positions with one eth_call (Multicall3) per chunk.
 * Each chunk contains the per-market values (risk params, oracle price, mark price) once per
 * market followed by getPosition/getMarginRatio/isLiquidatable for each position, so all values
 * used for one position come from the same block.
 */
export async function readRiskSnapshots(positions: ActivePosition[]): Promise<Map<string, SnapshotResult>> {
  const results = new Map<string, SnapshotResult>();
  if (positions.length === 0) return results;

  const clearingHouse = env.CLEARING_HOUSE_ADDRESS as Address;
  const marketIds = [...new Set(positions.map((p) => p.market_id.toLowerCase()))] as Hex[];
  let addresses: Map<string, MarketAddresses>;
  try {
    addresses = await getMarketAddresses(marketIds);
  } catch (error) {
    for (const position of positions) results.set(position.id, asError(error));
    return results;
  }

  // Sort by market so chunks touch as few markets as possible.
  const sorted = [...positions].sort((a, b) => a.market_id.localeCompare(b.market_id));
  const chunks: ActivePosition[][] = [];
  for (let i = 0; i < sorted.length; i += env.RISK_MULTICALL_CHUNK) {
    chunks.push(sorted.slice(i, i + env.RISK_MULTICALL_CHUNK));
  }

  await Promise.all(chunks.map(async (chunk) => {
    const chunkMarkets = [...new Set(chunk.map((p) => p.market_id.toLowerCase()))]
      .filter((id) => addresses.has(id));
    const contracts: unknown[] = [];
    for (const id of chunkMarkets) {
      const market = addresses.get(id)!;
      contracts.push(
        { address: clearingHouse, abi: clearingHouseAbi, functionName: "marketRiskParams", args: [id] },
        { address: market.oracle, abi: oracleAbi, functionName: "getPrice" },
        { address: market.vamm, abi: vammAbi, functionName: "getMarkPrice" },
      );
    }
    for (const position of chunk) {
      const args = [position.account, position.market_id];
      contracts.push(
        { address: clearingHouse, abi: clearingHouseAbi, functionName: "getPosition", args },
        { address: clearingHouse, abi: clearingHouseAbi, functionName: "getMarginRatio", args },
        { address: clearingHouse, abi: clearingHouseAbi, functionName: "isLiquidatable", args },
      );
    }

    let raw: CallResult[];
    try {
      raw = await publicClient.multicall({
        contracts: contracts as Parameters<typeof publicClient.multicall>[0]["contracts"],
        allowFailure: true,
        batchSize: 0,
      }) as CallResult[];
    } catch (error) {
      for (const position of chunk) results.set(position.id, asError(error));
      return;
    }

    const observedAt = new Date();
    const marketValues = new Map<string, MarketValues | Error>();
    chunkMarkets.forEach((id, index) => {
      try {
        const riskParams = unwrap<readonly bigint[]>(raw[index * 3], `marketRiskParams(${id})`);
        const mmrBps = riskParams[1];
        if (mmrBps === undefined) throw new Error(`Malformed marketRiskParams for ${id}`);
        marketValues.set(id, {
          mmrBps,
          indexPrice: unwrap<bigint>(raw[index * 3 + 1], `oracle.getPrice(${id})`),
          markPrice: unwrap<bigint>(raw[index * 3 + 2], `vamm.getMarkPrice(${id})`),
        });
      } catch (error) {
        marketValues.set(id, asError(error));
      }
    });

    const offset = chunkMarkets.length * 3;
    chunk.forEach((position, index) => {
      try {
        const market = marketValues.get(position.market_id.toLowerCase())
          ?? new Error(`Market ${position.market_id} is not available in the registry`);
        if (market instanceof Error) throw market;
        const base = offset + index * 3;
        const positionData = unwrap<PositionData>(raw[base], "getPosition");
        const marginRatioX18 = unwrap<bigint>(raw[base + 1], "getMarginRatio");
        const liquidatable = unwrap<boolean>(raw[base + 2], "isLiquidatable");
        results.set(position.id, buildRiskSnapshot(position, positionData, marginRatioX18, liquidatable, market, observedAt));
      } catch (error) {
        results.set(position.id, asError(error));
      }
    });
  }));

  return results;
}

export async function readRiskSnapshot(position: ActivePosition): Promise<RiskSnapshot | null> {
  const result = (await readRiskSnapshots([position])).get(position.id);
  if (result instanceof Error) throw result;
  return result ?? null;
}
