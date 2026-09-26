import "dotenv/config";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { DeliveryMode, MarketConfig } from "../types.js";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const schema = z.object({
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().int().positive(),
  CLEARING_HOUSE_ADDRESS: address,
  DEPLOYMENT_BLOCK: z.coerce.number().int().nonnegative(),
  MARKETS_JSON: z.string().min(2),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  DELIVERY_MODE: z.enum(["shadow", "in_app", "all"]).default("shadow"),
  POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  EVENT_SCAN_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),
  DELIVERY_INTERVAL_MS: z.coerce.number().int().min(500).default(2_000),
  DELIVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  DELIVERY_RETRY_BASE_SECONDS: z.coerce.number().int().min(5).max(3_600).default(30),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(10_000).default(60_000),
  BLOCK_CONFIRMATIONS: z.coerce.number().int().nonnegative().default(2),
  EVENT_CHUNK_SIZE: z.coerce.number().int().min(100).max(20_000).default(2_000),
  MAX_POSITION_BATCH: z.coerce.number().int().min(1).max(5_000).default(250),
  RISK_READ_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(20),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(10).max(300).default(30),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8080),
  WARNING_MULTIPLIER: z.coerce.number().min(1.1).max(5).default(2),
  DANGER_MULTIPLIER: z.coerce.number().min(1.05).max(4).default(1.5),
  NEAR_LIQUIDATION_MULTIPLIER: z.coerce.number().min(1).max(2).default(1.1),
  A1_REMINDER_SECONDS: z.coerce.number().int().min(30).default(300),
  A2_REMINDER_SECONDS: z.coerce.number().int().min(15).default(120),
  A3_REMINDER_SECONDS: z.coerce.number().int().min(10).default(30),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("ByteStrike <notifications@bytestrike.xyz>"),
  APP_URL: z.string().url().default("https://bytestrike.xyz"),
  VAPID_SUBJECT: z.string().default("mailto:security@bytestrike.com"),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  WORKER_INSTANCE_ID: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
}

function parseMarkets(value: string): MarketConfig[] {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new Error("MARKETS_JSON must be valid JSON");
  }
  const result = z.array(z.object({
    id: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    label: z.string().trim().min(1).max(100),
  })).min(1).parse(raw);
  const seen = new Set<string>();
  return result.map((market) => {
    const id = market.id.toLowerCase();
    if (seen.has(id)) throw new Error(`Duplicate market ID in MARKETS_JSON: ${id}`);
    seen.add(id);
    return { id: id as MarketConfig["id"], label: market.label };
  });
}

if (!(parsed.data.WARNING_MULTIPLIER > parsed.data.DANGER_MULTIPLIER
  && parsed.data.DANGER_MULTIPLIER > parsed.data.NEAR_LIQUIDATION_MULTIPLIER
  && parsed.data.NEAR_LIQUIDATION_MULTIPLIER >= 1)) {
  throw new Error("Warning multipliers must satisfy WARNING > DANGER > NEAR_LIQUIDATION >= 1");
}

export const env = {
  ...parsed.data,
  DELIVERY_MODE: parsed.data.DELIVERY_MODE as DeliveryMode,
  CLEARING_HOUSE_ADDRESS: parsed.data.CLEARING_HOUSE_ADDRESS as `0x${string}`,
  markets: parseMarkets(parsed.data.MARKETS_JSON),
  instanceId: parsed.data.WORKER_INSTANCE_ID ?? randomUUID(),
};
