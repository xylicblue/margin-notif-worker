import { createServer } from "node:http";
import { assertDatabaseReady } from "./db/client.js";
import { env } from "./config/env.js";
import { logger } from "./config/logger.js";
import { MarginNotificationWorker } from "./worker.js";

const worker = new MarginNotificationWorker();

const server = createServer((request, response) => {
  if (request.method === "GET" && (request.url === "/healthz" || request.url === "/readyz")) {
    const ready = worker.health.ready;
    const status = request.url === "/readyz" && !ready ? 503 : 200;
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({
      ok: status === 200,
      service: "margin-notification-worker",
      deliveryMode: env.DELIVERY_MODE,
      ...worker.health,
    }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "not_found" }));
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutdown requested");
  server.close();
  await worker.stop();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

process.on("unhandledRejection", (error) => {
  logger.fatal({ err: error }, "Unhandled promise rejection");
});

async function main(): Promise<void> {
  await assertDatabaseReady();
  server.listen(env.PORT, "0.0.0.0", () => {
    logger.info({ port: env.PORT }, "Health server listening");
  });
  await worker.start();
}

main().catch((error) => {
  logger.fatal({ err: error }, "Worker failed to start");
  process.exit(1);
});
