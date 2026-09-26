# ByteStrike Margin Notification Worker

Standalone, read-only monitoring service for margin-risk warnings and liquidation notifications. It is intentionally separate from the trading application, the `agentic-trading` service, and the production liquidation server.

## Safety boundary

This service:

- reads confirmed `TradeExecuted` and `LiquidationExecuted` events;
- reads current positions, prices, margin ratios, and market risk parameters;
- records auditable risk episodes and observations;
- creates idempotent in-app notifications; and
- optionally sends opt-in email and Web Push notifications through a retrying outbox.

It does **not** hold a private key, submit transactions, liquidate positions, move collateral, alter margin parameters, update prices, or write to trading contracts. A worker failure therefore cannot stop trading or liquidation. The existing liquidation server remains authoritative and independent.

## Warning model

The worker compares effective margin with the on-chain maintenance-margin requirement and evaluates the maintenance coverage multiple:

```text
coverage multiple = effective margin / maintenance margin
```

Default levels:

| Code | Condition | Default action |
|---|---|---|
| A1 | Coverage at or below 2.0x | Margin warning |
| A2 | Coverage at or below 1.5x | High-risk warning |
| A3 | Coverage at or below 1.1x, below maintenance, or contract reports liquidatable | Critical warning |
| A0 | Position returns above 2.0x | Recovery notice |
| B1/B2 | Confirmed partial/full liquidation event | Liquidation notice |

Warnings are advisory and best-effort. They do not delay or gate liquidation.

## Delivery modes

- `shadow`: reads the chain and records episodes/observations, but creates no client notification. This is the deployment default.
- `in_app`: also writes rows to `trader_notifications` for the existing wallet owner.
- `all`: also queues opt-in email and Web Push deliveries.

Move through these modes only after validating the prior mode in production.

## Setup

1. Run [`migrations/001_margin_notification_worker.sql`](./migrations/001_margin_notification_worker.sql) in the production Supabase SQL editor.
2. Copy `.env.example` to `.env` and enter production values.
3. Keep `DELIVERY_MODE=shadow` for the initial deployment.
4. Install and verify:

   ```bash
   npm ci
   npm run check
   npm start
   ```

5. Verify `GET /healthz` and `GET /readyz`.
6. Review `margin_worker_heartbeats`, `margin_active_positions`, `margin_risk_episodes`, and `margin_risk_observations` for at least one full operational cycle.
7. Change to `in_app`, verify one controlled warning and recovery, then consider `all` after email/Web Push preferences and credentials are confirmed.

## Required production configuration

- A read-only RPC endpoint and the production chain ID.
- The production ClearingHouse proxy address and deployment block.
- A JSON list of monitored `bytes32` market IDs and labels.
- Supabase URL and a server-side service-role key.

Email and Web Push credentials are needed only in `all` mode. No chain private key should ever be supplied.

Generate a Web Push VAPID pair once with `npx web-push generate-vapid-keys`. Put the private key only in this worker's `VAPID_PRIVATE_KEY`. Put the matching public key in both `VAPID_PUBLIC_KEY` here and `VITE_VAPID_PUBLIC_KEY` in the web application build environment. The VAPID key is for browser notification authentication and is not a blockchain signing key.

## Event bootstrap

On first start the scanner begins at `DEPLOYMENT_BLOCK` and reconstructs currently open positions from `TradeExecuted.newSize`. Historical liquidation events are not sent to clients. Once the scanner reaches the confirmed chain head, new confirmed liquidation events become eligible for B1/B2 notifications.

The block cursor is stored after each successful chunk. Restarts resume from that cursor. Notification idempotency keys, one-open-episode constraints, and the outbox ledger protect against duplicates.

## Availability and deployment

The included `Dockerfile` and `railway.json` support container deployment. A database lease ensures only one replica actively scans and evaluates at a time; another replica may take over after lease expiry. Tasks are non-overlapping within an instance.

Recommended alerts:

- `/readyz` is not HTTP 200;
- no recent leader heartbeat;
- `last_error` is non-null;
- risk evaluations repeatedly fail;
- outbox entries reach `dead`; or
- the event cursor falls materially behind the confirmed chain head.

## Existing application integration

The worker deliberately writes to the existing `trader_notifications` table, whose rows are secured by wallet-address RLS. The web application can subscribe through Supabase Realtime using the authenticated profile's linked wallet. No changes to contract execution or the liquidation service are required.

Email and Web Push are sent only where the matching wallet has enabled the relevant channel in `notification_preferences`. The Notifications tab in the application settings manages those opt-ins and registers the browser push subscription. In-app warnings remain the durable compliance record when `DELIVERY_MODE` is `in_app` or `all`.

## Rollback

Set `DELIVERY_MODE=shadow` or stop the worker. Because the migration is additive and the worker is not in any trading or liquidation execution path, this immediately stops new client deliveries without changing current platform procedures. Retain the audit tables for investigation; they do not need to be dropped.
