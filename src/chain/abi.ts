import { parseAbi, parseAbiItem } from "viem";

export const clearingHouseAbi = parseAbi([
  "function marketRegistry() view returns (address)",
  "function getPosition(address account, bytes32 marketId) view returns ((int256 size, uint256 margin, uint256 entryPriceX18, uint256 lastFundingPayIndex, uint256 lastFundingReceiveIndex, int256 realizedPnL))",
  "function getMarginRatio(address account, bytes32 marketId) view returns (uint256)",
  "function getNotional(address account, bytes32 marketId) view returns (uint256)",
  "function isLiquidatable(address account, bytes32 marketId) view returns (bool)",
  "function marketRiskParams(bytes32 marketId) view returns (uint256 imrBps, uint256 mmrBps, uint256 liquidationPenaltyBps, uint256 penaltyCap, uint256 maxPositionSize, uint256 minPositionSize)",
]);

export const marketRegistryAbi = parseAbi([
  "function getMarket(bytes32 marketId) view returns ((address vamm, uint16 feeBps, bool paused, address oracle, address feeRouter, address insuranceFund, address baseAsset, address quoteToken, uint256 baseUnit))",
]);

export const oracleAbi = parseAbi([
  "function getPrice() view returns (uint256)",
]);

export const vammAbi = parseAbi([
  "function getMarkPrice() view returns (uint256)",
]);

export const tradeExecutedEvent = parseAbiItem(
  "event TradeExecuted(address indexed user, bytes32 indexed marketId, int256 baseDelta, int256 quoteDelta, uint256 executionPrice, int256 newSize, uint256 newMargin, int256 realizedPnL, uint256 fee)",
);

export const liquidationExecutedEvent = parseAbiItem(
  "event LiquidationExecuted(bytes32 indexed marketId, address indexed liquidator, address indexed account, uint128 size, uint256 notional, uint256 penalty, uint256 liquidatorReward, uint256 protocolFee, uint256 insurancePayout)",
);
