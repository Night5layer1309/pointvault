-- Fix 'column reference id is ambiguous' inside nearby_visible_points.
--
-- The function uses RETURNS TABLE with OUT parameters named exactly like
-- columns on company_points / community_points (id, point_id, name,
-- status, etc.). PL/pgSQL flags these as ambiguous in queries when the
-- runtime can't decide whether 'id' means the OUT-parameter variable or
-- the column. The function worked historically but a Postgres / Supabase
-- version bump made the check stricter and started rejecting every map
-- load with "column reference 'id' is ambiguous".
--
-- Fix:
--   - Add '#variable_conflict use_column' so the COLUMN always wins when
--     a name clash exists.
--   - Drop the redundant 'as <name>' column aliases (RETURNS TABLE
--     assigns by position, so the aliases never did anything except add
--     names that could shadow real columns).
--   - Use 'order by 20' (the column position of distance_feet) instead
--     of the name, so ORDER BY can't see the OUT parameter at all.

begin;

create or replace function public.nearby_visible_points(
  target_company_id uuid,
  user_lat double precision,
  user_lng double precision,
  radius_feet double precision default 5280,
  result_limit integer default 500,
  requested_scope text default 'all'::text
) returns table(
  access_level text,
  visibility text,
  id text,
  point_id text,
  name text,
  marker_type text,
  description text,
  status text,
  reliability text,
  latitude double precision,
  longitude double precision,
  northing double precision,
  easting double precision,
  elevation double precision,
  coordinate_system text,
  epsg integer,
  source_file text,
  details_locked boolean,
  coordinates_locked boolean,
  distance_feet double precision
)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  community_access text;
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  community_access := public.company_community_access(target_company_id);

  return query
  select
    'full'::text,
    cp.visibility::text,
    cp.id::text,
    cp.point_id::text,
    cp.name::text,
    cp.marker_type::text,
    cp.description::text,
    cp.status::text,
    cp.reliability::text,
    cp.latitude,
    cp.longitude,
    cp.northing,
    cp.easting,
    cp.elevation,
    cp.coordinate_system::text,
    cp.epsg,
    cp.source_file::text,
    false,
    false,
    (st_distance(cp.geom::geography, st_setsrid(st_makepoint(user_lng, user_lat), 4326)::geography) * 3.28084)::double precision
  from public.company_points cp
  where cp.company_id = target_company_id
    and cp.geom is not null
    and requested_scope in ('all', 'company', 'community')
    and (requested_scope <> 'community' or cp.visibility = 'community')
    and (st_distance(cp.geom::geography, st_setsrid(st_makepoint(user_lng, user_lat), 4326)::geography) * 3.28084) <= radius_feet
  order by 20 asc
  limit result_limit;

  if requested_scope in ('all', 'community') and community_access <> 'private' and community_access <> 'suspended' then
    return query
    select
      community_access,
      'community'::text,
      c.id::text,
      case when community_access in ('contributor', 'balanced', 'low_contribution') then c.id::text else null end,
      case when community_access in ('contributor', 'balanced', 'low_contribution') then coalesce(c.canonical_marker_type, 'Community Point') else 'Community Point Available' end,
      case when community_access in ('contributor', 'balanced', 'low_contribution') then c.canonical_marker_type else null end,
      case when community_access in ('contributor', 'balanced', 'low_contribution') then c.best_description else null end,
      case when community_access in ('contributor', 'balanced') then 'found' else null end,
      case when community_access in ('contributor', 'balanced') then 'C' else null end,
      c.latitude,
      c.longitude,
      null::double precision,
      null::double precision,
      null::double precision,
      null::text,
      null::integer,
      null::text,
      community_access = 'viewing_only',
      community_access in ('viewing_only', 'low_contribution'),
      (st_distance(c.geom::geography, st_setsrid(st_makepoint(user_lng, user_lat), 4326)::geography) * 3.28084)::double precision
    from public.community_points c
    where not exists (
      select 1
      from public.community_point_observations o
      where o.community_point_id = c.id
        and o.company_id = target_company_id
    )
      and (st_distance(c.geom::geography, st_setsrid(st_makepoint(user_lng, user_lat), 4326)::geography) * 3.28084) <= radius_feet
    order by 20 asc
    limit result_limit;

    update public.companies
    set community_points_viewed_count = community_points_viewed_count + 1
    where id = target_company_id;
  end if;
end;
$$;

commit;
