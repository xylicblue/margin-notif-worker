import { readRiskSnapshots, type SnapshotResult } from "../chain/client.js";
import { logger } from "../config/logger.js";
import { env } from "../config/env.js";
import {
  createEpisode,
  getOpenEpisode,
  insertObservation,
  listActivePositions,
  markPositionInactive,
  touchPosition,
  updateEpisode,
} from "../db/repository.js";
import { publishRecoveryNotification, publishRiskNotification, recoveryKey, riskAlertKey } from "../notifications/service.js";
import { configuredThresholds, evaluateRisk, highestRisk, reminderDue, riskRank } from "./evaluator.js";
import { RiskScheduler } from "./schedule.js";
import type { ActivePosition, RiskEpisode, RiskEvaluation, RiskLevel } from "../types.js";

export interface RiskPassResult {
  activePositions: number;
  evaluatedPositions: number;
  skippedHealthy: number;
  alertsEvaluated: number;
  failures: number;
}

export const riskScheduler = new RiskScheduler({
  healthyRecheckMs: env.HEALTHY_RECHECK_MS,
  nearCoverage: configuredThresholds.warning * (1 + env.RISK_NEAR_BUFFER),
});

/** Mark positions touched by new events so they are re-read on the next risk tick. */
export function markPositionsTouched(keys: Iterable<string>): void {
  for (const key of keys) riskScheduler.markTouched(key);
}

function olderThan(timestamp: string | null, ms: number, now: number): boolean {
  if (!timestamp) return true;
  const parsed = new Date(timestamp).getTime();
  return Number.isNaN(parsed) || now - parsed >= ms;
}

/**
 * last_size / last_reconciled_at are written only when the on-chain size differs from the stored
 * one, or when the stored reconciliation is older than HEALTHY_RECHECK_MS (this also keeps the
 * last_reconciled_at-ordered batch rotation working when there are more than MAX_POSITION_BATCH rows).
 */
export function shouldTouchPosition(position: Pick<ActivePosition, "last_size" | "last_reconciled_at">, size: bigint, now: number, recheckMs = env.HEALTHY_RECHECK_MS): boolean {
  let stored: bigint | null = null;
  try {
    stored = BigInt(String(position.last_size));
  } catch {
    stored = null;
  }
  if (stored !== size) return true;
  return olderThan(position.last_reconciled_at, recheckMs, now);
}

interface Outcome {
  alerted: boolean;
  evaluation: RiskEvaluation | null;
}

async function processPosition(position: ActivePosition, snapshot: Exclude<SnapshotResult, Error>): Promise<Outcome> {
  const episode = await getOpenEpisode(position.id);

  if (!snapshot) {
    if (episode) {
      await updateEpisode(episode, {
        last_evaluated_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      });
    }
    await markPositionInactive(position.id);
    return { alerted: false, evaluation: null };
  }

  const evaluation = evaluateRisk(snapshot);
  if (shouldTouchPosition(position, snapshot.size, snapshot.observedAt.getTime())) {
    await touchPosition(position.id, snapshot.size);
  }

  if (evaluation.level === "healthy") {
    if (!episode) return { alerted: false, evaluation };
    const prior = episode.current_level as Exclude<RiskLevel, "healthy">;
    const observationId = await insertObservation(evaluation, episode.id, prior, "A0");
    await publishRecoveryNotification({
      evaluation,
      previousLevel: prior,
      observationId,
      episodeId: episode.id,
      idempotencyKey: recoveryKey(episode.id),
    });
    await updateEpisode(episode, {
      last_evaluated_at: snapshot.observedAt.toISOString(),
      ended_at: snapshot.observedAt.toISOString(),
    });
    return { alerted: true, evaluation };
  }

  let currentEpisode: RiskEpisode;
  let newlyCreated = false;
  if (episode) {
    currentEpisode = episode;
  } else {
    currentEpisode = await createEpisode(position.id, evaluation.level, snapshot.observedAt);
    newlyCreated = true;
  }

  const escalated = riskRank(evaluation.level) > riskRank(currentEpisode.current_level);
  const shouldAlert = newlyCreated || escalated
    || (evaluation.level === currentEpisode.current_level
      && reminderDue(evaluation.level, currentEpisode.last_notified_at, snapshot.observedAt.getTime()));

  if (shouldAlert && evaluation.code) {
    const idempotencyKey = riskAlertKey(currentEpisode.id, evaluation, snapshot.observedAt.getTime());
    const observationId = await insertObservation(
      evaluation,
      currentEpisode.id,
      newlyCreated ? "healthy" : currentEpisode.current_level,
      evaluation.code,
    );
    await publishRiskNotification({
      evaluation,
      observationId,
      episodeId: currentEpisode.id,
      idempotencyKey,
    });
  }

  const highestLevel = highestRisk(currentEpisode.highest_level, evaluation.level);
  // Skip the write when nothing but last_evaluated_at would change and it was refreshed recently.
  const episodeChanged = newlyCreated
    || shouldAlert
    || evaluation.level !== currentEpisode.current_level
    || highestLevel !== currentEpisode.highest_level
    || olderThan(currentEpisode.last_evaluated_at, env.HEALTHY_RECHECK_MS, snapshot.observedAt.getTime());
  if (episodeChanged) {
    await updateEpisode(currentEpisode, {
      current_level: evaluation.level,
      highest_level: highestLevel,
      last_evaluated_at: snapshot.observedAt.toISOString(),
      ...(shouldAlert ? { last_notified_at: snapshot.observedAt.toISOString() } : {}),
    });
  }
  return { alerted: shouldAlert, evaluation };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, action: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = { status: "fulfilled", value: await action(item) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function processRiskPass(): Promise<RiskPassResult> {
  const positions = await listActivePositions();
  const startedAt = Date.now();
  riskScheduler.retain(positions);
  const due = positions.filter((position) => riskScheduler.isDue(position, startedAt));
  const snapshots = await readRiskSnapshots(due);

  const results = await mapWithConcurrency(due, env.RISK_READ_CONCURRENCY, async (position) => {
    const snapshot = snapshots.get(position.id);
    if (snapshot === undefined) throw new Error("No risk snapshot was read for position");
    if (snapshot instanceof Error) throw snapshot;
    return processPosition(position, snapshot);
  });

  let failures = 0;
  let alertsEvaluated = 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    const position = due[index];
    if (!position) continue;
    if (result?.status === "rejected") {
      failures += 1;
      riskScheduler.forget(position);
      logger.error({ err: result.reason, positionId: position.id }, "Risk evaluation failed for position");
    } else if (result?.status === "fulfilled") {
      const { alerted, evaluation } = result.value;
      if (alerted) alertsEvaluated += 1;
      if (evaluation) {
        riskScheduler.recordEvaluated(position, startedAt, evaluation.level, evaluation.snapshot.coverageMultiple);
      } else {
        riskScheduler.forget(position, true);
      }
    }
  }
  return {
    activePositions: positions.length,
    evaluatedPositions: due.length - failures,
    skippedHealthy: positions.length - due.length,
    alertsEvaluated,
    failures,
  };
}
