import type { Address, Hex } from "viem";
import { env } from "../config/env.js";
import type {
  ActivePosition,
  RiskEpisode,
  RiskEvaluation,
  RiskLevel,
} from "../types.js";
import type { NotificationContent } from "../notifications/templates.js";
import { supabase } from "./client.js";

export interface OutboxItem {
  id: string;
  notification_id: string;
  channel: "email" | "web_push";
  destination: Record<string, unknown>;
  idempotency_key: string;
  status: "pending" | "sending" | "failed";
  attempt_count: number;
}

export interface StoredNotification {
  id: string;
  title: string;
  body: string;
  priority: string;
  market_label: string | null;
  actions: Array<{ label: string; href: string }>;
  data: Record<string, unknown>;
}

export async function upsertPosition(input: {
  account: Address;
  marketId: Hex;
  marketLabel: string;
  newSize: bigint;
  blockNumber: bigint;
  txHash: Hex;
}): Promise<void> {
  const { error } = await supabase.rpc("upsert_margin_active_position", {
    p_chain_id: env.CHAIN_ID,
    p_account: input.account.toLowerCase(),
    p_market_id: input.marketId.toLowerCase(),
    p_market_label: input.marketLabel,
    p_last_size: input.newSize.toString(),
    p_block_number: input.blockNumber.toString(),
    p_tx_hash: input.txHash,
  });
  if (error) throw new Error(`Unable to upsert active position: ${error.message}`);
}

export async function listActivePositions(limit = env.MAX_POSITION_BATCH): Promise<ActivePosition[]> {
  const { data, error } = await supabase
    .from("margin_active_positions")
    .select("id,chain_id,account,market_id,market_label,last_size,first_seen_block,last_seen_block,active,last_reconciled_at")
    .eq("chain_id", env.CHAIN_ID)
    .eq("active", true)
    .order("last_reconciled_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`Unable to list active positions: ${error.message}`);
  return (data ?? []) as ActivePosition[];
}

export async function markPositionInactive(positionId: string): Promise<void> {
  const { error } = await supabase.from("margin_active_positions").update({
    active: false,
    last_size: "0",
    last_reconciled_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", positionId);
  if (error) throw new Error(`Unable to deactivate position: ${error.message}`);
}

export async function touchPosition(positionId: string, size: bigint): Promise<void> {
  const { error } = await supabase.from("margin_active_positions").update({
    last_size: size.toString(),
    last_reconciled_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq("id", positionId);
  if (error) throw new Error(`Unable to reconcile position: ${error.message}`);
}

export async function getOpenEpisode(positionId: string): Promise<RiskEpisode | null> {
  const { data, error } = await supabase
    .from("margin_risk_episodes")
    .select("id,position_id,current_level,highest_level,started_at,last_evaluated_at,last_notified_at,ended_at")
    .eq("position_id", positionId)
    .is("ended_at", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Unable to read risk episode: ${error.message}`);
  return data as RiskEpisode | null;
}

export async function createEpisode(positionId: string, level: RiskLevel, observedAt: Date): Promise<RiskEpisode> {
  const timestamp = observedAt.toISOString();
  const { data, error } = await supabase.from("margin_risk_episodes").insert({
    position_id: positionId,
    current_level: level,
    highest_level: level,
    started_at: timestamp,
    last_evaluated_at: timestamp,
  }).select("id,position_id,current_level,highest_level,started_at,last_evaluated_at,last_notified_at,ended_at").single();
  if (error) throw new Error(`Unable to create risk episode: ${error.message}`);
  return data as RiskEpisode;
}

export async function updateEpisode(
  episode: RiskEpisode,
  values: Partial<Pick<RiskEpisode, "current_level" | "highest_level" | "last_evaluated_at" | "last_notified_at" | "ended_at">>,
): Promise<void> {
  const { error } = await supabase.from("margin_risk_episodes").update(values).eq("id", episode.id);
  if (error) throw new Error(`Unable to update risk episode: ${error.message}`);
}

export async function insertObservation(
  evaluation: RiskEvaluation,
  episodeId: string | null,
  previousLevel: RiskLevel,
  notificationCode: string | null,
): Promise<string> {
  const s = evaluation.snapshot;
  const { data, error } = await supabase.from("margin_risk_observations").insert({
    position_id: s.positionId,
    episode_id: episodeId,
    previous_level: previousLevel,
    risk_level: evaluation.level,
    notification_code: notificationCode,
    effective_margin: s.effectiveMargin.toString(),
    maintenance_margin: s.maintenanceMargin.toString(),
    liquidation_buffer: s.liquidationBuffer.toString(),
    coverage_multiple: Number.isFinite(s.coverageMultiple) ? s.coverageMultiple : null,
    margin_ratio_x18: s.marginRatioX18.toString(),
    mmr_bps: Number(s.mmrBps),
    mark_price_x18: s.markPrice.toString(),
    index_price_x18: s.indexPrice.toString(),
    is_liquidatable: s.isLiquidatable,
    delivery_mode: env.DELIVERY_MODE,
    observed_at: s.observedAt.toISOString(),
  }).select("id").single();
  if (error) throw new Error(`Unable to insert risk observation: ${error.message}`);
  return data.id as string;
}

export async function createTraderNotification(input: {
  account: Address;
  marketId: Hex;
  marketLabel: string;
  content: NotificationContent;
  idempotencyKey: string;
  observationId?: string;
  episodeId?: string;
  txHash?: Hex;
}): Promise<string> {
  const row = {
    user_id: input.account.toLowerCase(),
    category: input.content.category,
    code: input.content.code,
    priority: input.content.priority,
    market_id: input.marketId.toLowerCase(),
    market_label: input.marketLabel,
    title: input.content.title,
    body: input.content.body,
    data: input.content.data,
    actions: input.content.actions,
    status: "unread",
    tx_hash: input.txHash ?? null,
    idempotency_key: input.idempotencyKey,
    risk_observation_id: input.observationId ?? null,
    risk_episode_id: input.episodeId ?? null,
  };

  const { data, error } = await supabase
    .from("trader_notifications")
    .upsert(row, { onConflict: "idempotency_key", ignoreDuplicates: true })
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`Unable to create trader notification: ${error.message}`);
  if (data?.id) return data.id as string;

  const { data: existing, error: existingError } = await supabase
    .from("trader_notifications")
    .select("id")
    .eq("idempotency_key", input.idempotencyKey)
    .single();
  if (existingError) throw new Error(`Unable to resolve trader notification: ${existingError.message}`);
  return existing.id as string;
}

export async function enqueueExternalDeliveries(notificationId: string, account: Address, key: string): Promise<void> {
  if (env.DELIVERY_MODE !== "all") return;

  const { data: prefs, error } = await supabase
    .from("notification_preferences")
    .select("cat_margin_enabled,cat_liquidation_enabled,email_enabled,email_address,push_enabled,push_subscription")
    .eq("user_id", account.toLowerCase())
    .maybeSingle();
  if (error) throw new Error(`Unable to read notification preferences: ${error.message}`);
  if (!prefs) return;
  if (key.startsWith("risk:") && !prefs.cat_margin_enabled) return;
  if (key.startsWith("liquidation:") && !prefs.cat_liquidation_enabled) return;

  const rows: Array<Record<string, unknown>> = [];
  if (prefs.email_enabled && prefs.email_address) {
    rows.push({
      notification_id: notificationId,
      channel: "email",
      destination: { email: prefs.email_address },
      idempotency_key: `${key}:email`,
    });
  }
  if (prefs.push_enabled && prefs.push_subscription) {
    rows.push({
      notification_id: notificationId,
      channel: "web_push",
      destination: prefs.push_subscription,
      idempotency_key: `${key}:web_push`,
    });
  }
  if (rows.length === 0) return;

  const { error: outboxError } = await supabase
    .from("margin_notification_outbox")
    .upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true });
  if (outboxError) throw new Error(`Unable to enqueue notification delivery: ${outboxError.message}`);
}

export async function listDueOutbox(limit = 50): Promise<OutboxItem[]> {
  const staleCutoff = new Date(Date.now() - 5 * 60_000).toISOString();
  const { error: recoveryError } = await supabase
    .from("margin_notification_outbox")
    .update({
      status: "failed",
      next_attempt_at: new Date().toISOString(),
      last_error: "Recovered stale delivery lock after worker interruption",
      updated_at: new Date().toISOString(),
    })
    .eq("status", "sending")
    .lt("locked_at", staleCutoff);
  if (recoveryError) throw new Error(`Unable to recover stale outbox locks: ${recoveryError.message}`);

  const { data, error } = await supabase
    .from("margin_notification_outbox")
    .select("id,notification_id,channel,destination,idempotency_key,status,attempt_count")
    .in("status", ["pending", "failed"])
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(`Unable to list notification outbox: ${error.message}`);
  return (data ?? []) as OutboxItem[];
}

export async function claimOutboxItem(item: OutboxItem): Promise<OutboxItem | null> {
  const { data, error } = await supabase
    .from("margin_notification_outbox")
    .update({
      status: "sending",
      attempt_count: item.attempt_count + 1,
      locked_at: new Date().toISOString(),
      locked_by: env.instanceId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", item.id)
    .in("status", ["pending", "failed"])
    .select("id,notification_id,channel,destination,idempotency_key,status,attempt_count")
    .maybeSingle();
  if (error) throw new Error(`Unable to claim outbox item: ${error.message}`);
  return data as OutboxItem | null;
}

export async function getStoredNotification(id: string): Promise<StoredNotification> {
  const { data, error } = await supabase
    .from("trader_notifications")
    .select("id,title,body,priority,market_label,actions,data")
    .eq("id", id)
    .single();
  if (error) throw new Error(`Unable to load notification ${id}: ${error.message}`);
  return data as StoredNotification;
}

export async function recordDelivery(input: {
  item: OutboxItem;
  success: boolean;
  providerMessageId?: string;
  responseStatus?: number;
  errorMessage?: string;
}): Promise<void> {
  const row = {
    outbox_id: input.item.id,
    channel: input.item.channel,
    attempt: input.item.attempt_count,
    success: input.success,
    provider_message_id: input.providerMessageId ?? null,
    response_status: input.responseStatus ?? null,
    error_message: input.errorMessage?.slice(0, 2_000) ?? null,
  };
  const { error } = await supabase.from("margin_notification_deliveries").insert(row);
  if (error) throw new Error(`Unable to record delivery attempt: ${error.message}`);
}

export async function markOutboxSent(item: OutboxItem): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await supabase.from("margin_notification_outbox").update({
    status: "sent",
    sent_at: now,
    updated_at: now,
    last_error: null,
  }).eq("id", item.id).eq("locked_by", env.instanceId);
  if (error) throw new Error(`Unable to mark outbox item sent: ${error.message}`);
}

export async function markOutboxFailed(item: OutboxItem, message: string, permanent = false): Promise<void> {
  const terminal = permanent || item.attempt_count >= env.DELIVERY_MAX_ATTEMPTS;
  const delaySeconds = env.DELIVERY_RETRY_BASE_SECONDS * (2 ** Math.max(0, item.attempt_count - 1));
  const { error } = await supabase.from("margin_notification_outbox").update({
    status: terminal ? "dead" : "failed",
    next_attempt_at: new Date(Date.now() + delaySeconds * 1_000).toISOString(),
    last_error: message.slice(0, 2_000),
    updated_at: new Date().toISOString(),
  }).eq("id", item.id).eq("locked_by", env.instanceId);
  if (error) throw new Error(`Unable to mark outbox item failed: ${error.message}`);
}

export async function writeHeartbeat(input: {
  isLeader: boolean;
  ready: boolean;
  activePositions: number;
  evaluatedPositions: number;
  lastEventScanAt: string | null;
  lastRiskPassAt: string | null;
  lastDeliveryPassAt: string | null;
  lastError: string | null;
}): Promise<void> {
  const { error } = await supabase.from("margin_worker_heartbeats").upsert({
    instance_id: env.instanceId,
    delivery_mode: env.DELIVERY_MODE,
    is_leader: input.isLeader,
    ready: input.ready,
    active_positions: input.activePositions,
    evaluated_positions: input.evaluatedPositions,
    last_event_scan_at: input.lastEventScanAt,
    last_risk_pass_at: input.lastRiskPassAt,
    last_delivery_pass_at: input.lastDeliveryPassAt,
    last_error: input.lastError,
    updated_at: new Date().toISOString(),
  }, { onConflict: "instance_id" });
  if (error) throw new Error(`Unable to write worker heartbeat: ${error.message}`);
}
