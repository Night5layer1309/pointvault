-- Reverse a "share to community" action. The user asked for unshare as a
-- trust feature: "I can take it back if I shared something wrong." Two RPCs:
--   1. unshare_company_point_to_community(point_id) — undo one point
--   2. unshare_company_points_bulk(point_ids[]) — undo many, used by the
--      bulk-unshare card and the multi-select toolbar on the Points tab.
--
-- For each unshared point we:
--   * flip company_points.visibility back to 'company' and null shared_at
--   * delete our community_point_observations row for that point
--   * if no other company has an observation on the same community_point,
--     delete the community_points row entirely (so it disappears from
--     everyone else's map). Otherwise just refresh contributor/observation
--     counts to reflect our departure.
--   * refresh the company-level community_points_shared_count.
--
-- Membership-checked. Idempotent (no-op if a point is already private).

begin;

create or replace function public.unshare_company_point_to_community(target_company_point_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  cp public.company_points;
  observation_row public.community_point_observations;
  community_id uuid;
  remaining_observations bigint;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select * into cp from public.company_points where id = target_company_point_id;
  if cp.id is null then
    raise exception 'Company point not found.';
  end if;

  if not public.is_company_member(cp.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  -- Already private — nothing to do.
  if cp.visibility <> 'community' then
    return jsonb_build_object('unshared', false, 'reason', 'not_shared');
  end if;

  select * into observation_row
  from public.community_point_observations
  where company_point_id = cp.id;

  community_id := observation_row.community_point_id;

  -- 1. Make the company point private again.
  update public.company_points
  set visibility = 'company', shared_at = null
  where id = cp.id;

  -- 2. Remove our observation on the community point.
  if observation_row.id is not null then
    delete from public.community_point_observations
    where id = observation_row.id;

    -- 3. If we were the last contributor, kill the community_point too so it
    -- vanishes from everyone's map. Otherwise refresh counts.
    select count(*) into remaining_observations
    from public.community_point_observations
    where community_point_id = community_id;

    if remaining_observations = 0 then
      delete from public.community_points where id = community_id;
    else
      update public.community_points c
      set
        observation_count = remaining_observations,
        contributor_count = (
          select count(distinct o.company_id)
          from public.community_point_observations o
          where o.community_point_id = c.id
        ),
        updated_at = now()
      where c.id = community_id;
    end if;
  end if;

  -- 4. Refresh the company's running tally.
  update public.companies
  set community_points_shared_count = (
    select count(*) from public.community_point_observations where company_id = cp.company_id
  )
  where id = cp.company_id;

  return jsonb_build_object(
    'unshared', true,
    'company_point_id', cp.id,
    'community_point_deleted', (community_id is not null and (
      select count(*) from public.community_point_observations where community_point_id = community_id
    ) = 0)
  );
end;
$$;

grant execute on function public.unshare_company_point_to_community(uuid) to authenticated;
grant execute on function public.unshare_company_point_to_community(uuid) to service_role;

create or replace function public.unshare_company_points_bulk(target_point_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  point_id uuid;
  unshared integer := 0;
  skipped integer := 0;
  failed integer := 0;
  result jsonb;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  if target_point_ids is null or cardinality(target_point_ids) = 0 then
    return jsonb_build_object('unshared', 0, 'skipped', 0, 'failed', 0);
  end if;

  foreach point_id in array target_point_ids loop
    begin
      result := public.unshare_company_point_to_community(point_id);
      if coalesce((result->>'unshared')::boolean, false) then
        unshared := unshared + 1;
      else
        skipped := skipped + 1;
      end if;
    exception when others then
      failed := failed + 1;
    end;
  end loop;

  return jsonb_build_object(
    'unshared', unshared,
    'skipped', skipped,
    'failed', failed
  );
end;
$$;

grant execute on function public.unshare_company_points_bulk(uuid[]) to authenticated;
grant execute on function public.unshare_company_points_bulk(uuid[]) to service_role;

commit;
