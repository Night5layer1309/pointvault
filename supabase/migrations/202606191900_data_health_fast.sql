-- Replace audit_company_import_jobs with a cheap version. The original used
-- ST_Collect + ST_Envelope per job plus a per-point subquery, which timed out
-- (`canceling statement due to statement timeout`) on companies with tens of
-- thousands of points across many imports. The metrics we actually need —
-- centroid, span, suspicious flag — can be computed from simple min/max/avg
-- aggregates of latitude and longitude, which is a single index-friendly
-- group-by with no geometry collection.

begin;

create or replace function public.audit_company_import_jobs(target_company_id uuid)
returns table (
  import_job_id uuid,
  source_file_name text,
  declared_coordinate_system text,
  declared_epsg integer,
  created_at timestamptz,
  point_count bigint,
  centroid_lat double precision,
  centroid_lng double precision,
  span_miles double precision,
  max_distance_from_centroid_miles double precision,
  is_suspicious boolean
)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  suspicious_span_miles constant double precision := 50.0;
  -- ~69 miles per degree of latitude (true everywhere). For longitude,
  -- multiply by cos(latitude) to handle the convergence toward the poles.
  miles_per_lat_degree constant double precision := 69.0;
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  return query
  with per_job as (
    select
      ij.id as import_job_id,
      max(ij.source_file_name) as source_file_name,
      max(ij.declared_coordinate_system) as declared_coordinate_system,
      max(ij.declared_epsg) as declared_epsg,
      max(ij.created_at) as created_at,
      count(cp.latitude) as point_count,
      avg(cp.latitude) as centroid_lat,
      avg(cp.longitude) as centroid_lng,
      min(cp.latitude) as min_lat,
      max(cp.latitude) as max_lat,
      min(cp.longitude) as min_lng,
      max(cp.longitude) as max_lng
    from public.import_jobs ij
    left join public.company_points cp
      on cp.import_job_id = ij.id
      and cp.company_id = target_company_id
    where ij.company_id = target_company_id
    group by ij.id
  ),
  with_span as (
    select
      *,
      case
        when point_count > 1 then
          sqrt(
            power((max_lat - min_lat) * miles_per_lat_degree, 2)
            + power((max_lng - min_lng) * miles_per_lat_degree
                * cos(radians(coalesce(centroid_lat, 0))), 2)
          )
        else 0.0
      end as computed_span_miles
    from per_job
  )
  select
    ws.import_job_id,
    ws.source_file_name,
    ws.declared_coordinate_system,
    ws.declared_epsg,
    ws.created_at,
    ws.point_count,
    ws.centroid_lat,
    ws.centroid_lng,
    ws.computed_span_miles as span_miles,
    -- Half the bbox diagonal — upper-bound approximation of how far any
    -- single point could be from the centroid. Exact per-point Haversine is
    -- too slow to compute on demand for large companies.
    (ws.computed_span_miles / 2.0) as max_distance_from_centroid_miles,
    (ws.computed_span_miles > suspicious_span_miles) as is_suspicious
  from with_span ws
  order by ws.computed_span_miles desc nulls last, ws.created_at desc;
end;
$$;

grant execute on function public.audit_company_import_jobs(uuid) to authenticated;
grant execute on function public.audit_company_import_jobs(uuid) to service_role;

commit;
