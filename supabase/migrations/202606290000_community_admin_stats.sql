-- Founder-only admin view of community engagement.
-- The founder (per the email check below) gets a god-view: total companies,
-- total contributors, total community points, total observations, recent
-- shares, and a per-company leaderboard of who's contributing how much.
-- Not exposed to anyone else even by accident — the RPC raises if the
-- caller's email isn't the founder's.
--
-- Founder email is hardcoded here on purpose: keeps the gate server-side
-- where it can't be bypassed by editing the frontend.

begin;

create or replace function public.get_community_admin_stats()
returns jsonb
language plpgsql
security definer
stable
set search_path to 'public'
as $$
declare
  caller_email text;
  founder_email constant text := 'skinners1309@gmail.com';
  totals jsonb;
  top_contributors jsonb;
  recent_activity jsonb;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select u.email::text into caller_email
  from auth.users u
  where u.id = auth.uid();

  if caller_email is null or lower(caller_email) <> lower(founder_email) then
    raise exception 'Admin-only view.';
  end if;

  -- Roll-up totals
  select jsonb_build_object(
    'companies', (select count(*) from public.companies),
    'companies_sharing', (
      select count(distinct company_id) from public.community_point_observations
    ),
    'community_points', (select count(*) from public.community_points),
    'observations', (select count(*) from public.community_point_observations),
    'companies_subscribed', (
      select count(*) from public.companies
      where stripe_subscription_status in ('active', 'trialing')
    ),
    'observations_last_7d', (
      select count(*) from public.community_point_observations
      where created_at >= now() - interval '7 days'
    ),
    'observations_last_30d', (
      select count(*) from public.community_point_observations
      where created_at >= now() - interval '30 days'
    )
  ) into totals;

  -- Per-company contribution leaderboard, biggest first
  select coalesce(jsonb_agg(row_to_jsonb(t)), '[]'::jsonb)
  from (
    select
      c.id as company_id,
      c.name as company_name,
      c.created_at as company_created_at,
      coalesce(c.stripe_subscription_status, 'free')::text as subscription_status,
      count(o.id) as shared_count,
      max(o.created_at) as last_share_at
    from public.companies c
    left join public.community_point_observations o on o.company_id = c.id
    group by c.id
    order by count(o.id) desc, c.created_at asc
    limit 50
  ) t into top_contributors;

  -- Most recent shares (rolling activity feed)
  select coalesce(jsonb_agg(row_to_jsonb(t)), '[]'::jsonb)
  from (
    select
      o.created_at,
      c.name as company_name,
      o.marker_type,
      o.description,
      o.latitude,
      o.longitude
    from public.community_point_observations o
    join public.companies c on c.id = o.company_id
    order by o.created_at desc
    limit 25
  ) t into recent_activity;

  return jsonb_build_object(
    'totals', totals,
    'top_contributors', top_contributors,
    'recent_activity', recent_activity
  );
end;
$$;

grant execute on function public.get_community_admin_stats() to authenticated;
grant execute on function public.get_community_admin_stats() to service_role;

commit;
