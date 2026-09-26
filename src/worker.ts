import { claimLease } from "./db/client.js";
import { writeHeartbeat } from "./db/repository.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { processDeliveryPass } from "./notifications/delivery.js";
import { publishLiquidationNotification } from "./notifications/service.js";
import { scanConfirmedEvents } from "./positions/event-scanner.js";
import { processRiskPass } from "./risk/processor.js";
import type { WorkerHealth } from "./types.js";

type TaskName = "lease" | "events" | "risk" | "delivery" | "heartbeat";

export class MarginNotificationWorker {
  readonly health: WorkerHealth = {
    startedAt: new Date().toISOString(),
    leader: false,
    ready: false,
    lastEventScanAt: null,
    lastRiskPassAt: null,
    lastDeliveryPassAt: null,
    lastHeartbeatAt: null,
    lastError: null,
    activePositions: 0,
    evaluatedPositions: 0,
  };

  private readonly timers: NodeJS.Timeout[] = [];
  private readonly running = new Set<TaskName>();
  private stopping = false;

  async start(): Promise<void> {
    await this.renewLease();
    if (this.health.leader) {
      await this.runEvents();
      await this.runRisk();
      await this.runDelivery();
    }
    this.health.ready = true;
    await this.runHeartbeat();

    this.schedule("lease", Math.max(5_000, Math.floor(env.WORKER_LEASE_SECONDS * 1_000 / 3)), () => this.renewLease());
    this.schedule("events", env.EVENT_SCAN_INTERVAL_MS, () => this.runEvents());
    this.schedule("risk", env.POLL_INTERVAL_MS, () => this.runRisk());
    this.schedule("delivery", env.DELIVERY_INTERVAL_MS, () => this.runDelivery());
    this.schedule("heartbeat", env.HEARTBEAT_INTERVAL_MS, () => this.runHeartbeat());

    logger.info({ instanceId: env.instanceId, deliveryMode: env.DELIVERY_MODE, leader: this.health.leader }, "Margin notification worker started");
  }

  async stop(): Promise<void> {
    this.stopping = true;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    this.health.ready = false;
    await this.runHeartbeat().catch(() => undefined);
    logger.info("Margin notification worker stopped");
  }

  private schedule(name: TaskName, interval: number, task: () => Promise<void>): void {
    const timer = setInterval(() => {
      if (this.stopping || this.running.has(name)) return;
      void task();
    }, interval);
    this.timers.push(timer);
  }

  private async guarded(name: TaskName, task: () => Promise<void>): Promise<void> {
    if (this.stopping || this.running.has(name)) return;
    this.running.add(name);
    try {
      await task();
      this.health.lastError = null;
    } catch (error) {
      this.health.lastError = error instanceof Error ? error.message : String(error);
      logger.error({ err: error, task: name }, "Worker task failed");
    } finally {
      this.running.delete(name);
    }
  }

  private async renewLease(): Promise<void> {
    await this.guarded("lease", async () => {
      this.health.leader = await claimLease(env.instanceId, env.WORKER_LEASE_SECONDS);
    });
  }

  private async runEvents(): Promise<void> {
    await this.guarded("events", async () => {
      if (!this.health.leader) return;
      const result = await scanConfirmedEvents();
      if (result) {
        for (const notice of result.liquidationNotices) {
          await publishLiquidationNotification(notice);
        }
        logger.info({
          fromBlock: result.fromBlock.toString(),
          toBlock: result.toBlock.toString(),
          trades: result.tradeEvents,
          liquidations: result.liquidationEvents,
          bootstrapped: result.bootstrapped,
        }, "Confirmed event scan completed");
      }
      this.health.lastEventScanAt = new Date().toISOString();
    });
  }

  private async runRisk(): Promise<void> {
    await this.guarded("risk", async () => {
      if (!this.health.leader) return;
      const result = await processRiskPass();
      this.health.activePositions = result.activePositions;
      this.health.evaluatedPositions = result.evaluatedPositions;
      this.health.lastRiskPassAt = new Date().toISOString();
      logger.info(result, "Margin risk pass completed");
    });
  }

  private async runDelivery(): Promise<void> {
    await this.guarded("delivery", async () => {
      if (!this.health.leader) return;
      const result = await processDeliveryPass();
      this.health.lastDeliveryPassAt = new Date().toISOString();
      if (result.due > 0) logger.info(result, "Notification delivery pass completed");
    });
  }

  private async runHeartbeat(): Promise<void> {
    await this.guarded("heartbeat", async () => {
      await writeHeartbeat({
        isLeader: this.health.leader,
        ready: this.health.ready,
        activePositions: this.health.activePositions,
        evaluatedPositions: this.health.evaluatedPositions,
        lastEventScanAt: this.health.lastEventScanAt,
        lastRiskPassAt: this.health.lastRiskPassAt,
        lastDeliveryPassAt: this.health.lastDeliveryPassAt,
        lastError: this.health.lastError,
      });
      this.health.lastHeartbeatAt = new Date().toISOString();
    });
  }
}
