import type { Address, Hex } from "viem";
import { env } from "../config/env.js";
import { createTraderNotification, enqueueExternalDeliveries } from "../db/repository.js";
import type { LiquidationNotice, RiskEvaluation } from "../types.js";
import { buildLiquidationNotification, buildRecoveryNotification, buildRiskNotification } from "./templates.js";

export async function publishRiskNotification(input: {
  evaluation: RiskEvaluation;
  observationId: string;
  episodeId: string;
  idempotencyKey: string;
}): Promise<string | null> {
  if (env.DELIVERY_MODE === "shadow") return null;
  const snapshot = input.evaluation.snapshot;
  const notificationId = await createTraderNotification({
    account: snapshot.account,
    marketId: snapshot.marketId,
    marketLabel: snapshot.marketLabel,
    content: buildRiskNotification(input.evaluation),
    idempotencyKey: input.idempotencyKey,
    observationId: input.observationId,
    episodeId: input.episodeId,
  });
  await enqueueExternalDeliveries(notificationId, snapshot.account, input.idempotencyKey);
  return notificationId;
}

export async function publishRecoveryNotification(input: {
  evaluation: RiskEvaluation;
  previousLevel: Exclude<import("../types.js").RiskLevel, "healthy">;
  observationId: string;
  episodeId: string;
  idempotencyKey: string;
}): Promise<string | null> {
  if (env.DELIVERY_MODE === "shadow") return null;
  const snapshot = input.evaluation.snapshot;
  const notificationId = await createTraderNotification({
    account: snapshot.account,
    marketId: snapshot.marketId,
    marketLabel: snapshot.marketLabel,
    content: buildRecoveryNotification(snapshot.marketLabel, input.previousLevel, input.evaluation),
    idempotencyKey: input.idempotencyKey,
    observationId: input.observationId,
    episodeId: input.episodeId,
  });
  await enqueueExternalDeliveries(notificationId, snapshot.account, input.idempotencyKey);
  return notificationId;
}

export async function publishLiquidationNotification(notice: LiquidationNotice): Promise<string | null> {
  if (env.DELIVERY_MODE === "shadow") return null;
  const idempotencyKey = `liquidation:${env.CHAIN_ID}:${notice.transactionHash.toLowerCase()}:${notice.logIndex}`;
  const notificationId = await createTraderNotification({
    account: notice.account,
    marketId: notice.marketId,
    marketLabel: notice.marketLabel,
    content: buildLiquidationNotification(notice),
    idempotencyKey,
    txHash: notice.transactionHash,
  });
  await enqueueExternalDeliveries(notificationId, notice.account, idempotencyKey);
  return notificationId;
}

export function riskAlertKey(episodeId: string, evaluation: RiskEvaluation, now = Date.now()): string {
  const code = evaluation.code ?? "unknown";
  const bucketSeconds = evaluation.level === "warning"
    ? env.A1_REMINDER_SECONDS
    : evaluation.level === "danger"
      ? env.A2_REMINDER_SECONDS
      : env.A3_REMINDER_SECONDS;
  return `risk:${episodeId}:${code}:${evaluation.level}:${Math.floor(now / (bucketSeconds * 1_000))}`;
}

export function recoveryKey(episodeId: string): string {
  return `risk:${episodeId}:A0`;
}

export type NotificationIdentity = { account: Address; marketId: Hex };
