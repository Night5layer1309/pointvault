-- Import robustness fixes (regions + upload styles).
--
-- R1  Wrong-region guard: report the centroid of each import and raise a
--     coordinate_warning when points land on "null island" or span an
--     implausibly large area, so a wrong zone can't silently ship.
-- R2  Bad/unknown EPSG no longer crashes the whole job with a cryptic
--     PostGIS error -- we validate the SRID up front and fail with a clear
--     message the uploader can act on.
-- R3  Latitude/longitude inputs are now first-class on the storage/worker
--     path: a row with valid lat/long is transformed straight to WGS84 even
--     when it has no northing/easting.
-- U1/U2/U6  skip_marker_filter lets a single upload bypass the monument-code
--     gate so coordinate-only / non-survey files import every valid row.

begin;

-- ---------------------------------------------------------------------------
-- New columns
-- ---------------------------------------------------------------------------
alter table public.import_jobs
  add column if not exists skip_marker_filter boolean not null default false,
  add column if not exists import_centroid_lat double precision,
  add column if not exists import_centroid_lng double precision,
  add column if not exists coordinate_warning text;

-- ---------------------------------------------------------------------------
-- create_storage_import_job: gains skip_marker_filter. Drop the 6-arg version
-- first so the new param is not an overload.
-- ---------------------------------------------------------------------------
drop function if exists public.create_storage_import_job(uuid, text, integer, text, text, jsonb);

create or replace function public.create_storage_import_job(
  target_company_id uuid,
  source_file_name text,
  declared_epsg integer default null::integer,
  declared_coordinate_system text default null::text,
  default_visibility text default 'company'::text,
  column_mapping_json jsonb default null::jsonb,
  skip_marker_filter_in boolean default false
) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
as $$
#variable_conflict use_column
declare
  job_id uuid;
  safe_file_name text;
  raw_path text;
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  if default_visibility not in ('company', 'community') then
    raise exception 'default_visibility must be company or community.';
  end if;

  safe_file_name := regexp_replace(coalesce(source_file_name, 'upload.txt'), '[^a-zA-Z0-9._ -]+', '_', 'g');

  insert into public.import_jobs (
    company_id,
    created_by,
    source_file_name,
    declared_epsg,
    declared_coordinate_system,
    default_visibility,
    column_mapping,
    skip_marker_filter,
    import_mode,
    storage_bucket,
    python_worker_status,
    python_worker_message,
    status
  )
  values (
    target_company_id,
    auth.uid(),
    safe_file_name,
    declared_epsg,
    declared_coordinate_system,
    default_visibility,
    column_mapping_json,
    coalesce(skip_marker_filter_in, false),
    'storage_python',
    'pointvault-imports',
    'not_started',
    'Storage import job created.',
    'staged'
  )
  returning id into job_id;

  raw_path := public.pointvault_import_storage_prefix(target_company_id, job_id) || '/raw/' || safe_file_name;

  update public.import_jobs
  set raw_storage_path = raw_path
  where id = job_id;

  return jsonb_build_object(
    'import_job_id', job_id,
    'bucket', 'pointvault-imports',
    'raw_path', raw_path,
    'prefix', public.pointvault_import_storage_prefix(target_company_id, job_id)
  );
end;
$$;

grant all on function public.create_storage_import_job(uuid, text, integer, text, text, jsonb, boolean) to anon;
grant all on function public.create_storage_import_job(uuid, text, integer, text, text, jsonb, boolean) to authenticated;
grant all on function public.create_storage_import_job(uuid, text, integer, text, text, jsonb, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- claim_next_storage_import_job: hand the worker the new skip_marker_filter
-- flag (alongside the existing column_mapping).
-- ---------------------------------------------------------------------------
create or replace function public.claim_next_storage_import_job() returns jsonb
    language plpgsql security definer
    set search_path to 'public'
as $$
declare
  job public.import_jobs;
begin
  select * into job
  from public.import_jobs
  where import_mode = 'storage_python'
    and python_worker_status = 'queued'
    and raw_storage_path is not null
  order by created_at asc
  limit 1
  for update skip locked;

  if job.id is null then
    return jsonb_build_object('job', null);
  end if;

  update public.import_jobs
  set
    python_worker_status = 'processing',
    python_worker_message = 'Python worker started.',
    python_started_at = now(),
    status = 'processing'
  where id = job.id;

  return jsonb_build_object(
    'job', jsonb_build_object(
      'id', job.id,
      'company_id', job.company_id,
      'bucket', coalesce(job.storage_bucket, 'pointvault-imports'),
      'raw_storage_path', job.raw_storage_path,
      'declared_epsg', job.declared_epsg,
      'declared_coordinate_system', job.declared_coordinate_system,
      'default_visibility', job.default_visibility,
      'column_mapping', job.column_mapping,
      'skip_marker_filter', job.skip_marker_filter,
      'prefix', public.pointvault_import_storage_prefix(job.company_id, job.id)
    )
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- insert_storage_import_points_chunk: lat/long support (R3) + EPSG validation
-- (R2). Builds each point's geometry from lat/long when present, otherwise by
-- transforming northing/easting with the declared EPSG. Dedup keeps the fast
-- indexed northing/easting range for projected rows and falls back to a
-- geographic distance check for lat/long-only rows.
-- ---------------------------------------------------------------------------
create or replace function public.insert_storage_import_points_chunk(target_import_job_id uuid, points_json jsonb, duplicate_tolerance_ft double precision default 1.0) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
as $$
declare
  job public.import_jobs;
  effective_epsg integer;
  inserted_count bigint := 0;
  skipped_count bigint := 0;
  has_projected_rows boolean := false;
begin
  select * into job
  from public.import_jobs
  where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  effective_epsg := coalesce(job.declared_epsg, 2238);

  -- R2: are there any rows that need a projected transform (no usable lat/long)?
  select exists (
    select 1
    from jsonb_array_elements(points_json) p
    where public.safe_double(p ->> 'northing') is not null
      and public.safe_double(p ->> 'easting') is not null
      and not (
        public.safe_double(p ->> 'latitude') is not null
        and public.safe_double(p ->> 'longitude') is not null
        and public.safe_double(p ->> 'latitude') between -90 and 90
        and public.safe_double(p ->> 'longitude') between -180 and 180
      )
  ) into has_projected_rows;

  -- R2: only the projected rows need the EPSG. Probe the transform once up
  -- front (schema-agnostic - does not assume where spatial_ref_sys lives) so an
  -- unknown/unsupported SRID produces a clear, actionable error instead of a
  -- cryptic crash that fails the whole job mid-insert.
  if has_projected_rows then
    begin
      perform st_transform(st_setsrid(st_makepoint(0, 0), effective_epsg), 4326);
    exception
      when others then
        raise exception
          'Unknown or unsupported coordinate system EPSG % - pick a supported EPSG/zone for this file.',
          effective_epsg;
    end;
  end if;

  with incoming as (
    select
      row_number() over () as row_number,
      nullif(trim(p ->> 'point'), '') as point_id,
      public.safe_double(p ->> 'northing') as northing,
      public.safe_double(p ->> 'easting') as easting,
      public.safe_double(p ->> 'elevation') as elevation,
      public.safe_double(p ->> 'latitude') as latitude,
      public.safe_double(p ->> 'longitude') as longitude,
      nullif(trim(p ->> 'description'), '') as description,
      nullif(trim(p ->> 'source_file'), '') as source_file,
      p as raw_json
    from jsonb_array_elements(points_json) p
  ),
  valid as (
    select
      i.*,
      case
        when i.latitude between -90 and 90 and i.longitude between -180 and 180
          then st_setsrid(st_makepoint(i.longitude, i.latitude), 4326)
        when i.northing is not null and i.easting is not null
          then st_transform(st_setsrid(st_makepoint(i.easting, i.northing), effective_epsg), 4326)
        else null
      end as geom
    from incoming i
    where (i.northing is not null and i.easting is not null)
       or (i.latitude between -90 and 90 and i.longitude between -180 and 180)
  ),
  not_existing as (
    select v.*
    from valid v
    where v.geom is not null
      and not exists (
        select 1
        from public.company_points cp
        where cp.company_id = job.company_id
          and (
            (v.northing is not null and v.easting is not null
              and cp.northing between v.northing - duplicate_tolerance_ft and v.northing + duplicate_tolerance_ft
              and cp.easting between v.easting - duplicate_tolerance_ft and v.easting + duplicate_tolerance_ft)
            or
            ((v.northing is null or v.easting is null)
              and cp.geom is not null
              and st_dwithin(cp.geom::geography, v.geom::geography, duplicate_tolerance_ft / 3.28084))
          )
      )
  )
  insert into public.company_points (
    company_id,
    import_job_id,
    point_id,
    name,
    marker_type,
    description,
    latitude,
    longitude,
    northing,
    easting,
    elevation,
    coordinate_system,
    epsg,
    source_file,
    source_row_number,
    raw_json,
    visibility,
    shared_at,
    geom
  )
  select
    job.company_id,
    job.id,
    point_id,
    coalesce(point_id, description, 'Imported Point'),
    description,
    description,
    st_y(geom),
    st_x(geom),
    northing,
    easting,
    elevation,
    job.declared_coordinate_system,
    effective_epsg,
    coalesce(source_file, job.source_file_name),
    row_number,
    raw_json,
    job.default_visibility,
    case when job.default_visibility = 'community' then now() else null end,
    geom
  from not_existing;

  get diagnostics inserted_count = row_count;

  skipped_count := jsonb_array_length(points_json) - inserted_count;

  update public.import_jobs
  set
    promoted_rows = coalesce(promoted_rows, 0) + inserted_count,
    status = 'promoted',
    promoted_at = now()
  where id = target_import_job_id;

  return jsonb_build_object(
    'inserted_points', inserted_count,
    'skipped_points', skipped_count
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- mark_storage_import_processed: compute the import centroid + a coordinate
-- sanity warning (R1) so the uploader can immediately see where the points
-- actually landed.
-- ---------------------------------------------------------------------------
create or replace function public.mark_storage_import_processed(target_import_job_id uuid, accepted_path text, review_path text default null::text, rejected_path text default null::text, duplicate_path text default null::text, kml_path text default null::text, summary_path text default null::text, total_rows bigint default 0, accepted_rows bigint default 0, rejected_rows bigint default 0, duplicate_rows bigint default 0, cleaned_file_size_bytes bigint default null::bigint, worker_message text default 'Python processing complete.'::text) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
as $$
declare
  job public.import_jobs;
  pt_count bigint := 0;
  centroid_lat double precision;
  centroid_lng double precision;
  lat_span double precision;
  lng_span double precision;
  warning text := null;
begin
  select * into job
  from public.import_jobs
  where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  select
    count(*),
    avg(latitude),
    avg(longitude),
    coalesce(max(latitude) - min(latitude), 0),
    coalesce(max(longitude) - min(longitude), 0)
  into pt_count, centroid_lat, centroid_lng, lat_span, lng_span
  from public.company_points
  where import_job_id = target_import_job_id
    and latitude is not null
    and longitude is not null;

  if pt_count > 0 then
    if abs(centroid_lat) < 0.5 and abs(centroid_lng) < 0.5 then
      warning := 'Imported points landed near 0,0 (null island) - the coordinate system is almost certainly wrong for this file.';
    elsif lat_span > 3 or lng_span > 3 then
      warning := 'Imported points span an unusually large area (' ||
        round(greatest(lat_span, lng_span)::numeric, 1) ||
        ' degrees) - double-check the coordinate system/zone is correct.';
    end if;
  end if;

  update public.import_jobs
  set
    processed_storage_path = accepted_path,
    accepted_storage_path = accepted_path,
    review_storage_path = review_path,
    rejected_storage_path = rejected_path,
    duplicate_storage_path = duplicate_path,
    kml_storage_path = kml_path,
    summary_storage_path = summary_path,
    total_rows = mark_storage_import_processed.total_rows,
    accepted_rows = mark_storage_import_processed.accepted_rows,
    rejected_rows = mark_storage_import_processed.rejected_rows,
    duplicate_rows = mark_storage_import_processed.duplicate_rows,
    cleaned_file_size_bytes = mark_storage_import_processed.cleaned_file_size_bytes,
    import_centroid_lat = centroid_lat,
    import_centroid_lng = centroid_lng,
    coordinate_warning = warning,
    python_worker_status = 'processed',
    python_worker_message = worker_message,
    python_finished_at = now(),
    status = 'processed',
    processed_at = now()
  where id = target_import_job_id;

  return jsonb_build_object(
    'import_job_id', target_import_job_id,
    'centroid_lat', centroid_lat,
    'centroid_lng', centroid_lng,
    'coordinate_warning', warning
  );
end;
$$;

commit;
