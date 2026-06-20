-- Tier the Data Health span flag instead of one binary "suspicious" line.
-- Reality: a 50-mile threshold treated normal regional / corridor work (DOT,
-- pipelines, transmission lines, a master compilation file of all your jobs
-- in a region) as bad, when it's just a wide job. Real EPSG-mismatch
-- corruption usually produces 300+ mi offsets; total-garbage data lands
-- thousands of miles off.
--
-- Returns severity:
--   normal       — span < 100 mi (typical single site)
--   wide         — 100-300 mi   (regional / corridor / multi-job master file)
--   suspicious   — 300-1000 mi  (likely a wrong EPSG)
--   very_wrong   — > 1000 mi    (almost certainly corrupt data)
--
-- is_suspicious is preserved (boolean) for the existing UI flag — it now
-- triggers only at the 'suspicious' tier or higher (>= 300 mi), so wide
-- regional jobs don't get the alarming red treatment.

begin;

drop function if exists public.audit_company_import_jobs(uuid);

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
  severity text,
  is_suspicious boolean
)
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  tier_wide_miles       constant double precision := 100.0;
  tier_suspicious_miles constant double precision := 300.0;
  tier_very_wrong_miles constant double precision := 1000.0;
  miles_per_lat_degree  constant double precision := 69.0;
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
    (ws.computed_span_miles / 2.0) as max_distance_from_centroid_miles,
    case
      when ws.computed_span_miles >= tier_very_wrong_miles then 'very_wrong'
      when ws.computed_span_miles >= tier_suspicious_miles then 'suspicious'
      when ws.computed_span_miles >= tier_wide_miles then 'wide'
      else 'normal'
    end as severity,
    (ws.computed_span_miles >= tier_suspicious_miles) as is_suspicious
  from with_span ws
  order by ws.computed_span_miles desc nulls last, ws.created_at desc;
end;
$$;

grant execute on function public.audit_company_import_jobs(uuid) to authenticated;
grant execute on function public.audit_company_import_jobs(uuid) to service_role;

commit;
