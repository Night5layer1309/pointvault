-- Data Health: audit every import job a company has run and surface ones
-- with suspicious geographic spread (almost always means wrong EPSG declared
-- at upload time, which scattered points hundreds of miles off). Plus a
-- one-call wipe for the bad job's points so the user can clean and re-import.
--
-- audit_company_import_jobs returns one row per import job: point count,
-- centroid lat/lng, span in miles (the diagonal of the bounding box of all
-- points in the job), and the max distance any single point sits from the
-- centroid. A legitimate job is usually within a few miles; a job with span >
-- ~50 miles is almost certainly mis-projected.
--
-- delete_storage_import_job_points wipes every company_point belonging to a
-- given import job. Membership-checked. Idempotent.

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
  meters_per_mile constant double precision := 1609.344;
  suspicious_span_miles constant double precision := 50.0;
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  return query
  with job_points as (
    select
      ij.id as import_job_id,
      ij.source_file_name,
      ij.declared_coordinate_system,
      ij.declared_epsg,
      ij.created_at,
      cp.geom
    from public.import_jobs ij
    left join public.company_points cp
      on cp.import_job_id = ij.id
      and cp.company_id = target_company_id
    where ij.company_id = target_company_id
  ),
  per_job as (
    select
      jp.import_job_id,
      max(jp.source_file_name) as source_file_name,
      max(jp.declared_coordinate_system) as declared_coordinate_system,
      max(jp.declared_epsg) as declared_epsg,
      max(jp.created_at) as created_at,
      count(jp.geom) as point_count,
      avg(st_y(jp.geom::geometry)) as centroid_lat,
      avg(st_x(jp.geom::geometry)) as centroid_lng,
      case when count(jp.geom) > 1 then
        st_distance(
          st_pointn(st_boundary(st_envelope(st_collect(jp.geom::geometry))::geography::geometry), 1)::geography,
          st_pointn(st_boundary(st_envelope(st_collect(jp.geom::geometry))::geography::geometry), 3)::geography
        ) / meters_per_mile
      else 0
      end as span_miles
    from job_points jp
    group by jp.import_job_id
  )
  select
    pj.import_job_id,
    pj.source_file_name,
    pj.declared_coordinate_system,
    pj.declared_epsg,
    pj.created_at,
    pj.point_count,
    pj.centroid_lat,
    pj.centroid_lng,
    pj.span_miles,
    coalesce((
      select max(
        st_distance(
          cp2.geom::geography,
          st_setsrid(st_makepoint(pj.centroid_lng, pj.centroid_lat), 4326)::geography
        ) / meters_per_mile
      )
      from public.company_points cp2
      where cp2.import_job_id = pj.import_job_id
        and cp2.company_id = target_company_id
    ), 0) as max_distance_from_centroid_miles,
    (pj.span_miles > suspicious_span_miles) as is_suspicious
  from per_job pj
  order by pj.span_miles desc nulls last, pj.created_at desc;
end;
$$;

grant execute on function public.audit_company_import_jobs(uuid) to authenticated;
grant execute on function public.audit_company_import_jobs(uuid) to service_role;

create or replace function public.delete_storage_import_job_points(target_import_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  job_row public.import_jobs;
  deleted_count bigint;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select * into job_row
  from public.import_jobs
  where id = target_import_job_id;

  if job_row.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job_row.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  delete from public.company_points
  where company_id = job_row.company_id
    and import_job_id = target_import_job_id;

  get diagnostics deleted_count = row_count;

  return jsonb_build_object(
    'deleted', deleted_count,
    'import_job_id', target_import_job_id,
    'source_file_name', job_row.source_file_name
  );
end;
$$;

grant execute on function public.delete_storage_import_job_points(uuid) to authenticated;
grant execute on function public.delete_storage_import_job_points(uuid) to service_role;

commit;
