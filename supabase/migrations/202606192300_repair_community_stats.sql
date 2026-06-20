-- One-click repair for the Community Standing counter.
--
-- companies.community_points_shared_count is supposed to mirror
-- count(*) from community_point_observations for that company. It's
-- recomputed every time share / unshare runs. But if the count drifts —
-- manual SQL, an old code path that didn't write to observations, the
-- nuclear-reset on 2026-05-26 — the UI shows the stale number.
--
-- This RPC:
--   1. Snapshots the current counter and the actual observation count.
--   2. Snapshots how many company_points are flagged visibility='community'.
--   3. For any flagged company_point that has NO matching observation,
--      re-runs share_company_point_to_community(id) to create the
--      observation. (That function is idempotent — on-conflict-do-nothing.)
--   4. Recomputes the counter from observations.
--   5. Returns before/after so the UI can show what was fixed.
--
-- Safe to run repeatedly. Membership-checked.

begin;

create or replace function public.repair_company_community_stats(target_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  old_counter bigint;
  observations_before bigint;
  flagged_company_points bigint;
  observations_repaired integer := 0;
  observations_after bigint;
  rec record;
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  select community_points_shared_count into old_counter
  from public.companies where id = target_company_id;

  select count(*) into observations_before
  from public.community_point_observations
  where company_id = target_company_id;

  select count(*) into flagged_company_points
  from public.company_points
  where company_id = target_company_id
    and visibility = 'community'
    and geom is not null;

  for rec in
    select cp.id
    from public.company_points cp
    left join public.community_point_observations o on o.company_point_id = cp.id
    where cp.company_id = target_company_id
      and cp.visibility = 'community'
      and cp.geom is not null
      and o.id is null
  loop
    begin
      perform public.share_company_point_to_community(rec.id);
      observations_repaired := observations_repaired + 1;
    exception when others then
      null;
    end;
  end loop;

  update public.companies c
  set community_points_shared_count = sub.cnt
  from (
    select count(*) as cnt
    from public.community_point_observations
    where company_id = target_company_id
  ) sub
  where c.id = target_company_id;

  select count(*) into observations_after
  from public.community_point_observations
  where company_id = target_company_id;

  return jsonb_build_object(
    'old_counter', old_counter,
    'new_counter', observations_after,
    'flagged_company_points', flagged_company_points,
    'observations_before', observations_before,
    'observations_repaired', observations_repaired,
    'observations_after', observations_after
  );
end;
$$;

grant execute on function public.repair_company_community_stats(uuid) to authenticated;
grant execute on function public.repair_company_community_stats(uuid) to service_role;

commit;
