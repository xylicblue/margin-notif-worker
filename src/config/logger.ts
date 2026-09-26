import pino from "pino";
import { env } from "./env.js";

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: "margin-notification-worker", instance: env.instanceId },
  redact: {
    paths: ["SUPABASE_SERVICE_ROLE_KEY", "RESEND_API_KEY", "VAPID_PRIVATE_KEY", "authorization"],
    censor: "[REDACTED]",
  },
});
