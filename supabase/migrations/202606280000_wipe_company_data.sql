-- The "I'm out" / "reset my data" button. One owner-only RPC that wipes
-- every point and import a company has, including the company's
-- contributions to the community pool, while leaving the company itself,
-- its team, billing, and settings intact. Raw files in storage are NOT
-- deleted by this RPC — that part runs client-side via the storage API
-- because storage objects aren't tables.
--
-- Owner-only by design: members and admins should not be able to nuke the
-- company's data even if they have admin powers for invites / team.
--
-- Order matters here because of foreign keys and the community-pool
-- bookkeeping:
--   1. Find every community_point this company contributes to so we know
--      which ones to recount / delete after we remove their observation.
--   2. Delete this company's community_point_observations rows.
--   3. For each formerly-contributed community_point: if no observations
--      remain from any company, delete it (vanishes from everyone's map);
--      otherwise refresh observation/contributor counts.
--   4. Delete company_points (this is where the bulk of the row count is).
--   5. Delete import_review_groups + import_point_staging + import_jobs
--      tied to this company.
--   6. Reset company-level counters back to the brand-new state.
--   7. Return counts so the UI can show "wiped X points, Y imports".

begin;

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
  deleted_company_points integer := 0;
  deleted_jobs integer := 0;
  deleted_staging integer := 0;
  deleted_review_groups integer := 0;
  storage_prefix text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  -- Owner-only. Even admins shouldn't be able to wipe.
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

  -- 1. Snapshot the community_points this company contributes to.
  select coalesce(array_agg(distinct o.community_point_id), '{}')
  into affected_community_ids
  from public.community_point_observations o
  where o.company_id = target_company_id;

  -- 2. Delete this company's observations.
  delete from public.community_point_observations
  where company_id = target_company_id;
  get diagnostics deleted_observations = row_count;

  -- 3. Recount / delete community_points we touched.
  if cardinality(affected_community_ids) > 0 then
    -- Delete the ones with zero remaining observations.
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

    -- Refresh the survivors.
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

  -- 4. Delete the company's points.
  delete from public.company_points
  where company_id = target_company_id;
  get diagnostics deleted_company_points = row_count;

  -- 5. Delete import scaffolding tied to this company.
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

  -- 6. Reset counters so the Community Standing card and audits look
  -- brand-new.
  update public.companies
  set
    community_points_shared_count = 0,
    community_points_viewed_count = 0,
    community_sharing_enabled = false,
    last_community_share_at = null
  where id = target_company_id;

  -- 7. Where the raw files live in storage — UI uses this to walk the
  -- pointvault-imports bucket and delete every object under this prefix.
  storage_prefix := target_company_id::text;

  return jsonb_build_object(
    'company_id', target_company_id,
    'observations_deleted', deleted_observations,
    'community_points_deleted', deleted_community_points,
    'company_points_deleted', deleted_company_points,
    'review_groups_deleted', deleted_review_groups,
    'staging_deleted', deleted_staging,
    'import_jobs_deleted', deleted_jobs,
    'storage_prefix', storage_prefix
  );
end;
$$;

grant execute on function public.wipe_company_data(uuid) to authenticated;
grant execute on function public.wipe_company_data(uuid) to service_role;

commit;
