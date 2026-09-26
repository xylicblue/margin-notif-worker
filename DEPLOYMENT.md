# Deployment handoff

## 1. Prepare Supabase

Run [`migrations/001_margin_notification_worker.sql`](./migrations/001_margin_notification_worker.sql) once in the production Supabase SQL Editor.

## 2. Configure the worker

Deploy this directory with Node.js 20+ or the included Dockerfile. Copy `.env.example` into the hosting provider's environment settings.

Required values:

```env
RPC_URL=<reliable Sepolia HTTPS RPC URL>
CHAIN_ID=11155111
CLEARING_HOUSE_ADDRESS=0xDf4DDD4019097B335dD507f916984A1A53E40a0d
DEPLOYMENT_BLOCK=<block at or before the first TradeExecuted event for this proxy>
MARKETS_JSON=<the contents of config/markets.sepolia.json as one JSON line>

SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<production service-role key>

DELIVERY_MODE=shadow
APP_URL=https://<production ByteStrike domain>
```

Confirm the ClearingHouse address, deployment block and market list against the latest production deployment before starting. Do not add a blockchain private key; the worker never signs transactions.

Keep the remaining polling and warning values from `.env.example`. For email and browser push in the later `all` phase, also set:

```env
RESEND_API_KEY=<Resend API key>
EMAIL_FROM=ByteStrike <verified-sender@your-domain>
VAPID_SUBJECT=mailto:<operations-email>
VAPID_PUBLIC_KEY=<public VAPID key>
VAPID_PRIVATE_KEY=<private VAPID key>
```

Generate the VAPID pair once with `npx web-push generate-vapid-keys`.

## 3. Verify and deploy

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Deploy the container, then confirm that `/healthz` and `/readyz` return HTTP 200. Run [`operations/verify_shadow_rollout.sql`](./operations/verify_shadow_rollout.sql) and confirm a current leader heartbeat, advancing event scans and no worker error.

After shadow results are correct, change `DELIVERY_MODE` to `in_app`. Move to `all` only after testing email and browser push with a controlled account.

## 4. Deploy the frontend changes

The frontend integration is already implemented in `overhaul`, but that application must also be rebuilt and deployed. It includes the notification-bell feed, settings controls and browser-push service worker.

For browser push, set this frontend build variable to the same public VAPID key used by the worker:

```env
VITE_VAPID_PUBLIC_KEY=<public VAPID key>
```

No change is required to the existing liquidation server. The notification worker is read-only against the chain and does not delay or control liquidation.
