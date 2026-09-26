import { createPublicClient, defineChain, http, type Address } from "viem";
import { env } from "../config/env.js";
import type { ActivePosition, RiskSnapshot } from "../types.js";
import { clearingHouseAbi, marketRegistryAbi, oracleAbi, vammAbi } from "./abi.js";

const WAD = 10n ** 18n;
const BPS = 10_000n;

const monitoredChain = defineChain({
  id: env.CHAIN_ID,
  name: `ByteStrike monitored chain ${env.CHAIN_ID}`,
  nativeCurrency: { name: "Native", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [env.RPC_URL] } },
});

export const publicClient = createPublicClient({
  chain: monitoredChain,
  transport: http(env.RPC_URL, { timeout: 15_000, retryCount: 2, retryDelay: 500 }),
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

export async function readRiskSnapshot(position: ActivePosition): Promise<RiskSnapshot | null> {
  const clearingHouse = env.CLEARING_HOUSE_ADDRESS as Address;
  const [positionData, marginRatioX18, markNotional, liquidatable, riskParams, registry] = await Promise.all([
    publicClient.readContract({
      address: clearingHouse,
      abi: clearingHouseAbi,
      functionName: "getPosition",
      args: [position.account, position.market_id],
    }),
    publicClient.readContract({
      address: clearingHouse,
      abi: clearingHouseAbi,
      functionName: "getMarginRatio",
      args: [position.account, position.market_id],
    }),
    publicClient.readContract({
      address: clearingHouse,
      abi: clearingHouseAbi,
      functionName: "getNotional",
      args: [position.account, position.market_id],
    }),
    publicClient.readContract({
      address: clearingHouse,
      abi: clearingHouseAbi,
      functionName: "isLiquidatable",
      args: [position.account, position.market_id],
    }),
    publicClient.readContract({
      address: clearingHouse,
      abi: clearingHouseAbi,
      functionName: "marketRiskParams",
      args: [position.market_id],
    }),
    publicClient.readContract({
      address: clearingHouse,
      abi: clearingHouseAbi,
      functionName: "marketRegistry",
    }),
  ]);

  if (positionData.size === 0n) return null;

  const market = await publicClient.readContract({
    address: registry,
    abi: marketRegistryAbi,
    functionName: "getMarket",
    args: [position.market_id],
  });

  const [indexPrice, markPrice] = await Promise.all([
    publicClient.readContract({ address: market.oracle, abi: oracleAbi, functionName: "getPrice" }),
    publicClient.readContract({ address: market.vamm, abi: vammAbi, functionName: "getMarkPrice" }),
  ]);

  const size = abs(positionData.size);
  const indexNotional = mulDivUp(size, indexPrice, WAD);
  const maintenanceMargin = mulDivUp(indexNotional, riskParams[1], BPS);
  const effectiveMargin = marginRatioX18 === (2n ** 256n - 1n)
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
    mmrBps: riskParams[1],
    markPrice,
    indexPrice,
    markNotional,
    pendingFundingEstimate: null,
    isLiquidatable: liquidatable,
    observedAt: new Date(),
  };
}
