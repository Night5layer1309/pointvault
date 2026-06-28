-- Scrub orphaned community_points (rows in community_points with zero
-- backing community_point_observations). A community_point should only
-- exist while at least one company is contributing it; the share/unshare
-- flow is supposed to delete the community_point when the last observation
-- on it goes away. Previous code paths (early bulk-share migrations, the
-- repair tool, the wipe button before the same-call cleanup fix below)
-- could leave orphans — they don't show on any map because
-- nearby_visible_points filters by `not exists` against observations, but
-- they inflate the admin "community_points" count and waste rows.
--
-- Also: replace wipe_company_data with a version that does a final global
-- orphan-cleanup pass at the end. The previous version only scrubbed
-- community_points the WIPING company's observations directly touched —
-- if an earlier code path had already orphaned community_points for that
-- company, the wipe wouldn't catch them. The extra pass at the end is
-- cheap (a single delete with a NOT EXISTS) and guarantees zero orphans
-- after any wipe finishes.

begin;

-- 1. Founder-only one-shot scrub.
create or replace function public.cleanup_orphaned_community_points()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  caller_email text;
  founder_email constant text := 'skinners1309@gmail.com';
  deleted_count integer;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select u.email::text into caller_email
  from auth.users u
  where u.id = auth.uid();

  if caller_email is null or lower(caller_email) <> lower(founder_email) then
    raise exception 'Admin-only operation.';
  end if;

  delete from public.community_points c
  where not exists (
    select 1 from public.community_point_observations o
    where o.community_point_id = c.id
  );
  get diagnostics deleted_count = row_count;

  return jsonb_build_object(
    'deleted_orphans', deleted_count,
    'remaining_community_points', (select count(*) from public.community_points)
  );
end;
$$;

grant execute on function public.cleanup_orphaned_community_points() to authenticated;
grant execute on function public.cleanup_orphaned_community_points() to service_role;


-- 2. Re-issue wipe_company_data with a final orphan-cleanup pass.
create or replace function public.wipe_company_data(target_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  caller_membership public.company_memberships;
  affected_community_ids uuid[];
  deleted_observations integer := 0;
  deleted_community_points integer := 0;
  deleted_orphan_community_points integer := 0;
  deleted_company_points integer := 0;
  deleted_jobs integer := 0;
  deleted_staging integer := 0;
  deleted_review_groups integer := 0;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select * into caller_membership
  from public.company_memberships
  where company_id = target_company_id
    and user_id = auth.uid();

  if caller_membership.id is null then
    raise exception 'You are not a member of this company.';
  end if;

  if caller_membership.role <> 'owner' then
    raise exception 'Only the company owner can wipe all data.';
  end if;

  select coalesce(array_agg(distinct o.community_point_id), '{}')
  into affected_community_ids
  from public.community_point_observations o
  where o.company_id = target_company_id;

  delete from public.community_point_observations
  where company_id = target_company_id;
  get diagnostics deleted_observations = row_count;

  if cardinality(affected_community_ids) > 0 then
    with empty_cps as (
      select c.id
      from public.community_points c
      where c.id = any(affected_community_ids)
        and not exists (
          select 1 from public.community_point_observations o
          where o.community_point_id = c.id
        )
    ),
    deleted as (
      delete from public.community_points
      where id in (select id from empty_cps)
      returning id
    )
    select count(*) into deleted_community_points from deleted;

    update public.community_points c
    set
      observation_count = (
        select count(*) from public.community_point_observations o
        where o.community_point_id = c.id
      ),
      contributor_count = (
        select count(distinct o.company_id) from public.community_point_observations o
        where o.community_point_id = c.id
      ),
      updated_at = now()
    where c.id = any(affected_community_ids);
  end if;

  delete from public.company_points
  where company_id = target_company_id;
  get diagnostics deleted_company_points = row_count;

  delete from public.import_review_groups
  where import_job_id in (
    select id from public.import_jobs where company_id = target_company_id
  );
  get diagnostics deleted_review_groups = row_count;

  delete from public.import_point_staging
  where company_id = target_company_id;
  get diagnostics deleted_staging = row_count;

  delete from public.import_jobs
  where company_id = target_company_id;
  get diagnostics deleted_jobs = row_count;

  update public.companies
  set
    community_points_shared_count = 0,
    community_points_viewed_count = 0,
    community_sharing_enabled = false,
    last_community_share_at = null
  where id = target_company_id;

  -- Final belt-and-suspenders pass: any community_points without any
  -- backing observation (regardless of whether this wipe directly touched
  -- them) get scrubbed. Catches pre-existing orphans from earlier code
  -- paths so the table stays sane.
  delete from public.community_points c
  where not exists (
    select 1 from public.community_point_observations o
    where o.community_point_id = c.id
  );
  get diagnostics deleted_orphan_community_points = row_count;

  return jsonb_build_object(
    'company_id', target_company_id,
    'observations_deleted', deleted_observations,
    'community_points_deleted', deleted_community_points,
    'community_points_orphan_cleanup', deleted_orphan_community_points,
    'company_points_deleted', deleted_company_points,
    'review_groups_deleted', deleted_review_groups,
    'staging_deleted', deleted_staging,
    'import_jobs_deleted', deleted_jobs,
    'storage_prefix', target_company_id::text
  );
end;
$$;

grant execute on function public.wipe_company_data(uuid) to authenticated;
grant execute on function public.wipe_company_data(uuid) to service_role;

commit;
