-- ============================================================================
-- ByteStrike margin notification worker
--
-- Additive-only operational schema. This does not modify liquidation, margin,
-- trading, oracle, or settlement procedures. The worker has no chain key and
-- can only observe confirmed chain state and create notification records.
-- ============================================================================

begin;

create extension if not exists pgcrypto;

-- Compatibility definitions. On an existing ByteStrike deployment these are
-- no-ops; they make a clean deployment possible without copying old migrations.
create table if not exists public.trader_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  category text not null,
  code text not null,
  priority text not null,
  market_id text,
  market_label text,
  title text not null,
  body text not null,
  data jsonb not null default '{}'::jsonb,
  actions jsonb not null default '[]'::jsonb,
  status text not null default 'unread',
  tx_hash text,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create table if not exists public.notification_preferences (
  user_id text primary key,
  cat_margin_enabled boolean not null default true,
  cat_liquidation_enabled boolean not null default true,
  cat_funding_enabled boolean not null default true,
  cat_position_enabled boolean not null default true,
  cat_collateral_enabled boolean not null default true,
  cat_market_enabled boolean not null default true,
  margin_warning_multiplier numeric not null default 2.0,
  email_enabled boolean not null default false,
  email_address text,
  push_enabled boolean not null default false,
  push_subscription jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.margin_active_positions (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null,
  account text not null check (account = lower(account)),
  market_id text not null check (market_id = lower(market_id)),
  market_label text not null,
  last_size numeric(78,0) not null,
  active boolean not null default true,
  first_seen_block bigint not null,
  last_seen_block bigint not null,
  last_tx_hash text not null,
  last_reconciled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chain_id, account, market_id)
);

create index if not exists margin_active_positions_reconcile_idx
  on public.margin_active_positions(chain_id, active, last_reconciled_at nulls first);

create table if not exists public.margin_risk_episodes (
  id uuid primary key default gen_random_uuid(),
  position_id uuid not null references public.margin_active_positions(id) on delete cascade,
  current_level text not null check (current_level in ('warning', 'danger', 'near_liquidation', 'liquidatable')),
  highest_level text not null check (highest_level in ('warning', 'danger', 'near_liquidation', 'liquidatable')),
  started_at timestamptz not null,
  last_evaluated_at timestamptz not null,
  last_notified_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists margin_risk_episodes_one_open_idx
  on public.margin_risk_episodes(position_id) where ended_at is null;

create table if not exists public.margin_risk_observations (
  id uuid primary key default gen_random_uuid(),
  position_id uuid not null references public.margin_active_positions(id) on delete cascade,
  episode_id uuid references public.margin_risk_episodes(id) on delete set null,
  previous_level text not null,
  risk_level text not null,
  notification_code text,
  effective_margin numeric(78,0) not null,
  maintenance_margin numeric(78,0) not null,
  liquidation_buffer numeric(78,0) not null,
  coverage_multiple numeric,
  margin_ratio_x18 numeric(78,0) not null,
  mmr_bps bigint not null,
  mark_price_x18 numeric(78,0) not null,
  index_price_x18 numeric(78,0) not null,
  is_liquidatable boolean not null,
  delivery_mode text not null check (delivery_mode in ('shadow', 'in_app', 'all')),
  observed_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists margin_risk_observations_position_idx
  on public.margin_risk_observations(position_id, observed_at desc);

alter table public.trader_notifications
  add column if not exists expires_at timestamptz,
  add column if not exists idempotency_key text,
  add column if not exists risk_observation_id uuid,
  add column if not exists risk_episode_id uuid;

create unique index if not exists trader_notifications_idempotency_idx
  on public.trader_notifications(idempotency_key) where idempotency_key is not null;

alter table public.notification_preferences
  add column if not exists cat_margin_enabled boolean not null default true,
  add column if not exists cat_liquidation_enabled boolean not null default true;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'trader_notifications_risk_observation_fkey'
      and conrelid = 'public.trader_notifications'::regclass
  ) then
    alter table public.trader_notifications
      add constraint trader_notifications_risk_observation_fkey
      foreign key (risk_observation_id) references public.margin_risk_observations(id) on delete set null;
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'trader_notifications_risk_episode_fkey'
      and conrelid = 'public.trader_notifications'::regclass
  ) then
    alter table public.trader_notifications
      add constraint trader_notifications_risk_episode_fkey
      foreign key (risk_episode_id) references public.margin_risk_episodes(id) on delete set null;
  end if;
end
$$;

create table if not exists public.margin_notification_outbox (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.trader_notifications(id) on delete cascade,
  channel text not null check (channel in ('email', 'web_push')),
  destination jsonb not null,
  idempotency_key text not null unique,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists margin_notification_outbox_due_idx
  on public.margin_notification_outbox(status, next_attempt_at);

create table if not exists public.margin_notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  outbox_id uuid not null references public.margin_notification_outbox(id) on delete cascade,
  channel text not null,
  attempt integer not null,
  success boolean not null,
  provider_message_id text,
  response_status integer,
  error_message text,
  attempted_at timestamptz not null default now()
);

create table if not exists public.margin_worker_state (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.margin_worker_leases (
  name text primary key,
  owner text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.margin_worker_heartbeats (
  instance_id text primary key,
  delivery_mode text not null,
  is_leader boolean not null,
  ready boolean not null,
  active_positions integer not null default 0,
  evaluated_positions integer not null default 0,
  last_event_scan_at timestamptz,
  last_risk_pass_at timestamptz,
  last_delivery_pass_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create or replace function public.claim_margin_worker_lease(
  p_name text,
  p_owner text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  acquired boolean := false;
begin
  if p_ttl_seconds < 10 or p_ttl_seconds > 300 then
    raise exception 'Invalid lease duration' using errcode = '22023';
  end if;

  insert into public.margin_worker_leases(name, owner, expires_at, updated_at)
  values (p_name, p_owner, now() + make_interval(secs => p_ttl_seconds), now())
  on conflict (name) do update
    set owner = excluded.owner,
        expires_at = excluded.expires_at,
        updated_at = now()
    where public.margin_worker_leases.expires_at < now()
       or public.margin_worker_leases.owner = excluded.owner
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;

create or replace function public.upsert_margin_active_position(
  p_chain_id bigint,
  p_account text,
  p_market_id text,
  p_market_label text,
  p_last_size numeric,
  p_block_number bigint,
  p_tx_hash text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.margin_active_positions(
    chain_id, account, market_id, market_label, last_size, active,
    first_seen_block, last_seen_block, last_tx_hash, updated_at
  ) values (
    p_chain_id, lower(p_account), lower(p_market_id), p_market_label, p_last_size,
    p_last_size <> 0, p_block_number, p_block_number, p_tx_hash, now()
  )
  on conflict (chain_id, account, market_id) do update set
    market_label = excluded.market_label,
    last_size = excluded.last_size,
    active = excluded.active,
    first_seen_block = least(public.margin_active_positions.first_seen_block, excluded.first_seen_block),
    last_seen_block = greatest(public.margin_active_positions.last_seen_block, excluded.last_seen_block),
    last_tx_hash = case
      when excluded.last_seen_block >= public.margin_active_positions.last_seen_block
      then excluded.last_tx_hash else public.margin_active_positions.last_tx_hash end,
    updated_at = now();
$$;

alter table public.margin_active_positions enable row level security;
alter table public.margin_risk_episodes enable row level security;
alter table public.margin_risk_observations enable row level security;
alter table public.margin_notification_outbox enable row level security;
alter table public.margin_notification_deliveries enable row level security;
alter table public.margin_worker_state enable row level security;
alter table public.margin_worker_leases enable row level security;
alter table public.margin_worker_heartbeats enable row level security;
alter table public.trader_notifications enable row level security;
alter table public.notification_preferences enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'trader_notifications'
      and policyname = 'Users can read their own trader notifications'
  ) then
    create policy "Users can read their own trader notifications"
      on public.trader_notifications for select to authenticated
      using (exists (
        select 1 from public.profiles profile
        where profile.id = auth.uid()
          and lower(profile.wallet_address) = lower(trader_notifications.user_id)
      ));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'trader_notifications'
      and policyname = 'Users can update status on their own trader notifications'
  ) then
    create policy "Users can update status on their own trader notifications"
      on public.trader_notifications for update to authenticated
      using (public.is_aal2() and exists (
        select 1 from public.profiles profile
        where profile.id = auth.uid()
          and lower(profile.wallet_address) = lower(trader_notifications.user_id)
      ))
      with check (public.is_aal2() and exists (
        select 1 from public.profiles profile
        where profile.id = auth.uid()
          and lower(profile.wallet_address) = lower(trader_notifications.user_id)
      ));
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'trader_notifications'
  ) then
    alter publication supabase_realtime add table public.trader_notifications;
  end if;
end
$$;

revoke all on public.margin_active_positions from public, anon, authenticated;
revoke all on public.margin_risk_episodes from public, anon, authenticated;
revoke all on public.margin_risk_observations from public, anon, authenticated;
revoke all on public.margin_notification_outbox from public, anon, authenticated;
revoke all on public.margin_notification_deliveries from public, anon, authenticated;
revoke all on public.margin_worker_state from public, anon, authenticated;
revoke all on public.margin_worker_leases from public, anon, authenticated;
revoke all on public.margin_worker_heartbeats from public, anon, authenticated;

grant all on public.margin_active_positions to service_role;
grant all on public.margin_risk_episodes to service_role;
grant all on public.margin_risk_observations to service_role;
grant all on public.margin_notification_outbox to service_role;
grant all on public.margin_notification_deliveries to service_role;
grant all on public.margin_worker_state to service_role;
grant all on public.margin_worker_leases to service_role;
grant all on public.margin_worker_heartbeats to service_role;
grant select, insert, update on public.trader_notifications to service_role;
grant select, insert, update on public.notification_preferences to service_role;

revoke execute on function public.claim_margin_worker_lease(text, text, integer)
  from public, anon, authenticated;
revoke execute on function public.upsert_margin_active_position(bigint, text, text, text, numeric, bigint, text)
  from public, anon, authenticated;
grant execute on function public.claim_margin_worker_lease(text, text, integer) to service_role;
grant execute on function public.upsert_margin_active_position(bigint, text, text, text, numeric, bigint, text) to service_role;

notify pgrst, 'reload schema';

commit;
