-- 7-day free trial for new companies, then hard lockout from map + data
-- features until they subscribe. Their data is preserved indefinitely so
-- they can come back any time and pick up where they left off; we just
-- gate access through the app.
--
-- A company "has access" when ANY of these is true:
--   - it has an active or trialing Stripe subscription
--   - its trial_ends_at is still in the future

begin;

alter table public.companies
  add column if not exists trial_ends_at timestamptz;

-- Backfill: existing companies get a trial that ends 7 days after creation.
-- The user's own founding company already had its trial expire (created
-- weeks ago); they'll set themselves to plan_status='active' or apply a
-- 100% off Stripe coupon to grant themselves comp access.
update public.companies
set trial_ends_at = created_at + interval '7 days'
where trial_ends_at is null
  and created_at is not null;

-- Future companies get a fresh 7-day trial from creation time.
alter table public.companies
  alter column trial_ends_at set default (now() + interval '7 days'),
  alter column trial_ends_at set not null;

-- Helper used by the frontend gate.
create or replace function public.company_has_access(target_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce(
    (
      select stripe_subscription_status in ('active', 'trialing')
        or trial_ends_at > now()
      from public.companies
      where id = target_company_id
    ),
    false
  );
$$;

-- Replace company_billing_snapshot to also expose trial_ends_at + has_access
-- so the frontend can render the trial-ended gate without a second round trip.
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
  active_seat_count integer,
  trial_ends_at timestamptz,
  has_access boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
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
    public.company_active_seat_count(c.id),
    c.trial_ends_at,
    c.stripe_subscription_status in ('active', 'trialing')
      or c.trial_ends_at > now() as has_access
  from public.companies c
  where c.id = target_company_id;
end;
$$;

commit;
