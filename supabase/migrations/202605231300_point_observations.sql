-- Database-backed observations on a company's own points (the existing
-- 'Add Local Observation' panel was screen-only; this lets observations
-- survive a refresh and sync across the same surveyor's phone + PC).
--
-- Distinct from community_point_notes:
--   point_observations attach to company_points (the company's own copy of
--   a point) and are visible only inside that company.
--   community_point_notes attach to community_points (the deduped public
--   pool) and are visible to any company with full community access.
--
-- Appending an observation also updates the parent company_point's status
-- to whatever the observation says, so the map marker color reflects the
-- latest field call.

begin;

create table public.point_observations (
  id uuid primary key default gen_random_uuid(),
  company_point_id uuid not null
    references public.company_points(id) on delete cascade,
  company_id uuid not null
    references public.companies(id) on delete cascade,
  user_id uuid not null,
  status text not null check (status in ('found', 'suspect', 'record', 'destroyed')),
  body text not null default '' check (length(body) <= 4000),
  created_at timestamptz not null default now()
);

create index point_observations_point_created_idx
  on public.point_observations(company_point_id, created_at desc);

alter table public.point_observations enable row level security;
-- No direct policies. All access via SECURITY DEFINER RPCs below.

create or replace function public.add_point_observation(
  target_company_point_id uuid,
  observation_status text,
  observation_body text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  cp_company_id uuid;
  new_obs_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  if observation_status not in ('found', 'suspect', 'record', 'destroyed') then
    raise exception 'Status must be one of found / suspect / record / destroyed.';
  end if;

  if observation_body is not null and length(observation_body) > 4000 then
    raise exception 'Observation body is limited to 4000 characters.';
  end if;

  select cp.company_id into cp_company_id
  from public.company_points cp
  where cp.id = target_company_point_id;

  if cp_company_id is null then
    raise exception 'Point not found.';
  end if;

  if not public.is_company_member(cp_company_id) then
    raise exception 'You are not a member of the company that owns this point.';
  end if;

  insert into public.point_observations as po (
    company_point_id, company_id, user_id, status, body
  ) values (
    target_company_point_id,
    cp_company_id,
    auth.uid(),
    observation_status,
    coalesce(observation_body, '')
  )
  returning po.id into new_obs_id;

  update public.company_points cp
  set status = observation_status,
      updated_at = now()
  where cp.id = target_company_point_id;

  return new_obs_id;
end;
$$;

create or replace function public.list_point_observations(
  target_company_point_id uuid
) returns table (
  id uuid,
  status text,
  body text,
  user_id uuid,
  user_email text,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  cp_company_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select company_id into cp_company_id
  from public.company_points
  where id = target_company_point_id;

  if cp_company_id is null then
    return;
  end if;

  if not public.is_company_member(cp_company_id) then
    raise exception 'You are not a member of the company that owns this point.';
  end if;

  return query
  select o.id, o.status, o.body, o.user_id, p.email, o.created_at
  from public.point_observations o
  left join public.profiles p on p.id = o.user_id
  where o.company_point_id = target_company_point_id
  order by o.created_at desc;
end;
$$;

commit;
