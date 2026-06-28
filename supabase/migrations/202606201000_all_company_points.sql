-- "Show all my points" view — for desktop / power-user mode where the user
-- wants to pan around the map and see every point their company has
-- without manually triggering Search This Area for each region.
--
-- nearby_visible_points requires a user_lat/user_lng + radius (because it
-- computes per-row distance and sorts on it). For the see-everything case we
-- don't need distance; we just need a flat list of the company's own points
-- (visibility = company OR community owned by us). Other companies'
-- community-pool points are excluded — those are still browse-by-area only.
--
-- result_limit defaults to 50,000 which comfortably covers heavy users
-- (master file imports, etc.) while keeping the payload bounded.

begin;

create or replace function public.all_company_points(
  target_company_id uuid,
  result_limit integer default 50000
)
returns table (
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
stable
set search_path to 'public'
as $$
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  return query
  select
    'full'::text as access_level,
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
    false as details_locked,
    false as coordinates_locked,
    null::double precision as distance_feet
  from public.company_points cp
  where cp.company_id = target_company_id
    and cp.geom is not null
  order by cp.created_at desc
  limit greatest(1, least(coalesce(result_limit, 50000), 100000));
end;
$$;

grant execute on function public.all_company_points(uuid, integer) to authenticated;
grant execute on function public.all_company_points(uuid, integer) to service_role;

commit;
