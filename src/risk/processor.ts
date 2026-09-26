import { readRiskSnapshot } from "../chain/client.js";
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
import { evaluateRisk, highestRisk, reminderDue, riskRank } from "./evaluator.js";
import type { ActivePosition, RiskEpisode, RiskLevel } from "../types.js";

export interface RiskPassResult {
  activePositions: number;
  evaluatedPositions: number;
  alertsEvaluated: number;
  failures: number;
}

async function processPosition(position: ActivePosition): Promise<boolean> {
  const snapshot = await readRiskSnapshot(position);
  const episode = await getOpenEpisode(position.id);

  if (!snapshot) {
    if (episode) {
      await updateEpisode(episode, {
        last_evaluated_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      });
    }
    await markPositionInactive(position.id);
    return false;
  }

  const evaluation = evaluateRisk(snapshot);
  await touchPosition(position.id, snapshot.size);

  if (evaluation.level === "healthy") {
    if (!episode) return false;
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
    return true;
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

  await updateEpisode(currentEpisode, {
    current_level: evaluation.level,
    highest_level: highestRisk(currentEpisode.highest_level, evaluation.level),
    last_evaluated_at: snapshot.observedAt.toISOString(),
    ...(shouldAlert ? { last_notified_at: snapshot.observedAt.toISOString() } : {}),
  });
  return shouldAlert;
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, action: (item: T) => Promise<boolean>): Promise<PromiseSettledResult<boolean>[]> {
  const results: PromiseSettledResult<boolean>[] = new Array(items.length);
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
  const results = await mapWithConcurrency(positions, env.RISK_READ_CONCURRENCY, processPosition);
  let failures = 0;
  let alertsEvaluated = 0;
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if (result?.status === "rejected") {
      failures += 1;
      logger.error({ err: result.reason, positionId: positions[index]?.id }, "Risk evaluation failed for position");
    } else if (result?.status === "fulfilled" && result.value) {
      alertsEvaluated += 1;
    }
  }
  return {
    activePositions: positions.length,
    evaluatedPositions: positions.length - failures,
    alertsEvaluated,
    failures,
  };
}
