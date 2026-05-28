-- Let the uploader explicitly label which file column is which field, so the
-- Python worker maps columns by the user's labels instead of guessing the
-- layout (which caused false rejections).
--
-- column_mapping shape (all indices 0-based; omit a field to leave it unmapped):
--   { "has_header": true, "columns": { "point": 0, "northing": 1, "easting": 2,
--                                       "elevation": 3, "description": 4 } }
-- When column_mapping is null the worker falls back to its existing auto-detect.

begin;

alter table public.import_jobs
  add column if not exists column_mapping jsonb;

-- create_storage_import_job gains a column_mapping argument. The old 5-arg
-- signature is dropped first so adding the param doesn't create an overload.
drop function if exists public.create_storage_import_job(uuid, text, integer, text, text);

create or replace function public.create_storage_import_job(
  target_company_id uuid,
  source_file_name text,
  declared_epsg integer default null::integer,
  declared_coordinate_system text default null::text,
  default_visibility text default 'company'::text,
  column_mapping_json jsonb default null::jsonb
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

grant all on function public.create_storage_import_job(uuid, text, integer, text, text, jsonb) to anon;
grant all on function public.create_storage_import_job(uuid, text, integer, text, text, jsonb) to authenticated;
grant all on function public.create_storage_import_job(uuid, text, integer, text, text, jsonb) to service_role;

-- claim_next_storage_import_job now hands the worker the saved column_mapping.
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
      'prefix', public.pointvault_import_storage_prefix(job.company_id, job.id)
    )
  );
end;
$$;

commit;
