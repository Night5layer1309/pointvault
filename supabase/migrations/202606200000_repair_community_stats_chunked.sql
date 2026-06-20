-- Replace repair_company_community_stats with a chunked version. The previous
-- one looped share_company_point_to_community per missing point, and each
-- call rewrites the company counter via a count(*) subquery across all
-- observations — at thousands of missing rows that hits the 8s Postgrest
-- statement timeout.
--
-- New behavior:
--   * Accepts chunk_size (default 200) and processes at most that many
--     missing observations per call.
--   * Returns `remaining` and `done` so the UI can loop until done = true.
--   * Each call still recomputes the company counter once at the end so the
--     Standing card reflects accurate totals between calls.
--
-- Same signature for the original arity is preserved (defaults the chunk).

begin;

drop function if exists public.repair_company_community_stats(uuid);

create or replace function public.repair_company_community_stats(
  target_company_id uuid,
  chunk_size integer default 200
)
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
  remaining_after bigint;
  rec record;
  safe_chunk integer := greatest(1, least(coalesce(chunk_size, 200), 500));
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
    limit safe_chunk
  loop
    begin
      perform public.share_company_point_to_community(rec.id);
      observations_repaired := observations_repaired + 1;
    exception when others then
      null;
    end;
  end loop;

  -- Refresh the company counter once at the end so the Standing card has
  -- accurate totals between chunked calls.
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

  -- How many flagged points still have no observation (so the UI knows
  -- whether to call again).
  select count(*) into remaining_after
  from public.company_points cp
  left join public.community_point_observations o on o.company_point_id = cp.id
  where cp.company_id = target_company_id
    and cp.visibility = 'community'
    and cp.geom is not null
    and o.id is null;

  return jsonb_build_object(
    'old_counter', old_counter,
    'new_counter', observations_after,
    'flagged_company_points', flagged_company_points,
    'observations_before', observations_before,
    'observations_repaired', observations_repaired,
    'observations_after', observations_after,
    'remaining', remaining_after,
    'done', (remaining_after = 0),
    'chunk_size', safe_chunk
  );
end;
$$;

grant execute on function public.repair_company_community_stats(uuid, integer) to authenticated;
grant execute on function public.repair_company_community_stats(uuid, integer) to service_role;

commit;
