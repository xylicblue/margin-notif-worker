-- Run each read-only query separately after deploying in DELIVERY_MODE=shadow.

-- 1. Confirm a live leader heartbeat and no current worker error.
select
  instance_id,
  delivery_mode,
  is_leader,
  ready,
  active_positions,
  evaluated_positions,
  last_event_scan_at,
  last_risk_pass_at,
  last_error,
  updated_at
from public.margin_worker_heartbeats
order by updated_at desc;

-- 2. Confirm that event discovery has reconstructed active positions.
select
  market_label,
  count(*) filter (where active) as active_positions,
  min(first_seen_block) as earliest_seen_block,
  max(last_seen_block) as latest_seen_block,
  max(last_reconciled_at) as latest_risk_reconciliation
from public.margin_active_positions
group by market_label
order by market_label;

-- 3. Review the latest simulated warning observations.
select
  position.market_label,
  observation.risk_level,
  observation.notification_code,
  observation.coverage_multiple,
  observation.is_liquidatable,
  observation.delivery_mode,
  observation.observed_at
from public.margin_risk_observations observation
join public.margin_active_positions position on position.id = observation.position_id
order by observation.observed_at desc
limit 100;

-- 4. Shadow mode must not create client notifications or delivery jobs.
select count(*) as worker_client_notifications
from public.trader_notifications
where idempotency_key like 'risk:%'
   or idempotency_key like 'liquidation:%';

select count(*) as queued_external_deliveries
from public.margin_notification_outbox;

-- 5. Before enabling external delivery, this should have no dead jobs.
select
  status,
  channel,
  count(*) as jobs,
  max(last_error) as latest_error
from public.margin_notification_outbox
group by status, channel
order by status, channel;
