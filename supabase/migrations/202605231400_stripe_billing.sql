-- Stripe billing columns on companies + a helper view of active seat counts.
--
-- One Stripe Customer per company, one Subscription per company, quantity on
-- that subscription = number of active members. Each member adds $10/mo to
-- the next invoice automatically (Stripe handles proration mid-cycle).
--
-- stripe_subscription_status values follow Stripe's vocabulary:
--   trialing, active, past_due, canceled, incomplete, incomplete_expired,
--   unpaid, paused
-- We treat 'trialing' and 'active' as "company can use the app" and everything
-- else as "needs attention" (Manage Billing).

begin;

alter table public.companies
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_subscription_status text,
  add column if not exists stripe_price_id text,
  add column if not exists stripe_current_period_end timestamptz;

create index if not exists companies_stripe_customer_id_idx
  on public.companies(stripe_customer_id)
  where stripe_customer_id is not null;

create index if not exists companies_stripe_subscription_id_idx
  on public.companies(stripe_subscription_id)
  where stripe_subscription_id is not null;

-- Helper used by the seat-quantity sync Edge Function and by the front end.
-- Returns the current active member count for a company. Excludes invited and
-- disabled memberships.
create or replace function public.company_active_seat_count(target_company_id uuid)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select count(*)::integer
  from public.company_memberships
  where company_id = target_company_id
    and status = 'active';
$$;

-- Owner-only RPC the Edge Function reads back to find which company is being
-- billed. Avoids the Edge Function having to re-implement membership lookups.
create or replace function public.company_billing_snapshot(target_company_id uuid)
returns table (
  id uuid,
  name text,
  owner_id uuid,
  plan_status text,
  seat_limit integer,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_subscription_status text,
  stripe_price_id text,
  stripe_current_period_end timestamptz,
  active_seat_count integer
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.is_company_owner_or_admin(target_company_id) then
    raise exception 'Only company owners or admins can view billing.';
  end if;

  return query
  select
    c.id,
    c.name,
    c.owner_id,
    c.plan_status,
    c.seat_limit,
    c.stripe_customer_id,
    c.stripe_subscription_id,
    c.stripe_subscription_status,
    c.stripe_price_id,
    c.stripe_current_period_end,
    public.company_active_seat_count(c.id)
  from public.companies c
  where c.id = target_company_id;
end;
$$;

commit;
