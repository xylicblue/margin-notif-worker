import type { Transport } from "viem";
import { logger } from "../config/logger.js";

/**
 * Counts JSON-RPC traffic so RPC usage can be compared before/after changes.
 * `requests` counts logical JSON-RPC calls by method (as issued by viem actions);
 * `httpRequests` counts actual HTTP round trips, including transport retries.
 */
export class RpcStats {
  private byMethod = new Map<string, number>();
  private httpRequests = 0;
  private errors = 0;
  private windowStartedAt = Date.now();
  private totalRequests = 0;

  record(method: string): void {
    this.byMethod.set(method, (this.byMethod.get(method) ?? 0) + 1);
    this.totalRequests += 1;
  }

  recordHttp(): void {
    this.httpRequests += 1;
  }

  recordError(): void {
    this.errors += 1;
  }

  snapshot(now = Date.now()): {
    windowMs: number;
    requests: number;
    httpRequests: number;
    errors: number;
    byMethod: Record<string, number>;
    perHour: number;
    totalRequestsSinceStart: number;
  } {
    const windowMs = Math.max(1, now - this.windowStartedAt);
    const requests = [...this.byMethod.values()].reduce((sum, count) => sum + count, 0);
    return {
      windowMs,
      requests,
      httpRequests: this.httpRequests,
      errors: this.errors,
      byMethod: Object.fromEntries([...this.byMethod.entries()].sort(([a], [b]) => a.localeCompare(b))),
      perHour: Math.round((requests * 3_600_000) / windowMs),
      totalRequestsSinceStart: this.totalRequests,
    };
  }

  reset(now = Date.now()): void {
    this.byMethod = new Map();
    this.httpRequests = 0;
    this.errors = 0;
    this.windowStartedAt = now;
  }
}

export const rpcStats = new RpcStats();

/** Wraps a viem transport so every request is counted in `stats`. */
export function countingTransport(inner: Transport, stats: RpcStats = rpcStats): Transport {
  return ((config) => {
    const transport = inner(config);
    const request = (async (args: { method: string; params?: unknown }, options?: unknown) => {
      stats.record(args.method);
      try {
        return await (transport.request as (a: unknown, o?: unknown) => Promise<unknown>)(args, options);
      } catch (error) {
        stats.recordError();
        throw error;
      }
    }) as typeof transport.request;
    return { ...transport, request };
  }) as Transport;
}

let timer: NodeJS.Timeout | null = null;

export function startRpcStatsLogging(intervalMs: number, stats: RpcStats = rpcStats): void {
  if (timer) return;
  timer = setInterval(() => {
    logger.info({ rpcStats: stats.snapshot() }, "RPC_STATS");
    stats.reset();
  }, intervalMs);
  timer.unref();
}

export function stopRpcStatsLogging(stats: RpcStats = rpcStats): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info({ rpcStats: stats.snapshot() }, "RPC_STATS");
}
