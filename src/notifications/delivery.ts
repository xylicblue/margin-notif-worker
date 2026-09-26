import webPush from "web-push";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import {
  claimOutboxItem,
  getStoredNotification,
  listDueOutbox,
  markOutboxFailed,
  markOutboxSent,
  recordDelivery,
  type OutboxItem,
  type StoredNotification,
} from "../db/repository.js";

if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
  webPush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character] ?? character);
}

function emailHtml(notification: StoredNotification): string {
  const action = notification.actions[0];
  const actionUrl = action ? new URL(action.href, env.APP_URL).toString() : env.APP_URL;
  const actionLabel = action?.label ?? "Open ByteStrike";
  return `<!doctype html><html><body style="margin:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#1d1d1f"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 18px"><table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #e5e5e7;border-radius:18px;overflow:hidden"><tr><td style="padding:24px 30px;border-bottom:1px solid #eeeeef;font-size:15px;font-weight:700">ByteStrike Risk Monitoring</td></tr><tr><td style="padding:32px 30px"><p style="margin:0 0 9px;color:#6e6e73;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.6px">Margin notification</p><h1 style="margin:0 0 12px;font-size:25px;line-height:1.25">${escapeHtml(notification.title)}</h1><p style="margin:0 0 24px;color:#515154;font-size:14px;line-height:1.65">${escapeHtml(notification.body)}</p><a href="${escapeHtml(actionUrl)}" style="display:inline-block;padding:12px 18px;border-radius:10px;background:#111113;color:#fff;text-decoration:none;font-size:13px;font-weight:650">${escapeHtml(actionLabel)}</a><p style="margin:22px 0 0;color:#86868b;font-size:11px;line-height:1.6">Automated warnings do not guarantee that liquidation can be avoided. Monitor your position and collateral directly.</p></td></tr></table></td></tr></table></body></html>`;
}

async function sendEmail(item: OutboxItem, notification: StoredNotification): Promise<{ id: string; status: number }> {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
  const email = item.destination.email;
  if (typeof email !== "string" || !email.includes("@")) throw new Error("Outbox email destination is invalid");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": item.idempotency_key,
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: notification.title,
      html: emailHtml(notification),
    }),
  });
  const body = await response.json().catch(() => ({})) as { id?: string; message?: string };
  if (!response.ok) throw Object.assign(new Error(body.message ?? `Email provider returned ${response.status}`), { statusCode: response.status });
  return { id: body.id ?? "accepted", status: response.status };
}

async function sendPush(item: OutboxItem, notification: StoredNotification): Promise<{ id: string; status: number }> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error("VAPID keys are not configured");
  const subscription = item.destination as unknown as webPush.PushSubscription;
  if (typeof subscription.endpoint !== "string") throw new Error("Web Push subscription is invalid");
  const action = notification.actions[0];
  const response = await webPush.sendNotification(subscription, JSON.stringify({
    title: notification.title,
    body: notification.body,
    data: { url: action ? new URL(action.href, env.APP_URL).toString() : env.APP_URL },
  }), { TTL: 60, urgency: notification.priority === "critical" ? "high" : "normal" });
  return { id: response.headers.location ?? "accepted", status: response.statusCode };
}

async function deliver(item: OutboxItem): Promise<boolean> {
  const claimed = await claimOutboxItem(item);
  if (!claimed) return false;
  try {
    const notification = await getStoredNotification(claimed.notification_id);
    const result = claimed.channel === "email"
      ? await sendEmail(claimed, notification)
      : await sendPush(claimed, notification);
    await recordDelivery({ item: claimed, success: true, providerMessageId: result.id, responseStatus: result.status });
    await markOutboxSent(claimed);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = typeof error === "object" && error !== null && "statusCode" in error
      ? Number((error as { statusCode: unknown }).statusCode)
      : undefined;
    await recordDelivery({ item: claimed, success: false, ...(status ? { responseStatus: status } : {}), errorMessage: message });
    await markOutboxFailed(claimed, message, claimed.channel === "web_push" && (status === 404 || status === 410));
    logger.warn({ err: error, outboxId: claimed.id, channel: claimed.channel }, "Notification delivery failed");
    return false;
  }
}

export async function processDeliveryPass(): Promise<{ due: number; sent: number }> {
  if (env.DELIVERY_MODE !== "all") return { due: 0, sent: 0 };
  const due = await listDueOutbox();
  const settled = await Promise.all(due.map(deliver));
  return { due: due.length, sent: settled.filter(Boolean).length };
}
