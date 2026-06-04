-- In-app approval for rows that did not auto-import, without re-uploading.
--
-- requeue_storage_import_job  -> re-runs the worker on the file already in
--   storage (optionally with the monument filter off) so every located row
--   imports. Powers the "Re-run & import all located points" button.
-- promote_storage_import_rows -> inserts a user-selected set of rows (approved
--   review rows) into company_points, membership-checked, by delegating to the
--   existing storage insert (dedup + lat/long or projected transform).

begin;

create or replace function public.requeue_storage_import_job(
  target_import_job_id uuid,
  skip_marker_filter_in boolean default true
) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
as $$
declare
  job public.import_jobs;
begin
  select * into job from public.import_jobs where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  if job.import_mode <> 'storage_python' or job.raw_storage_path is null then
    raise exception 'This job has no uploaded file to reprocess.';
  end if;

  update public.import_jobs
  set
    skip_marker_filter = coalesce(skip_marker_filter_in, true),
    python_worker_status = 'queued',
    python_worker_message = 'Re-queued for reprocessing.',
    coordinate_warning = null,
    status = 'processing'
  where id = target_import_job_id;

  return jsonb_build_object('import_job_id', target_import_job_id, 'requeued', true);
end;
$$;

grant all on function public.requeue_storage_import_job(uuid, boolean) to anon;
grant all on function public.requeue_storage_import_job(uuid, boolean) to authenticated;
grant all on function public.requeue_storage_import_job(uuid, boolean) to service_role;

create or replace function public.promote_storage_import_rows(
  target_import_job_id uuid,
  points_json jsonb
) returns jsonb
    language plpgsql security definer
    set search_path to 'public'
as $$
declare
  job public.import_jobs;
begin
  select * into job from public.import_jobs where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  -- insert_storage_import_points_chunk does the dedup + lat/long/projected
  -- transform and the company_points insert; this wrapper just adds the
  -- membership gate so it is safe to expose to the app.
  return public.insert_storage_import_points_chunk(target_import_job_id, points_json, 1.0);
end;
$$;

grant all on function public.promote_storage_import_rows(uuid, jsonb) to anon;
grant all on function public.promote_storage_import_rows(uuid, jsonb) to authenticated;
grant all on function public.promote_storage_import_rows(uuid, jsonb) to service_role;

commit;
