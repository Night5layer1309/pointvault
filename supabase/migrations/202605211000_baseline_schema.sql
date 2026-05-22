--
-- PostgreSQL database dump
--


-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.10

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

-- CREATE SCHEMA public; -- skipped: exists by default


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: accept_company_invitation(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_company_invitation(invite_token uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  invite_row public.company_invites;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to accept an invite.';
  end if;

  select * into invite_row
  from public.company_invites
  where token = invite_token
    and accepted_at is null
    and expires_at > now();

  if invite_row.id is null then
    raise exception 'Invite not found, already used, or expired.';
  end if;

  if lower(coalesce(auth.jwt() ->> 'email', '')) <> lower(invite_row.email) then
    raise exception 'This invite was sent to a different email address.';
  end if;

  insert into public.company_memberships (company_id, user_id, role, status)
  values (invite_row.company_id, auth.uid(), invite_row.role, 'active')
  on conflict (company_id, user_id) do update
    set role = excluded.role,
        status = 'active';

  update public.company_invites
  set accepted_at = now(), accepted_by = auth.uid()
  where id = invite_row.id;

  return invite_row.company_id;
end;
$$;


--
-- Name: apply_company_marker_alias(uuid, text, text, boolean, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_company_marker_alias(target_company_id uuid, target_signature text, fallback_marker_type text, fallback_accepted boolean, fallback_reason text) RETURNS TABLE(marker_type text, is_accepted_marker boolean, rejection_reason text)
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
declare
  alias_row public.company_marker_aliases;
begin
  if target_signature is not null then
    select * into alias_row
    from public.company_marker_aliases a
    where a.company_id = target_company_id
      and a.alias_signature = target_signature
    limit 1;
  end if;

  if alias_row.id is not null then
    marker_type := alias_row.normalized_marker_type;
    is_accepted_marker := alias_row.is_accepted_marker;
    rejection_reason := case when alias_row.is_accepted_marker then null else 'Company alias rejected' end;
    return next;
    return;
  end if;

  marker_type := fallback_marker_type;
  is_accepted_marker := fallback_accepted;
  rejection_reason := fallback_reason;
  return next;
end;
$$;


--
-- Name: claim_next_storage_import_job(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_next_storage_import_job() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
      'prefix', public.pointvault_import_storage_prefix(job.company_id, job.id)
    )
  );
end;
$$;


--
-- Name: cleanup_company_duplicate_points(uuid, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_company_duplicate_points(target_company_id uuid, duplicate_tolerance_ft double precision DEFAULT 1.0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  deleted_count bigint := 0;
begin
  if not public.is_company_owner_or_admin(target_company_id) then
    raise exception 'Only a company owner or admin can clean duplicate company points.';
  end if;

  with ranked as (
    select
      cp.id,
      row_number() over (
        partition by
          cp.company_id,
          floor(cp.northing / greatest(duplicate_tolerance_ft, 0.01)),
          floor(cp.easting / greatest(duplicate_tolerance_ft, 0.01))
        order by cp.created_at asc, cp.id asc
      ) as rn
    from public.company_points cp
    where cp.company_id = target_company_id
      and cp.northing is not null
      and cp.easting is not null
  ),
  doomed as (
    select id
    from ranked
    where rn > 1
  ),
  deleted_obs as (
    delete from public.community_point_observations o
    using doomed d
    where o.company_point_id = d.id
    returning o.id
  ),
  deleted_points as (
    delete from public.company_points cp
    using doomed d
    where cp.id = d.id
    returning cp.id
  )
  select count(*) into deleted_count
  from deleted_points;

  update public.companies
  set community_points_shared_count = (
    select count(*)
    from public.community_point_observations o
    where o.company_id = target_company_id
  )
  where id = target_company_id;

  return jsonb_build_object(
    'deleted_duplicate_points', deleted_count,
    'duplicate_tolerance_ft', duplicate_tolerance_ft
  );
end;
$$;


--
-- Name: clear_company_points_for_storage_import(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.clear_company_points_for_storage_import(target_import_job_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  deleted_count bigint := 0;
begin
  delete from public.community_point_observations o
  where o.company_point_id in (
    select cp.id
    from public.company_points cp
    where cp.import_job_id = target_import_job_id
  );

  delete from public.company_points cp
  where cp.import_job_id = target_import_job_id;

  get diagnostics deleted_count = row_count;

  update public.import_jobs
  set promoted_rows = 0
  where id = target_import_job_id;

  return jsonb_build_object(
    'deleted_points', deleted_count
  );
end;
$$;


--
-- Name: company_community_access(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.company_community_access(target_company_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  company_row public.companies;
  calculated_status text;
begin
  select * into company_row from public.companies where id = target_company_id;

  if company_row.id is null then
    return 'private';
  end if;

  if company_row.community_access_override is not null then
    return company_row.community_access_override;
  end if;

  if not company_row.community_sharing_enabled then
    return 'private';
  end if;

  if company_row.community_points_shared_count = 0 then
    return 'viewing_only';
  end if;

  if company_row.community_points_shared_count < 100 then
    return 'low_contribution';
  end if;

  if company_row.community_points_viewed_count > 0
     and company_row.community_points_shared_count::numeric / greatest(company_row.community_points_viewed_count, 1)::numeric >= 0.25 then
    calculated_status := 'balanced';
  else
    calculated_status := 'contributor';
  end if;

  return calculated_status;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text,
    owner_id uuid NOT NULL,
    plan_status text DEFAULT 'trial'::text NOT NULL,
    seat_limit integer DEFAULT 5 NOT NULL,
    stripe_customer_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    community_sharing_enabled boolean DEFAULT false NOT NULL,
    community_access_override text,
    community_points_shared_count bigint DEFAULT 0 NOT NULL,
    community_points_viewed_count bigint DEFAULT 0 NOT NULL,
    last_community_share_at timestamp with time zone,
    CONSTRAINT companies_community_access_override_check CHECK ((community_access_override = ANY (ARRAY['private'::text, 'viewing_only'::text, 'low_contribution'::text, 'contributor'::text, 'balanced'::text, 'suspended'::text]))),
    CONSTRAINT companies_plan_status_check CHECK ((plan_status = ANY (ARRAY['trial'::text, 'active'::text, 'past_due'::text, 'canceled'::text]))),
    CONSTRAINT companies_seat_limit_check CHECK ((seat_limit > 0))
);


--
-- Name: create_company_with_owner(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_company_with_owner(company_name text, company_slug text DEFAULT NULL::text, full_name text DEFAULT NULL::text) RETURNS public.companies
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  created_company public.companies;
  base_slug text;
  final_slug text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to create a company.';
  end if;

  if nullif(trim(company_name), '') is null then
    raise exception 'Company name is required.';
  end if;

  base_slug := lower(regexp_replace(coalesce(nullif(trim(company_slug), ''), trim(company_name)), '[^a-zA-Z0-9]+', '-', 'g'));
  final_slug := trim(both '-' from base_slug);

  if final_slug = '' then
    final_slug := 'company-' || left(gen_random_uuid()::text, 8);
  end if;

  insert into public.profiles (id, email, full_name)
  values (auth.uid(), auth.jwt() ->> 'email', coalesce(full_name, ''))
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(nullif(excluded.full_name, ''), public.profiles.full_name);

  insert into public.companies (name, slug, owner_id)
  values (trim(company_name), final_slug, auth.uid())
  returning * into created_company;

  insert into public.company_memberships (company_id, user_id, role, status)
  values (created_company.id, auth.uid(), 'owner', 'active')
  on conflict (company_id, user_id) do update set role = 'owner', status = 'active';

  return created_company;
end;
$$;


--
-- Name: create_import_job(uuid, text, integer, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_import_job(target_company_id uuid, source_file_name text, declared_epsg integer DEFAULT NULL::integer, declared_coordinate_system text DEFAULT NULL::text, default_visibility text DEFAULT 'company'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job_id uuid;
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  if default_visibility not in ('company', 'community') then
    raise exception 'default_visibility must be company or community.';
  end if;

  insert into public.import_jobs (
    company_id,
    created_by,
    source_file_name,
    declared_epsg,
    declared_coordinate_system,
    default_visibility
  )
  values (
    target_company_id,
    auth.uid(),
    source_file_name,
    declared_epsg,
    declared_coordinate_system,
    default_visibility
  )
  returning id into job_id;

  return job_id;
end;
$$;


--
-- Name: create_storage_import_job(uuid, text, integer, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_storage_import_job(target_company_id uuid, source_file_name text, declared_epsg integer DEFAULT NULL::integer, declared_coordinate_system text DEFAULT NULL::text, default_visibility text DEFAULT 'company'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: decide_import_review_group(uuid, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.decide_import_review_group(target_review_group_id uuid, decision text, normalized_marker_type text DEFAULT NULL::text, save_as_company_alias boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  rg public.import_review_groups;
  affected_count bigint;
  final_marker_type text;
begin
  select * into rg
  from public.import_review_groups
  where id = target_review_group_id;

  if rg.id is null then
    raise exception 'Review group not found.';
  end if;

  if not public.is_company_member(rg.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  if decision not in ('accepted', 'rejected_non_marker', 'needs_review') then
    raise exception 'Decision must be accepted, rejected_non_marker, or needs_review.';
  end if;

  final_marker_type := coalesce(normalized_marker_type, rg.suggested_marker_type, rg.review_signature);

  update public.import_review_groups
  set
    current_status = decision,
    suggested_marker_type = case when decision = 'accepted' then final_marker_type else suggested_marker_type end,
    decided_by = auth.uid(),
    decided_at = now()
  where id = target_review_group_id;

  update public.import_point_staging s
  set
    processing_status = decision,
    is_accepted_marker = decision = 'accepted',
    marker_type = case when decision = 'accepted' then final_marker_type else s.marker_type end,
    rejection_reason = case when decision = 'accepted' then null when decision = 'rejected_non_marker' then 'Rejected by review group' else s.rejection_reason end
  where s.import_job_id = rg.import_job_id
    and coalesce(s.review_signature, 'unknown') = rg.review_signature
    and s.processing_status in ('needs_review', 'rejected_non_marker', 'accepted');

  get diagnostics affected_count = row_count;

  if save_as_company_alias and decision in ('accepted', 'rejected_non_marker') then
    insert into public.company_marker_aliases (
      company_id,
      alias_signature,
      normalized_marker_type,
      is_accepted_marker,
      created_by
    )
    values (
      rg.company_id,
      rg.review_signature,
      final_marker_type,
      decision = 'accepted',
      auth.uid()
    )
    on conflict (company_id, alias_signature)
    do update set
      normalized_marker_type = excluded.normalized_marker_type,
      is_accepted_marker = excluded.is_accepted_marker;
  end if;

  perform public.fast_mark_import_duplicates(rg.import_job_id, 1.0);
  perform public.rebuild_import_review_groups(rg.import_job_id);
  perform public.refresh_import_job_counts(rg.import_job_id, true);

  return jsonb_build_object(
    'affected_rows', affected_count,
    'decision', decision,
    'marker_type', final_marker_type
  );
end;
$$;


--
-- Name: delete_company_point(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_company_point(target_company_point_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  cp public.company_points;
begin
  select * into cp
  from public.company_points
  where id = target_company_point_id;

  if cp.id is null then
    raise exception 'Company point not found.';
  end if;

  if not public.is_company_owner_or_admin(cp.company_id) then
    raise exception 'Only a company owner or admin can delete company points.';
  end if;

  delete from public.community_point_observations
  where company_point_id = cp.id;

  delete from public.company_points
  where id = cp.id;

  update public.companies
  set community_points_shared_count = (
    select count(*)
    from public.community_point_observations o
    where o.company_id = cp.company_id
  )
  where id = cp.company_id;

  return jsonb_build_object(
    'deleted_point_id', target_company_point_id,
    'company_id', cp.company_id
  );
end;
$$;


--
-- Name: detect_coordinate_quality(double precision, double precision, double precision, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.detect_coordinate_quality(raw_northing double precision, raw_easting double precision, raw_latitude double precision, raw_longitude double precision, declared_epsg integer) RETURNS TABLE(detected_epsg integer, coordinate_quality text, coordinate_message text)
    LANGUAGE plpgsql STABLE
    AS $$
declare
  zone_match public.coordinate_zones;
begin
  if raw_latitude is not null and raw_longitude is not null then
    if raw_latitude between -90 and 90 and raw_longitude between -180 and 180 then
      detected_epsg := 4326;
      coordinate_quality := 'valid';
      coordinate_message := 'Valid latitude/longitude.';
      return next;
      return;
    else
      detected_epsg := null;
      coordinate_quality := 'invalid';
      coordinate_message := 'Latitude/longitude outside valid range.';
      return next;
      return;
    end if;
  end if;

  if raw_northing is null or raw_easting is null then
    detected_epsg := declared_epsg;
    coordinate_quality := 'invalid';
    coordinate_message := 'Missing usable coordinates.';
    return next;
    return;
  end if;

  if declared_epsg is not null then
    select * into zone_match
    from public.coordinate_zones z
    where z.epsg = declared_epsg
      and (z.min_northing is null or raw_northing >= z.min_northing)
      and (z.max_northing is null or raw_northing <= z.max_northing)
      and (z.min_easting is null or raw_easting >= z.min_easting)
      and (z.max_easting is null or raw_easting <= z.max_easting)
    limit 1;

    if zone_match.id is not null then
      detected_epsg := zone_match.epsg;
      coordinate_quality := 'valid';
      coordinate_message := 'Coordinates are inside declared zone numeric range.';
      return next;
      return;
    end if;
  end if;

  select * into zone_match
  from public.coordinate_zones z
  where (z.min_northing is null or raw_northing >= z.min_northing)
    and (z.max_northing is null or raw_northing <= z.max_northing)
    and (z.min_easting is null or raw_easting >= z.min_easting)
    and (z.max_easting is null or raw_easting <= z.max_easting)
  order by case when z.epsg = declared_epsg then 0 else 1 end
  limit 1;

  if zone_match.id is not null then
    detected_epsg := zone_match.epsg;
    coordinate_quality := 'suspect';
    coordinate_message := 'Coordinates match a known numeric zone range, but should be verified.';
    return next;
    return;
  end if;

  detected_epsg := declared_epsg;
  coordinate_quality := 'invalid';
  coordinate_message := 'Coordinates do not match configured zone ranges.';
  return next;
end;
$$;


--
-- Name: detect_marker_type(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.detect_marker_type(description_text text, code_text text) RETURNS TABLE(marker_type text, is_accepted_marker boolean, rejection_reason text)
    LANGUAGE plpgsql STABLE
    AS $$
declare
  combined_text text;
  matched_rule public.point_marker_rules;
begin
  combined_text := public.normalize_point_text(coalesce(code_text, '') || ' ' || coalesce(description_text, ''));

  select * into matched_rule
  from public.point_marker_rules r
  where combined_text ~* r.pattern
  order by r.priority asc
  limit 1;

  if matched_rule.id is null then
    marker_type := null;
    is_accepted_marker := false;
    rejection_reason := 'Unrecognized marker type';
    return next;
    return;
  end if;

  marker_type := matched_rule.normalized_marker_type;
  is_accepted_marker := matched_rule.is_accepted_marker;
  rejection_reason := case when matched_rule.is_accepted_marker then null else matched_rule.normalized_marker_type end;
  return next;
end;
$$;


--
-- Name: fast_mark_import_duplicates(uuid, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fast_mark_import_duplicates(target_import_job_id uuid, duplicate_tolerance_ft double precision DEFAULT 1.0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
  duplicate_count bigint := 0;
begin
  select * into job from public.import_jobs where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  update public.import_point_staging s
  set duplicate_grid_key = public.pointvault_duplicate_grid_key(s.northing, s.easting, duplicate_tolerance_ft)
  where s.import_job_id = target_import_job_id
    and s.processing_status = 'accepted'
    and s.duplicate_grid_key is null;

  with ranked as (
    select
      id,
      first_value(id) over (
        partition by duplicate_grid_key
        order by source_row_number nulls last, id
      ) as keep_id,
      row_number() over (
        partition by duplicate_grid_key
        order by source_row_number nulls last, id
      ) as rn
    from public.import_point_staging
    where import_job_id = target_import_job_id
      and processing_status = 'accepted'
      and duplicate_grid_key is not null
  )
  update public.import_point_staging s
  set
    is_duplicate = true,
    duplicate_of = r.keep_id,
    duplicate_group_key = r.keep_id::text,
    processing_status = 'duplicate'
  from ranked r
  where s.id = r.id
    and r.rn > 1;

  get diagnostics duplicate_count = row_count;

  return jsonb_build_object('duplicates_marked', duplicate_count);
end;
$$;


--
-- Name: finalize_import_job_processing(uuid, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.finalize_import_job_processing(target_import_job_id uuid, duplicate_tolerance_ft double precision DEFAULT 1.0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
  raw_count bigint := 0;
  stats jsonb;
begin
  select * into job from public.import_jobs where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  select count(*) into raw_count
  from public.import_point_staging
  where import_job_id = target_import_job_id
    and processing_status = 'raw';

  if raw_count > 0 then
    raise exception 'Import still has % raw rows. Continue chunk processing before finalizing.', raw_count;
  end if;

  update public.import_jobs
  set status = 'processing', error_message = null
  where id = target_import_job_id;

  perform public.fast_mark_import_duplicates(target_import_job_id, duplicate_tolerance_ft);
  perform public.rebuild_import_review_groups(target_import_job_id);
  perform public.refresh_import_job_counts_full(target_import_job_id, true);

  select jsonb_build_object(
    'done', true,
    'status', status,
    'total_rows', total_rows,
    'processed_rows', processed_rows,
    'accepted_rows', accepted_rows,
    'needs_review_rows', needs_review_rows,
    'rejected_rows', rejected_rows,
    'duplicate_rows', duplicate_rows
  ) into stats
  from public.import_jobs
  where id = target_import_job_id;

  return stats;
exception when others then
  update public.import_jobs
  set status = 'failed', error_message = sqlerrm
  where id = target_import_job_id;
  raise;
end;
$$;


--
-- Name: handle_new_user_profile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user_profile() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;


--
-- Name: insert_storage_import_points_chunk(uuid, jsonb, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.insert_storage_import_points_chunk(target_import_job_id uuid, points_json jsonb, duplicate_tolerance_ft double precision DEFAULT 1.0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
  inserted_count bigint := 0;
  skipped_count bigint := 0;
begin
  select * into job
  from public.import_jobs
  where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  with incoming as (
    select
      row_number() over () as row_number,
      nullif(trim(p ->> 'point'), '') as point_id,
      public.safe_double(p ->> 'northing') as northing,
      public.safe_double(p ->> 'easting') as easting,
      public.safe_double(p ->> 'elevation') as elevation,
      nullif(trim(p ->> 'description'), '') as description,
      nullif(trim(p ->> 'source_file'), '') as source_file,
      p as raw_json
    from jsonb_array_elements(points_json) p
  ),
  valid as (
    select *
    from incoming
    where northing is not null
      and easting is not null
  ),
  not_existing as (
    select v.*
    from valid v
    where not exists (
      select 1
      from public.company_points cp
      where cp.company_id = job.company_id
        and cp.northing between v.northing - duplicate_tolerance_ft and v.northing + duplicate_tolerance_ft
        and cp.easting between v.easting - duplicate_tolerance_ft and v.easting + duplicate_tolerance_ft
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
    st_y(st_transform(st_setsrid(st_makepoint(easting, northing), coalesce(job.declared_epsg, 2238)), 4326)),
    st_x(st_transform(st_setsrid(st_makepoint(easting, northing), coalesce(job.declared_epsg, 2238)), 4326)),
    northing,
    easting,
    elevation,
    job.declared_coordinate_system,
    coalesce(job.declared_epsg, 2238),
    coalesce(source_file, job.source_file_name),
    row_number,
    raw_json,
    job.default_visibility,
    case when job.default_visibility = 'community' then now() else null end,
    st_transform(st_setsrid(st_makepoint(easting, northing), coalesce(job.declared_epsg, 2238)), 4326)
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


--
-- Name: invite_company_member(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.invite_company_member(target_company_id uuid, invite_email text, invite_role text DEFAULT 'member'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  invite_token uuid;
begin
  if not public.is_company_admin(target_company_id) then
    raise exception 'Only company owners and admins can invite team members.';
  end if;

  if invite_role not in ('admin', 'member') then
    raise exception 'Invite role must be admin or member.';
  end if;

  insert into public.company_invites (company_id, email, role, invited_by)
  values (target_company_id, lower(trim(invite_email)), invite_role, auth.uid())
  returning token into invite_token;

  return invite_token;
end;
$$;


--
-- Name: is_company_admin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_company_admin(target_company_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.company_memberships cm
    where cm.company_id = target_company_id
      and cm.user_id = auth.uid()
      and cm.status = 'active'
      and cm.role in ('owner', 'admin')
  );
$$;


--
-- Name: is_company_member(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_company_member(target_company_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.company_memberships cm
    where cm.company_id = target_company_id
      and cm.user_id = auth.uid()
      and cm.status = 'active'
  );
$$;


--
-- Name: is_company_owner_or_admin(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_company_owner_or_admin(target_company_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select exists (
    select 1
    from public.company_memberships cm
    where cm.company_id = target_company_id
      and cm.user_id = auth.uid()
      and cm.role in ('owner', 'admin')
  );
$$;


--
-- Name: mark_storage_import_failed(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_storage_import_failed(target_import_job_id uuid, worker_message text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.import_jobs
  set
    python_worker_status = 'failed',
    python_worker_message = worker_message,
    error_message = worker_message,
    python_finished_at = now(),
    status = 'failed'
  where id = target_import_job_id;

  return jsonb_build_object(
    'import_job_id', target_import_job_id,
    'status', 'failed',
    'message', worker_message
  );
end;
$$;


--
-- Name: mark_storage_import_processed(uuid, text, text, text, text, text, text, bigint, bigint, bigint, bigint, bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_storage_import_processed(target_import_job_id uuid, accepted_path text, review_path text DEFAULT NULL::text, rejected_path text DEFAULT NULL::text, duplicate_path text DEFAULT NULL::text, kml_path text DEFAULT NULL::text, summary_path text DEFAULT NULL::text, total_rows bigint DEFAULT 0, accepted_rows bigint DEFAULT 0, rejected_rows bigint DEFAULT 0, duplicate_rows bigint DEFAULT 0, cleaned_file_size_bytes bigint DEFAULT NULL::bigint, worker_message text DEFAULT 'Python processing complete.'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
begin
  select * into job
  from public.import_jobs
  where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
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
    python_worker_status = 'processed',
    python_worker_message = worker_message,
    python_finished_at = now(),
    status = 'processed',
    processed_at = now()
  where id = target_import_job_id;

  return jsonb_build_object(
    'import_job_id', target_import_job_id,
    'status', 'processed',
    'accepted_storage_path', accepted_path
  );
end;
$$;


--
-- Name: mark_storage_import_uploaded(uuid, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_storage_import_uploaded(target_import_job_id uuid, raw_file_size_bytes bigint DEFAULT NULL::bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
begin
  select * into job
  from public.import_jobs
  where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  update public.import_jobs
  set
    storage_uploaded_at = now(),
    raw_file_size_bytes = mark_storage_import_uploaded.raw_file_size_bytes,
    python_worker_status = 'queued',
    python_worker_message = 'Raw file uploaded. Waiting for Python worker.',
    status = 'staged'
  where id = target_import_job_id;

  return jsonb_build_object(
    'import_job_id', target_import_job_id,
    'python_worker_status', 'queued'
  );
end;
$$;


--
-- Name: nearby_company_points(uuid, double precision, double precision, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nearby_company_points(target_company_id uuid, user_lat double precision, user_lng double precision, radius_feet double precision DEFAULT 5280, result_limit integer DEFAULT 500) RETURNS TABLE(id text, point_id text, name text, status text, reliability text, latitude double precision, longitude double precision, northing text, easting text, coordinate_system text, job text, source_file text, county text, crew text, last_found date, description text, distance_feet double precision)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  if to_regclass('public.survey_points') is null then
    return;
  end if;

  return query execute '
    select
      sp.id::text,
      sp.point_id::text,
      coalesce(sp.name, sp.point_id::text) as name,
      coalesce(sp.status, ''found'') as status,
      coalesce(sp.reliability, ''C'') as reliability,
      sp.latitude::double precision,
      sp.longitude::double precision,
      sp.northing::text,
      sp.easting::text,
      sp.coordinate_system::text,
      sp.job::text,
      sp.source_file::text,
      sp.county::text,
      sp.crew::text,
      sp.last_found::date,
      sp.description::text,
      (st_distance(
        st_setsrid(st_makepoint(sp.longitude, sp.latitude), 4326)::geography,
        st_setsrid(st_makepoint($3, $2), 4326)::geography
      ) * 3.28084)::double precision as distance_feet
    from public.survey_points sp
    where sp.company_id = $1
      and sp.latitude is not null
      and sp.longitude is not null
      and (st_distance(
        st_setsrid(st_makepoint(sp.longitude, sp.latitude), 4326)::geography,
        st_setsrid(st_makepoint($3, $2), 4326)::geography
      ) * 3.28084) <= $4
    order by distance_feet asc
    limit $5
  ' using target_company_id, user_lat, user_lng, radius_feet, result_limit;
end;
$_$;


--
-- Name: nearby_points(double precision, double precision, double precision, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nearby_points(user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer DEFAULT 500) RETURNS TABLE(id bigint, point_id text, name text, status text, reliability text, latitude double precision, longitude double precision, northing text, easting text, coordinate_system text, job text, county text, crew text, last_found date, description text, source_file text, distance_feet double precision)
    LANGUAGE sql STABLE
    AS $$
  select
    p.id,
    p.point_id,
    p.name,
    p.status,
    p.reliability,
    p.latitude,
    p.longitude,
    p.northing,
    p.easting,
    p.coordinate_system,
    p.job,
    p.county,
    p.crew,
    p.last_found,
    p.description,
    p.source_file,
    ST_Distance(
      p.geom,
      ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326)::geography
    ) * 3.280839895 as distance_feet
  from public.points p
  where ST_DWithin(
    p.geom,
    ST_SetSRID(ST_MakePoint(user_lng, user_lat), 4326)::geography,
    radius_feet / 3.280839895
  )
  order by distance_feet
  limit result_limit;
$$;


--
-- Name: nearby_visible_points(uuid, double precision, double precision, double precision, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.nearby_visible_points(target_company_id uuid, user_lat double precision, user_lng double precision, radius_feet double precision DEFAULT 5280, result_limit integer DEFAULT 500, requested_scope text DEFAULT 'all'::text) RETURNS TABLE(access_level text, visibility text, id text, point_id text, name text, marker_type text, description text, status text, reliability text, latitude double precision, longitude double precision, northing double precision, easting double precision, elevation double precision, coordinate_system text, epsg integer, source_file text, details_locked boolean, coordinates_locked boolean, distance_feet double precision)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  community_access text;
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  community_access := public.company_community_access(target_company_id);

  -- Company private/community-owned points: full data for owner company.
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
    (st_distance(cp.geom::geography, st_setsrid(st_makepoint(user_lng, user_lat), 4326)::geography) * 3.28084)::double precision as distance_feet
  from public.company_points cp
  where cp.company_id = target_company_id
    and cp.geom is not null
    and requested_scope in ('all', 'company', 'community')
    and (requested_scope <> 'community' or cp.visibility = 'community')
    and (st_distance(cp.geom::geography, st_setsrid(st_makepoint(user_lng, user_lat), 4326)::geography) * 3.28084) <= radius_feet
  order by distance_feet asc
  limit result_limit;

  -- Community shared points from other companies.
  if requested_scope in ('all', 'community') and community_access <> 'private' and community_access <> 'suspended' then
    return query
    select
      community_access as access_level,
      'community'::text as visibility,
      c.id::text,
      case when community_access in ('contributor', 'balanced', 'low_contribution') then c.id::text else null end as point_id,
      case when community_access in ('contributor', 'balanced', 'low_contribution') then coalesce(c.canonical_marker_type, 'Community Point') else 'Community Point Available' end as name,
      case when community_access in ('contributor', 'balanced', 'low_contribution') then c.canonical_marker_type else null end as marker_type,
      case when community_access in ('contributor', 'balanced', 'low_contribution') then c.best_description else null end as description,
      case when community_access in ('contributor', 'balanced') then 'found' else null end as status,
      case when community_access in ('contributor', 'balanced') then 'C' else null end as reliability,
      c.latitude,
      c.longitude,
      null::double precision as northing,
      null::double precision as easting,
      null::double precision as elevation,
      null::text as coordinate_system,
      null::integer as epsg,
      null::text as source_file,
      community_access = 'viewing_only' as details_locked,
      community_access in ('viewing_only', 'low_contribution') as coordinates_locked,
      (st_distance(c.geom::geography, st_setsrid(st_makepoint(user_lng, user_lat), 4326)::geography) * 3.28084)::double precision as distance_feet
    from public.community_points c
    where not exists (
      select 1
      from public.community_point_observations o
      where o.community_point_id = c.id
        and o.company_id = target_company_id
    )
      and (st_distance(c.geom::geography, st_setsrid(st_makepoint(user_lng, user_lat), 4326)::geography) * 3.28084) <= radius_feet
    order by distance_feet asc
    limit result_limit;

    update public.companies
    set community_points_viewed_count = community_points_viewed_count + 1
    where id = target_company_id;
  end if;
end;
$$;


--
-- Name: normalize_point_text(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_point_text(raw_value text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select lower(regexp_replace(coalesce(raw_value, ''), '[^a-zA-Z0-9/#\.\" ]+', ' ', 'g'));
$$;


--
-- Name: pointvault_duplicate_grid_key(double precision, double precision, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pointvault_duplicate_grid_key(raw_northing double precision, raw_easting double precision, tolerance_ft double precision DEFAULT 1.0) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case
    when raw_northing is null or raw_easting is null then null
    else floor(raw_northing / greatest(tolerance_ft, 0.01))::bigint::text || ':' || floor(raw_easting / greatest(tolerance_ft, 0.01))::bigint::text
  end;
$$;


--
-- Name: pointvault_import_storage_prefix(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pointvault_import_storage_prefix(target_company_id uuid, target_import_job_id uuid) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select 'company/' || target_company_id::text || '/import_jobs/' || target_import_job_id::text;
$$;


--
-- Name: pointvault_review_signature(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pointvault_review_signature(description_text text, code_text text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select nullif(
    trim(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            lower(coalesce(code_text, '') || ' ' || coalesce(description_text, '')),
            '\b(fnd|fd)\b', 'found', 'g'
          ),
          '\b(lb|pls|rls)\s*#?\s*[0-9]{3,6}\b', '\1 number', 'g'
        ),
        '[^a-z0-9/#" ]+', ' ', 'g'
      )
    ),
    ''
  );
$$;


--
-- Name: process_import_job(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_import_job(target_import_job_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  return public.process_import_job_chunk(target_import_job_id, 1000, 1.0);
end;
$$;


--
-- Name: process_import_job_chunk(uuid, integer, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_import_job_chunk(target_import_job_id uuid, chunk_size integer DEFAULT 1000, duplicate_tolerance_ft double precision DEFAULT 1.0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
  claimed_count integer := 0;
  remaining_count bigint := 0;
begin
  select * into job
  from public.import_jobs
  where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  update public.import_jobs
  set status = 'processing', error_message = null, last_chunk_at = now()
  where id = target_import_job_id;

  create temp table if not exists tmp_pointvault_chunk_ids (
    id uuid primary key
  ) on commit drop;

  truncate tmp_pointvault_chunk_ids;

  insert into tmp_pointvault_chunk_ids(id)
  select s.id
  from public.import_point_staging s
  where s.import_job_id = target_import_job_id
    and s.processing_status = 'raw'
  order by s.source_row_number nulls last, s.id
  limit greatest(chunk_size, 1);

  get diagnostics claimed_count = row_count;

  if claimed_count = 0 then
    select count(*) into remaining_count
    from public.import_point_staging
    where import_job_id = target_import_job_id
      and processing_status = 'raw';

    return jsonb_build_object(
      'done', true,
      'ready_to_finalize', true,
      'processed_this_chunk', 0,
      'remaining_raw_rows', remaining_count,
      'status', 'ready_to_finalize'
    );
  end if;

  update public.import_point_staging s
  set
    parsed_point_id = nullif(trim(coalesce(s.raw_point_id, s.raw_json ->> 'point_id', s.raw_json ->> 'id', s.raw_json ->> 'Point', s.raw_json ->> 'Point ID', s.raw_json ->> 'point')), ''),
    parsed_description = nullif(trim(coalesce(s.raw_description, s.raw_json ->> 'description', s.raw_json ->> 'desc', s.raw_json ->> 'Description')), ''),
    northing = public.safe_double(coalesce(s.raw_northing, s.raw_json ->> 'northing', s.raw_json ->> 'Northing', s.raw_json ->> 'N')),
    easting = public.safe_double(coalesce(s.raw_easting, s.raw_json ->> 'easting', s.raw_json ->> 'Easting', s.raw_json ->> 'E')),
    elevation = public.safe_double(coalesce(s.raw_elevation, s.raw_json ->> 'elevation', s.raw_json ->> 'Elevation', s.raw_json ->> 'Z')),
    latitude = public.safe_double(coalesce(s.raw_latitude, s.raw_json ->> 'latitude', s.raw_json ->> 'lat', s.raw_json ->> 'Latitude')),
    longitude = public.safe_double(coalesce(s.raw_longitude, s.raw_json ->> 'longitude', s.raw_json ->> 'lng', s.raw_json ->> 'lon', s.raw_json ->> 'Longitude')),
    processing_status = 'parsed',
    processed_at = now()
  from tmp_pointvault_chunk_ids c
  where s.id = c.id;

  update public.import_point_staging s
  set review_signature = public.pointvault_review_signature(
    s.parsed_description,
    coalesce(s.raw_code, s.raw_json ->> 'code', s.raw_json ->> 'Code')
  )
  from tmp_pointvault_chunk_ids c
  where s.id = c.id;

  update public.import_point_staging s
  set
    marker_type = final.marker_type,
    is_accepted_marker = final.is_accepted_marker,
    rejection_reason = final.rejection_reason
  from (
    select
      s2.id,
      a.marker_type,
      a.is_accepted_marker,
      a.rejection_reason
    from public.import_point_staging s2
    join tmp_pointvault_chunk_ids c on c.id = s2.id
    cross join lateral public.detect_marker_type(
      s2.parsed_description,
      coalesce(s2.raw_code, s2.raw_json ->> 'code', s2.raw_json ->> 'Code')
    ) d
    cross join lateral public.apply_company_marker_alias(
      s2.company_id,
      s2.review_signature,
      d.marker_type,
      d.is_accepted_marker,
      d.rejection_reason
    ) a
  ) final
  where s.id = final.id;

  update public.import_point_staging s
  set
    detected_epsg = checked.detected_epsg,
    coordinate_quality = checked.coordinate_quality,
    coordinate_message = checked.coordinate_message
  from (
    select
      s2.id,
      q.detected_epsg,
      q.coordinate_quality,
      q.coordinate_message
    from public.import_point_staging s2
    join tmp_pointvault_chunk_ids c on c.id = s2.id
    cross join lateral public.detect_coordinate_quality(
      s2.northing,
      s2.easting,
      s2.latitude,
      s2.longitude,
      job.declared_epsg
    ) q
  ) checked
  where s.id = checked.id;

  update public.import_point_staging s
  set geom = st_setsrid(st_makepoint(s.longitude, s.latitude), 4326)
  from tmp_pointvault_chunk_ids c
  where s.id = c.id
    and s.latitude is not null
    and s.longitude is not null
    and s.latitude between -90 and 90
    and s.longitude between -180 and 180;

  update public.import_point_staging s
  set geom = st_transform(
      st_setsrid(st_makepoint(s.easting, s.northing), s.detected_epsg),
      4326
    )
  from tmp_pointvault_chunk_ids c
  where s.id = c.id
    and s.geom is null
    and s.northing is not null
    and s.easting is not null
    and s.detected_epsg in (2236, 2237, 2238)
    and s.coordinate_quality in ('valid', 'suspect');

  update public.import_point_staging s
  set
    longitude = st_x(s.geom),
    latitude = st_y(s.geom)
  from tmp_pointvault_chunk_ids c
  where s.id = c.id
    and s.geom is not null
    and (s.latitude is null or s.longitude is null);

  update public.import_point_staging s
  set processing_status = case
      when s.coordinate_quality = 'invalid' then 'invalid_coordinate'
      when s.geom is null then 'invalid_coordinate'
      when coalesce(s.is_accepted_marker, false) = true then 'accepted'
      when s.marker_type is null then 'needs_review'
      else 'rejected_non_marker'
    end,
    rejection_reason = case
      when s.coordinate_quality = 'invalid' then coalesce(s.coordinate_message, 'Invalid coordinates')
      when s.geom is null then 'Missing transformed map location'
      when coalesce(s.is_accepted_marker, false) = true then null
      when s.marker_type is null then coalesce(s.rejection_reason, 'Needs review')
      else coalesce(s.rejection_reason, 'Rejected non-marker')
    end,
    duplicate_grid_key = public.pointvault_duplicate_grid_key(s.northing, s.easting, duplicate_tolerance_ft)
  from tmp_pointvault_chunk_ids c
  where s.id = c.id;

  select count(*) into remaining_count
  from public.import_point_staging
  where import_job_id = target_import_job_id
    and processing_status = 'raw';

  perform public.refresh_import_job_counts_light(target_import_job_id);

  return jsonb_build_object(
    'done', remaining_count = 0,
    'ready_to_finalize', remaining_count = 0,
    'processed_this_chunk', claimed_count,
    'remaining_raw_rows', remaining_count,
    'status', case when remaining_count = 0 then 'ready_to_finalize' else 'processing' end
  );
exception when others then
  update public.import_jobs
  set status = 'failed', error_message = sqlerrm
  where id = target_import_job_id;
  raise;
end;
$$;


--
-- Name: promote_import_job_chunk(uuid, integer, double precision); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.promote_import_job_chunk(target_import_job_id uuid, chunk_size integer DEFAULT 1000, duplicate_tolerance_ft double precision DEFAULT 1.0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
  candidate_count bigint := 0;
  inserted_count bigint := 0;
  skipped_duplicate_count bigint := 0;
  remaining_accepted_count bigint := 0;
begin
  select * into job
  from public.import_jobs
  where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  update public.import_jobs
  set status = 'processing', error_message = null
  where id = target_import_job_id;

  create temp table if not exists tmp_pointvault_promote_ids (
    id uuid primary key
  ) on commit drop;

  truncate tmp_pointvault_promote_ids;

  insert into tmp_pointvault_promote_ids(id)
  select s.id
  from public.import_point_staging s
  where s.import_job_id = target_import_job_id
    and s.processing_status = 'accepted'
    and s.geom is not null
  order by s.source_row_number nulls last, s.id
  limit greatest(chunk_size, 1);

  get diagnostics candidate_count = row_count;

  if candidate_count = 0 then
    select count(*) into remaining_accepted_count
    from public.import_point_staging
    where import_job_id = target_import_job_id
      and processing_status = 'accepted';

    update public.import_jobs
    set status = 'promoted', promoted_at = coalesce(promoted_at, now())
    where id = target_import_job_id
      and remaining_accepted_count = 0;

    return jsonb_build_object(
      'done', true,
      'promoted_this_chunk', 0,
      'skipped_duplicate_rows', 0,
      'remaining_accepted_rows', remaining_accepted_count,
      'status', 'promoted'
    );
  end if;

  select count(*) into skipped_duplicate_count
  from public.import_point_staging s
  join tmp_pointvault_promote_ids t on t.id = s.id
  where exists (
    select 1
    from public.company_points cp
    where cp.company_id = s.company_id
      and cp.geom is not null
      and st_dwithin(cp.geom::geography, s.geom::geography, duplicate_tolerance_ft / 3.28084)
  );

  insert into public.company_points (
    company_id,
    import_job_id,
    source_staging_id,
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
    s.company_id,
    s.import_job_id,
    s.id,
    s.parsed_point_id,
    coalesce(s.parsed_point_id, s.marker_type),
    s.marker_type,
    s.parsed_description,
    s.latitude,
    s.longitude,
    s.northing,
    s.easting,
    s.elevation,
    job.declared_coordinate_system,
    s.detected_epsg,
    coalesce(s.raw_json ->> 'source_file', job.source_file_name),
    s.source_row_number,
    s.raw_json,
    job.default_visibility,
    case when job.default_visibility = 'community' then now() else null end,
    s.geom
  from public.import_point_staging s
  join tmp_pointvault_promote_ids t on t.id = s.id
  where not exists (
      select 1
      from public.company_points cp
      where cp.source_staging_id = s.id
    )
    and not exists (
      select 1
      from public.company_points cp
      where cp.company_id = s.company_id
        and cp.geom is not null
        and st_dwithin(cp.geom::geography, s.geom::geography, duplicate_tolerance_ft / 3.28084)
    );

  get diagnostics inserted_count = row_count;

  update public.import_point_staging s
  set processing_status = 'promoted'
  from tmp_pointvault_promote_ids t
  where s.id = t.id;

  update public.import_jobs
  set promoted_rows = promoted_rows + inserted_count
  where id = target_import_job_id;

  select count(*) into remaining_accepted_count
  from public.import_point_staging
  where import_job_id = target_import_job_id
    and processing_status = 'accepted';

  if remaining_accepted_count = 0 then
    update public.import_jobs
    set status = 'promoted', promoted_at = now()
    where id = target_import_job_id;
  end if;

  return jsonb_build_object(
    'done', remaining_accepted_count = 0,
    'promoted_this_chunk', inserted_count,
    'skipped_duplicate_rows', skipped_duplicate_count,
    'remaining_accepted_rows', remaining_accepted_count,
    'status', case when remaining_accepted_count = 0 then 'promoted' else 'processing' end
  );
exception when others then
  update public.import_jobs
  set status = 'failed', error_message = sqlerrm
  where id = target_import_job_id;
  raise;
end;
$$;


--
-- Name: promote_import_job_to_company_points(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.promote_import_job_to_company_points(target_import_job_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  return public.promote_import_job_chunk(target_import_job_id, 1000, 1.0);
end;
$$;


--
-- Name: rebuild_import_review_groups(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rebuild_import_review_groups(target_import_job_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
  group_count bigint := 0;
begin
  select * into job from public.import_jobs where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  delete from public.import_review_groups
  where import_job_id = target_import_job_id;

  with base as (
    select
      s.*,
      coalesce(s.review_signature, 'unknown') as sig,
      case
        when s.processing_status = 'accepted' then 'accepted'
        when s.processing_status = 'duplicate' then 'duplicate'
        when s.processing_status = 'invalid_coordinate' then 'invalid_coordinate'
        when s.processing_status = 'rejected_non_marker' then 'rejected_non_marker'
        else 'needs_review'
      end as group_status,
      row_number() over (
        partition by coalesce(s.review_signature, 'unknown'),
          case
            when s.processing_status = 'accepted' then 'accepted'
            when s.processing_status = 'duplicate' then 'duplicate'
            when s.processing_status = 'invalid_coordinate' then 'invalid_coordinate'
            when s.processing_status = 'rejected_non_marker' then 'rejected_non_marker'
            else 'needs_review'
          end
        order by s.source_row_number nulls last, s.id
      ) as sample_rank
    from public.import_point_staging s
    where s.import_job_id = target_import_job_id
      and s.processing_status in ('accepted', 'needs_review', 'rejected_non_marker', 'invalid_coordinate', 'duplicate')
  ), grouped as (
    select
      import_job_id,
      company_id,
      sig,
      group_status,
      max(marker_type) as suggested_marker_type,
      max(coalesce(rejection_reason, coordinate_message, 'Needs review')) as reason,
      count(*) as row_count,
      jsonb_agg(
        jsonb_build_object(
          'source_row_number', source_row_number,
          'point', parsed_point_id,
          'description', parsed_description,
          'northing', northing,
          'easting', easting,
          'status', processing_status
        )
        order by source_row_number nulls last
      ) filter (where sample_rank <= 5) as sample_rows
    from base
    group by import_job_id, company_id, sig, group_status
  )
  insert into public.import_review_groups (
    import_job_id,
    company_id,
    review_signature,
    suggested_marker_type,
    current_status,
    reason,
    row_count,
    sample_rows
  )
  select
    import_job_id,
    company_id,
    sig,
    suggested_marker_type,
    group_status,
    reason,
    row_count,
    coalesce(sample_rows, '[]'::jsonb)
  from grouped;

  get diagnostics group_count = row_count;

  return jsonb_build_object('review_groups', group_count);
end;
$$;


--
-- Name: refresh_import_job_counts(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_import_job_counts(target_import_job_id uuid, mark_processed_when_done boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
  raw_count bigint;
  stats jsonb;
begin
  select * into job from public.import_jobs where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  select count(*) into raw_count
  from public.import_point_staging
  where import_job_id = target_import_job_id
    and processing_status = 'raw';

  update public.import_jobs j
  set
    total_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id),
    processed_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status <> 'raw'),
    accepted_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'accepted'),
    needs_review_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'needs_review'),
    rejected_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status in ('rejected', 'rejected_non_marker', 'invalid_coordinate')),
    rejected_non_marker_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'rejected_non_marker'),
    invalid_coordinate_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'invalid_coordinate'),
    duplicate_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'duplicate'),
    status = case when mark_processed_when_done and raw_count = 0 then 'processed' else j.status end,
    processed_at = case when mark_processed_when_done and raw_count = 0 then now() else j.processed_at end
  where j.id = target_import_job_id;

  select jsonb_build_object(
    'total_rows', total_rows,
    'processed_rows', processed_rows,
    'accepted_rows', accepted_rows,
    'needs_review_rows', needs_review_rows,
    'rejected_rows', rejected_rows,
    'rejected_non_marker_rows', rejected_non_marker_rows,
    'invalid_coordinate_rows', invalid_coordinate_rows,
    'duplicate_rows', duplicate_rows,
    'status', status
  ) into stats
  from public.import_jobs
  where id = target_import_job_id;

  return stats;
end;
$$;


--
-- Name: refresh_import_job_counts_full(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_import_job_counts_full(target_import_job_id uuid, mark_processed_when_done boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
  raw_count bigint;
  stats jsonb;
begin
  select * into job from public.import_jobs where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  select count(*) into raw_count
  from public.import_point_staging
  where import_job_id = target_import_job_id
    and processing_status = 'raw';

  update public.import_jobs j
  set
    total_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id),
    processed_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status <> 'raw'),
    accepted_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'accepted'),
    needs_review_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'needs_review'),
    rejected_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status in ('rejected', 'rejected_non_marker', 'invalid_coordinate')),
    rejected_non_marker_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'rejected_non_marker'),
    invalid_coordinate_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'invalid_coordinate'),
    duplicate_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'duplicate'),
    status = case when mark_processed_when_done and raw_count = 0 then 'processed' else j.status end,
    processed_at = case when mark_processed_when_done and raw_count = 0 then now() else j.processed_at end
  where j.id = target_import_job_id;

  select jsonb_build_object(
    'total_rows', total_rows,
    'processed_rows', processed_rows,
    'accepted_rows', accepted_rows,
    'needs_review_rows', needs_review_rows,
    'rejected_rows', rejected_rows,
    'rejected_non_marker_rows', rejected_non_marker_rows,
    'invalid_coordinate_rows', invalid_coordinate_rows,
    'duplicate_rows', duplicate_rows,
    'status', status
  ) into stats
  from public.import_jobs
  where id = target_import_job_id;

  return stats;
end;
$$;


--
-- Name: refresh_import_job_counts_light(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.refresh_import_job_counts_light(target_import_job_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  job public.import_jobs;
  stats jsonb;
begin
  select * into job from public.import_jobs where id = target_import_job_id;

  if job.id is null then
    raise exception 'Import job not found.';
  end if;

  if not public.is_company_member(job.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  update public.import_jobs j
  set
    total_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id),
    processed_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status <> 'raw'),
    accepted_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'accepted'),
    needs_review_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'needs_review'),
    rejected_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status in ('rejected', 'rejected_non_marker', 'invalid_coordinate')),
    rejected_non_marker_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'rejected_non_marker'),
    invalid_coordinate_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'invalid_coordinate'),
    duplicate_rows = (select count(*) from public.import_point_staging where import_job_id = target_import_job_id and processing_status = 'duplicate')
  where j.id = target_import_job_id;

  select jsonb_build_object(
    'total_rows', total_rows,
    'processed_rows', processed_rows,
    'accepted_rows', accepted_rows,
    'needs_review_rows', needs_review_rows,
    'rejected_rows', rejected_rows,
    'rejected_non_marker_rows', rejected_non_marker_rows,
    'invalid_coordinate_rows', invalid_coordinate_rows,
    'duplicate_rows', duplicate_rows,
    'status', status
  ) into stats
  from public.import_jobs
  where id = target_import_job_id;

  return stats;
end;
$$;


--
-- Name: safe_double(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.safe_double(raw_value text) RETURNS double precision
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  cleaned text;
begin
  cleaned := nullif(regexp_replace(coalesce(raw_value, ''), '[^0-9\.\-]+', '', 'g'), '');
  if cleaned is null then
    return null;
  end if;
  return cleaned::double precision;
exception when others then
  return null;
end;
$$;


--
-- Name: share_company_point_to_community(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.share_company_point_to_community(target_company_point_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  cp public.company_points;
  existing_community_id uuid;
  community_id uuid;
begin
  select * into cp from public.company_points where id = target_company_point_id;

  if cp.id is null then
    raise exception 'Company point not found.';
  end if;

  if not public.is_company_member(cp.company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  if cp.geom is null then
    raise exception 'Point has no map location.';
  end if;

  -- Merge with an existing shared point within about 0.50 feet.
  select id into existing_community_id
  from public.community_points c
  where st_dwithin(c.geom::geography, cp.geom::geography, 0.50 / 3.28084)
  order by st_distance(c.geom::geography, cp.geom::geography) asc
  limit 1;

  if existing_community_id is null then
    insert into public.community_points (
      canonical_marker_type,
      best_description,
      latitude,
      longitude,
      geom,
      contributor_count,
      observation_count
    )
    values (
      cp.marker_type,
      cp.description,
      cp.latitude,
      cp.longitude,
      cp.geom,
      1,
      0
    )
    returning id into community_id;
  else
    community_id := existing_community_id;
  end if;

  insert into public.community_point_observations (
    community_point_id,
    company_point_id,
    company_id,
    marker_type,
    description,
    latitude,
    longitude,
    northing,
    easting,
    elevation,
    epsg,
    reliability,
    source_file,
    source_row_number
  )
  values (
    community_id,
    cp.id,
    cp.company_id,
    cp.marker_type,
    cp.description,
    cp.latitude,
    cp.longitude,
    cp.northing,
    cp.easting,
    cp.elevation,
    cp.epsg,
    cp.reliability,
    cp.source_file,
    cp.source_row_number
  )
  on conflict (company_point_id) do nothing;

  update public.community_points c
  set
    observation_count = (select count(*) from public.community_point_observations o where o.community_point_id = c.id),
    contributor_count = (select count(distinct o.company_id) from public.community_point_observations o where o.community_point_id = c.id),
    last_shared_at = now(),
    updated_at = now()
  where c.id = community_id;

  update public.company_points
  set visibility = 'community', shared_at = coalesce(shared_at, now())
  where id = cp.id;

  update public.companies
  set
    community_sharing_enabled = true,
    community_points_shared_count = (select count(*) from public.community_point_observations where company_id = cp.company_id),
    last_community_share_at = now()
  where id = cp.company_id;

  return community_id;
end;
$$;


--
-- Name: share_import_job_to_community(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.share_import_job_to_community(target_import_job_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  cp_record record;
  shared_count bigint := 0;
begin
  for cp_record in
    select id
    from public.company_points
    where import_job_id = target_import_job_id
  loop
    perform public.share_company_point_to_community(cp_record.id);
    shared_count := shared_count + 1;
  end loop;

  return jsonb_build_object('shared_points_processed', shared_count);
end;
$$;


--
-- Name: storage_path_company_id(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.storage_path_company_id(object_name text) RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
declare
  parts text[];
begin
  parts := string_to_array(object_name, '/');
  if array_length(parts, 1) < 2 then
    return null;
  end if;
  if parts[1] <> 'company' then
    return null;
  end if;
  return parts[2]::uuid;
exception when others then
  return null;
end;
$$;


--
-- Name: touch_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


--
-- Name: community_point_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_point_observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    community_point_id uuid NOT NULL,
    company_point_id uuid NOT NULL,
    company_id uuid NOT NULL,
    marker_type text,
    description text,
    latitude double precision,
    longitude double precision,
    northing double precision,
    easting double precision,
    elevation double precision,
    epsg integer,
    reliability text,
    source_file text,
    source_row_number bigint,
    shared_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: community_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.community_points (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    canonical_marker_type text,
    best_description text,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    geom public.geometry(Point,4326) NOT NULL,
    contributor_count integer DEFAULT 0 NOT NULL,
    observation_count integer DEFAULT 0 NOT NULL,
    first_shared_at timestamp with time zone DEFAULT now() NOT NULL,
    last_shared_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: company_invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    token uuid DEFAULT gen_random_uuid() NOT NULL,
    invited_by uuid NOT NULL,
    accepted_by uuid,
    accepted_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '14 days'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_invites_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: company_marker_aliases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_marker_aliases (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    alias_signature text NOT NULL,
    normalized_marker_type text NOT NULL,
    is_accepted_marker boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: company_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_memberships_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))),
    CONSTRAINT company_memberships_status_check CHECK ((status = ANY (ARRAY['active'::text, 'invited'::text, 'disabled'::text])))
);


--
-- Name: company_points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_points (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    import_job_id uuid,
    source_staging_id uuid,
    point_id text,
    name text,
    marker_type text,
    description text,
    status text DEFAULT 'found'::text NOT NULL,
    reliability text DEFAULT 'C'::text,
    latitude double precision,
    longitude double precision,
    northing double precision,
    easting double precision,
    elevation double precision,
    coordinate_system text,
    epsg integer,
    source_file text,
    source_row_number bigint,
    raw_json jsonb,
    visibility text DEFAULT 'company'::text NOT NULL,
    shared_at timestamp with time zone,
    geom public.geometry(Point,4326),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT company_points_visibility_check CHECK ((visibility = ANY (ARRAY['company'::text, 'community'::text])))
);


--
-- Name: coordinate_zones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coordinate_zones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    zone_name text NOT NULL,
    epsg integer,
    state text,
    units text DEFAULT 'ftUS'::text NOT NULL,
    min_northing double precision,
    max_northing double precision,
    min_easting double precision,
    max_easting double precision,
    area public.geometry(MultiPolygon,4326),
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: import_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    created_by uuid NOT NULL,
    source_file_name text,
    source_file_path text,
    source_format text DEFAULT 'csv'::text,
    declared_epsg integer,
    declared_coordinate_system text,
    default_visibility text DEFAULT 'company'::text NOT NULL,
    status text DEFAULT 'staged'::text NOT NULL,
    total_rows bigint DEFAULT 0 NOT NULL,
    accepted_rows bigint DEFAULT 0 NOT NULL,
    rejected_rows bigint DEFAULT 0 NOT NULL,
    duplicate_rows bigint DEFAULT 0 NOT NULL,
    promoted_rows bigint DEFAULT 0 NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    promoted_at timestamp with time zone,
    input_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    output_mapping jsonb DEFAULT '{}'::jsonb NOT NULL,
    processed_rows bigint DEFAULT 0 NOT NULL,
    needs_review_rows bigint DEFAULT 0 NOT NULL,
    invalid_coordinate_rows bigint DEFAULT 0 NOT NULL,
    rejected_non_marker_rows bigint DEFAULT 0 NOT NULL,
    last_chunk_at timestamp with time zone,
    import_mode text DEFAULT 'database_staging'::text NOT NULL,
    storage_bucket text,
    raw_storage_path text,
    processed_storage_path text,
    accepted_storage_path text,
    review_storage_path text,
    rejected_storage_path text,
    duplicate_storage_path text,
    kml_storage_path text,
    summary_storage_path text,
    python_worker_status text DEFAULT 'not_started'::text,
    python_worker_message text,
    raw_file_size_bytes bigint,
    cleaned_file_size_bytes bigint,
    storage_uploaded_at timestamp with time zone,
    python_started_at timestamp with time zone,
    python_finished_at timestamp with time zone,
    CONSTRAINT import_jobs_default_visibility_check CHECK ((default_visibility = ANY (ARRAY['company'::text, 'community'::text]))),
    CONSTRAINT import_jobs_import_mode_check CHECK ((import_mode = ANY (ARRAY['database_staging'::text, 'storage_python'::text]))),
    CONSTRAINT import_jobs_python_worker_status_check CHECK ((python_worker_status = ANY (ARRAY['not_started'::text, 'queued'::text, 'processing'::text, 'processed'::text, 'failed'::text]))),
    CONSTRAINT import_jobs_status_check CHECK ((status = ANY (ARRAY['staged'::text, 'processing'::text, 'processed'::text, 'promoted'::text, 'failed'::text])))
);


--
-- Name: import_point_staging; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_point_staging (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    import_job_id uuid NOT NULL,
    company_id uuid NOT NULL,
    source_row_number bigint,
    raw_point_id text,
    raw_description text,
    raw_code text,
    raw_northing text,
    raw_easting text,
    raw_elevation text,
    raw_latitude text,
    raw_longitude text,
    raw_json jsonb,
    parsed_point_id text,
    parsed_description text,
    marker_type text,
    is_accepted_marker boolean,
    rejection_reason text,
    northing double precision,
    easting double precision,
    elevation double precision,
    latitude double precision,
    longitude double precision,
    detected_epsg integer,
    coordinate_quality text,
    coordinate_message text,
    geom public.geometry(Point,4326),
    duplicate_group_key text,
    is_duplicate boolean DEFAULT false NOT NULL,
    duplicate_of uuid,
    processing_status text DEFAULT 'raw'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    review_signature text,
    duplicate_grid_key text,
    processed_at timestamp with time zone,
    CONSTRAINT import_point_staging_coordinate_quality_check CHECK ((coordinate_quality = ANY (ARRAY['valid'::text, 'suspect'::text, 'invalid'::text]))),
    CONSTRAINT import_point_staging_processing_status_check CHECK ((processing_status = ANY (ARRAY['raw'::text, 'parsed'::text, 'accepted'::text, 'needs_review'::text, 'rejected'::text, 'rejected_non_marker'::text, 'invalid_coordinate'::text, 'duplicate'::text, 'promoted'::text])))
);


--
-- Name: import_review_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_review_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    import_job_id uuid NOT NULL,
    company_id uuid NOT NULL,
    review_signature text NOT NULL,
    suggested_marker_type text,
    current_status text DEFAULT 'needs_review'::text NOT NULL,
    reason text,
    row_count bigint DEFAULT 0 NOT NULL,
    sample_rows jsonb DEFAULT '[]'::jsonb NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT import_review_groups_current_status_check CHECK ((current_status = ANY (ARRAY['needs_review'::text, 'accepted'::text, 'rejected_non_marker'::text, 'invalid_coordinate'::text, 'duplicate'::text])))
);


--
-- Name: point_marker_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.point_marker_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    rule_name text NOT NULL,
    pattern text NOT NULL,
    normalized_marker_type text NOT NULL,
    is_accepted_marker boolean DEFAULT true NOT NULL,
    priority integer DEFAULT 100 NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: points; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.points (
    id bigint NOT NULL,
    point_id text NOT NULL,
    name text,
    status text DEFAULT 'record'::text,
    reliability text,
    latitude double precision NOT NULL,
    longitude double precision NOT NULL,
    northing text,
    easting text,
    coordinate_system text,
    job text,
    county text,
    crew text,
    last_found date,
    description text,
    geom public.geography(Point,4326) GENERATED ALWAYS AS ((public.st_setsrid(public.st_makepoint(longitude, latitude), 4326))::public.geography) STORED,
    created_at timestamp with time zone DEFAULT now(),
    source_file text
);


--
-- Name: points_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.points ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.points_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text,
    full_name text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: community_point_observations community_point_observations_company_point_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_point_observations
    ADD CONSTRAINT community_point_observations_company_point_id_key UNIQUE (company_point_id);


--
-- Name: community_point_observations community_point_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_point_observations
    ADD CONSTRAINT community_point_observations_pkey PRIMARY KEY (id);


--
-- Name: community_points community_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_points
    ADD CONSTRAINT community_points_pkey PRIMARY KEY (id);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: companies companies_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_slug_key UNIQUE (slug);


--
-- Name: company_invites company_invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_invites
    ADD CONSTRAINT company_invites_pkey PRIMARY KEY (id);


--
-- Name: company_invites company_invites_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_invites
    ADD CONSTRAINT company_invites_token_key UNIQUE (token);


--
-- Name: company_marker_aliases company_marker_aliases_company_id_alias_signature_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_marker_aliases
    ADD CONSTRAINT company_marker_aliases_company_id_alias_signature_key UNIQUE (company_id, alias_signature);


--
-- Name: company_marker_aliases company_marker_aliases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_marker_aliases
    ADD CONSTRAINT company_marker_aliases_pkey PRIMARY KEY (id);


--
-- Name: company_memberships company_memberships_company_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_company_id_user_id_key UNIQUE (company_id, user_id);


--
-- Name: company_memberships company_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_pkey PRIMARY KEY (id);


--
-- Name: company_points company_points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_points
    ADD CONSTRAINT company_points_pkey PRIMARY KEY (id);


--
-- Name: coordinate_zones coordinate_zones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coordinate_zones
    ADD CONSTRAINT coordinate_zones_pkey PRIMARY KEY (id);


--
-- Name: import_jobs import_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_pkey PRIMARY KEY (id);


--
-- Name: import_point_staging import_point_staging_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_point_staging
    ADD CONSTRAINT import_point_staging_pkey PRIMARY KEY (id);


--
-- Name: import_review_groups import_review_groups_import_job_id_review_signature_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_review_groups
    ADD CONSTRAINT import_review_groups_import_job_id_review_signature_key UNIQUE (import_job_id, review_signature);


--
-- Name: import_review_groups import_review_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_review_groups
    ADD CONSTRAINT import_review_groups_pkey PRIMARY KEY (id);


--
-- Name: point_marker_rules point_marker_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.point_marker_rules
    ADD CONSTRAINT point_marker_rules_pkey PRIMARY KEY (id);


--
-- Name: points points_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.points
    ADD CONSTRAINT points_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: community_observations_community_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX community_observations_community_idx ON public.community_point_observations USING btree (community_point_id);


--
-- Name: community_observations_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX community_observations_company_idx ON public.community_point_observations USING btree (company_id);


--
-- Name: community_points_geom_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX community_points_geom_gix ON public.community_points USING gist (geom);


--
-- Name: company_marker_aliases_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_marker_aliases_company_idx ON public.company_marker_aliases USING btree (company_id, alias_signature);


--
-- Name: company_points_company_geom_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_points_company_geom_gix ON public.company_points USING gist (geom);


--
-- Name: company_points_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_points_company_idx ON public.company_points USING btree (company_id);


--
-- Name: company_points_company_ne_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_points_company_ne_idx ON public.company_points USING btree (company_id, northing, easting) WHERE ((northing IS NOT NULL) AND (easting IS NOT NULL));


--
-- Name: company_points_geom_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_points_geom_gix ON public.company_points USING gist (geom);


--
-- Name: company_points_import_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_points_import_job_idx ON public.company_points USING btree (import_job_id);


--
-- Name: company_points_marker_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_points_marker_type_idx ON public.company_points USING btree (marker_type);


--
-- Name: company_points_source_staging_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_points_source_staging_idx ON public.company_points USING btree (source_staging_id) WHERE (source_staging_id IS NOT NULL);


--
-- Name: company_points_source_staging_unique_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX company_points_source_staging_unique_idx ON public.company_points USING btree (source_staging_id) WHERE (source_staging_id IS NOT NULL);


--
-- Name: company_points_visibility_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_points_visibility_idx ON public.company_points USING btree (visibility);


--
-- Name: coordinate_zones_area_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coordinate_zones_area_gix ON public.coordinate_zones USING gist (area);


--
-- Name: coordinate_zones_epsg_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX coordinate_zones_epsg_idx ON public.coordinate_zones USING btree (epsg);


--
-- Name: import_jobs_company_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_jobs_company_id_idx ON public.import_jobs USING btree (company_id, created_at DESC);


--
-- Name: import_jobs_storage_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_jobs_storage_company_idx ON public.import_jobs USING btree (company_id, import_mode, created_at DESC);


--
-- Name: import_jobs_worker_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_jobs_worker_status_idx ON public.import_jobs USING btree (python_worker_status, created_at);


--
-- Name: import_point_staging_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_point_staging_company_idx ON public.import_point_staging USING btree (company_id);


--
-- Name: import_point_staging_duplicate_grid_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_point_staging_duplicate_grid_idx ON public.import_point_staging USING btree (import_job_id, duplicate_grid_key) WHERE (processing_status = 'accepted'::text);


--
-- Name: import_point_staging_geom_gix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_point_staging_geom_gix ON public.import_point_staging USING gist (geom);


--
-- Name: import_point_staging_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_point_staging_job_idx ON public.import_point_staging USING btree (import_job_id);


--
-- Name: import_point_staging_job_raw_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_point_staging_job_raw_idx ON public.import_point_staging USING btree (import_job_id, id) WHERE (processing_status = 'raw'::text);


--
-- Name: import_point_staging_job_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_point_staging_job_status_idx ON public.import_point_staging USING btree (import_job_id, processing_status);


--
-- Name: import_point_staging_promote_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_point_staging_promote_idx ON public.import_point_staging USING btree (import_job_id, processing_status, source_row_number, id) WHERE (processing_status = 'accepted'::text);


--
-- Name: import_point_staging_review_signature_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_point_staging_review_signature_idx ON public.import_point_staging USING btree (import_job_id, review_signature);


--
-- Name: import_point_staging_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_point_staging_status_idx ON public.import_point_staging USING btree (import_job_id, processing_status);


--
-- Name: import_review_groups_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_review_groups_job_idx ON public.import_review_groups USING btree (import_job_id, current_status, row_count DESC);


--
-- Name: import_review_groups_unique_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX import_review_groups_unique_status_idx ON public.import_review_groups USING btree (import_job_id, review_signature, current_status);


--
-- Name: point_marker_rules_priority_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX point_marker_rules_priority_idx ON public.point_marker_rules USING btree (priority);


--
-- Name: points_county_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX points_county_idx ON public.points USING btree (county);


--
-- Name: points_geom_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX points_geom_idx ON public.points USING gist (geom);


--
-- Name: points_job_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX points_job_idx ON public.points USING btree (job);


--
-- Name: points_point_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX points_point_id_idx ON public.points USING btree (point_id);


--
-- Name: points_source_file_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX points_source_file_idx ON public.points USING btree (source_file);


--
-- Name: companies companies_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER companies_touch_updated_at BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: company_memberships memberships_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER memberships_touch_updated_at BEFORE UPDATE ON public.company_memberships FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: profiles profiles_touch_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER profiles_touch_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();


--
-- Name: community_point_observations community_point_observations_community_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_point_observations
    ADD CONSTRAINT community_point_observations_community_point_id_fkey FOREIGN KEY (community_point_id) REFERENCES public.community_points(id) ON DELETE CASCADE;


--
-- Name: community_point_observations community_point_observations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_point_observations
    ADD CONSTRAINT community_point_observations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: community_point_observations community_point_observations_company_point_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.community_point_observations
    ADD CONSTRAINT community_point_observations_company_point_id_fkey FOREIGN KEY (company_point_id) REFERENCES public.company_points(id) ON DELETE CASCADE;


--
-- Name: companies companies_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE RESTRICT;


--
-- Name: company_invites company_invites_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_invites
    ADD CONSTRAINT company_invites_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: company_invites company_invites_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_invites
    ADD CONSTRAINT company_invites_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_invites company_invites_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_invites
    ADD CONSTRAINT company_invites_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: company_marker_aliases company_marker_aliases_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_marker_aliases
    ADD CONSTRAINT company_marker_aliases_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_marker_aliases company_marker_aliases_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_marker_aliases
    ADD CONSTRAINT company_marker_aliases_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: company_memberships company_memberships_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_memberships company_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_memberships
    ADD CONSTRAINT company_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: company_points company_points_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_points
    ADD CONSTRAINT company_points_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_points company_points_import_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_points
    ADD CONSTRAINT company_points_import_job_id_fkey FOREIGN KEY (import_job_id) REFERENCES public.import_jobs(id) ON DELETE SET NULL;


--
-- Name: company_points company_points_source_staging_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_points
    ADD CONSTRAINT company_points_source_staging_id_fkey FOREIGN KEY (source_staging_id) REFERENCES public.import_point_staging(id) ON DELETE SET NULL;


--
-- Name: import_jobs import_jobs_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: import_jobs import_jobs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_jobs
    ADD CONSTRAINT import_jobs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: import_point_staging import_point_staging_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_point_staging
    ADD CONSTRAINT import_point_staging_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: import_point_staging import_point_staging_import_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_point_staging
    ADD CONSTRAINT import_point_staging_import_job_id_fkey FOREIGN KEY (import_job_id) REFERENCES public.import_jobs(id) ON DELETE CASCADE;


--
-- Name: import_review_groups import_review_groups_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_review_groups
    ADD CONSTRAINT import_review_groups_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: import_review_groups import_review_groups_decided_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_review_groups
    ADD CONSTRAINT import_review_groups_decided_by_fkey FOREIGN KEY (decided_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: import_review_groups import_review_groups_import_job_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_review_groups
    ADD CONSTRAINT import_review_groups_import_job_id_fkey FOREIGN KEY (import_job_id) REFERENCES public.import_jobs(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: company_invites Admins can create company invites; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can create company invites" ON public.company_invites FOR INSERT WITH CHECK (public.is_company_admin(company_id));


--
-- Name: company_memberships Admins can manage company memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage company memberships" ON public.company_memberships USING (public.is_company_admin(company_id)) WITH CHECK (public.is_company_admin(company_id));


--
-- Name: company_invites Admins can read company invites; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read company invites" ON public.company_invites FOR SELECT USING (public.is_company_admin(company_id));


--
-- Name: company_invites Admins can update company invites; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update company invites" ON public.company_invites FOR UPDATE USING (public.is_company_admin(company_id)) WITH CHECK (public.is_company_admin(company_id));


--
-- Name: companies Company admins can update company; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company admins can update company" ON public.companies FOR UPDATE USING (public.is_company_admin(id)) WITH CHECK (public.is_company_admin(id));


--
-- Name: companies Company members can read company; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company members can read company" ON public.companies FOR SELECT USING (public.is_company_member(id));


--
-- Name: companies Company owners can create company; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Company owners can create company" ON public.companies FOR INSERT WITH CHECK ((owner_id = auth.uid()));


--
-- Name: import_jobs Members can create own import jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can create own import jobs" ON public.import_jobs FOR INSERT WITH CHECK (public.is_company_member(company_id));


--
-- Name: company_points Members can insert own company points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can insert own company points" ON public.company_points FOR INSERT WITH CHECK (public.is_company_member(company_id));


--
-- Name: company_marker_aliases Members can insert own marker aliases; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can insert own marker aliases" ON public.company_marker_aliases FOR INSERT WITH CHECK (public.is_company_member(company_id));


--
-- Name: import_point_staging Members can insert own staging; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can insert own staging" ON public.import_point_staging FOR INSERT WITH CHECK (public.is_company_member(company_id));


--
-- Name: community_point_observations Members can read community observations through rpc only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read community observations through rpc only" ON public.community_point_observations FOR SELECT USING (public.is_company_member(company_id));


--
-- Name: community_points Members can read community points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read community points" ON public.community_points FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: company_memberships Members can read company memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read company memberships" ON public.company_memberships FOR SELECT USING (public.is_company_member(company_id));


--
-- Name: coordinate_zones Members can read coordinate zones; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read coordinate zones" ON public.coordinate_zones FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: point_marker_rules Members can read marker rules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read marker rules" ON public.point_marker_rules FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: company_points Members can read own company points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read own company points" ON public.company_points FOR SELECT USING (public.is_company_member(company_id));


--
-- Name: import_jobs Members can read own import jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read own import jobs" ON public.import_jobs FOR SELECT USING (public.is_company_member(company_id));


--
-- Name: company_marker_aliases Members can read own marker aliases; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read own marker aliases" ON public.company_marker_aliases FOR SELECT USING (public.is_company_member(company_id));


--
-- Name: import_review_groups Members can read own review groups; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read own review groups" ON public.import_review_groups FOR SELECT USING (public.is_company_member(company_id));


--
-- Name: import_point_staging Members can read own staging; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can read own staging" ON public.import_point_staging FOR SELECT USING (public.is_company_member(company_id));


--
-- Name: company_points Members can update own company points; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can update own company points" ON public.company_points FOR UPDATE USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));


--
-- Name: import_jobs Members can update own import jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can update own import jobs" ON public.import_jobs FOR UPDATE USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));


--
-- Name: company_marker_aliases Members can update own marker aliases; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can update own marker aliases" ON public.company_marker_aliases FOR UPDATE USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));


--
-- Name: import_review_groups Members can update own review groups; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can update own review groups" ON public.import_review_groups FOR UPDATE USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));


--
-- Name: import_point_staging Members can update own staging; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can update own staging" ON public.import_point_staging FOR UPDATE USING (public.is_company_member(company_id)) WITH CHECK (public.is_company_member(company_id));


--
-- Name: profiles Users can read their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read their own profile" ON public.profiles FOR SELECT USING ((id = auth.uid()));


--
-- Name: profiles Users can update their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));


--
-- Name: community_point_observations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_point_observations ENABLE ROW LEVEL SECURITY;

--
-- Name: community_points; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.community_points ENABLE ROW LEVEL SECURITY;

--
-- Name: companies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;

--
-- Name: company_invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_invites ENABLE ROW LEVEL SECURITY;

--
-- Name: company_marker_aliases; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_marker_aliases ENABLE ROW LEVEL SECURITY;

--
-- Name: company_memberships; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_memberships ENABLE ROW LEVEL SECURITY;

--
-- Name: company_points; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.company_points ENABLE ROW LEVEL SECURITY;

--
-- Name: coordinate_zones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coordinate_zones ENABLE ROW LEVEL SECURITY;

--
-- Name: import_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: import_point_staging; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_point_staging ENABLE ROW LEVEL SECURITY;

--
-- Name: import_review_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.import_review_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: point_marker_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.point_marker_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: points; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.points ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION accept_company_invitation(invite_token uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.accept_company_invitation(invite_token uuid) TO anon;
GRANT ALL ON FUNCTION public.accept_company_invitation(invite_token uuid) TO authenticated;
GRANT ALL ON FUNCTION public.accept_company_invitation(invite_token uuid) TO service_role;


--
-- Name: FUNCTION apply_company_marker_alias(target_company_id uuid, target_signature text, fallback_marker_type text, fallback_accepted boolean, fallback_reason text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.apply_company_marker_alias(target_company_id uuid, target_signature text, fallback_marker_type text, fallback_accepted boolean, fallback_reason text) TO anon;
GRANT ALL ON FUNCTION public.apply_company_marker_alias(target_company_id uuid, target_signature text, fallback_marker_type text, fallback_accepted boolean, fallback_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.apply_company_marker_alias(target_company_id uuid, target_signature text, fallback_marker_type text, fallback_accepted boolean, fallback_reason text) TO service_role;


--
-- Name: FUNCTION claim_next_storage_import_job(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.claim_next_storage_import_job() TO anon;
GRANT ALL ON FUNCTION public.claim_next_storage_import_job() TO authenticated;
GRANT ALL ON FUNCTION public.claim_next_storage_import_job() TO service_role;


--
-- Name: FUNCTION cleanup_company_duplicate_points(target_company_id uuid, duplicate_tolerance_ft double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cleanup_company_duplicate_points(target_company_id uuid, duplicate_tolerance_ft double precision) TO anon;
GRANT ALL ON FUNCTION public.cleanup_company_duplicate_points(target_company_id uuid, duplicate_tolerance_ft double precision) TO authenticated;
GRANT ALL ON FUNCTION public.cleanup_company_duplicate_points(target_company_id uuid, duplicate_tolerance_ft double precision) TO service_role;


--
-- Name: FUNCTION clear_company_points_for_storage_import(target_import_job_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.clear_company_points_for_storage_import(target_import_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.clear_company_points_for_storage_import(target_import_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.clear_company_points_for_storage_import(target_import_job_id uuid) TO service_role;


--
-- Name: FUNCTION company_community_access(target_company_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.company_community_access(target_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.company_community_access(target_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.company_community_access(target_company_id uuid) TO service_role;


--
-- Name: TABLE companies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.companies TO anon;
GRANT ALL ON TABLE public.companies TO authenticated;
GRANT ALL ON TABLE public.companies TO service_role;


--
-- Name: FUNCTION create_company_with_owner(company_name text, company_slug text, full_name text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_company_with_owner(company_name text, company_slug text, full_name text) TO anon;
GRANT ALL ON FUNCTION public.create_company_with_owner(company_name text, company_slug text, full_name text) TO authenticated;
GRANT ALL ON FUNCTION public.create_company_with_owner(company_name text, company_slug text, full_name text) TO service_role;


--
-- Name: FUNCTION create_import_job(target_company_id uuid, source_file_name text, declared_epsg integer, declared_coordinate_system text, default_visibility text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_import_job(target_company_id uuid, source_file_name text, declared_epsg integer, declared_coordinate_system text, default_visibility text) TO anon;
GRANT ALL ON FUNCTION public.create_import_job(target_company_id uuid, source_file_name text, declared_epsg integer, declared_coordinate_system text, default_visibility text) TO authenticated;
GRANT ALL ON FUNCTION public.create_import_job(target_company_id uuid, source_file_name text, declared_epsg integer, declared_coordinate_system text, default_visibility text) TO service_role;


--
-- Name: FUNCTION create_storage_import_job(target_company_id uuid, source_file_name text, declared_epsg integer, declared_coordinate_system text, default_visibility text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_storage_import_job(target_company_id uuid, source_file_name text, declared_epsg integer, declared_coordinate_system text, default_visibility text) TO anon;
GRANT ALL ON FUNCTION public.create_storage_import_job(target_company_id uuid, source_file_name text, declared_epsg integer, declared_coordinate_system text, default_visibility text) TO authenticated;
GRANT ALL ON FUNCTION public.create_storage_import_job(target_company_id uuid, source_file_name text, declared_epsg integer, declared_coordinate_system text, default_visibility text) TO service_role;


--
-- Name: FUNCTION decide_import_review_group(target_review_group_id uuid, decision text, normalized_marker_type text, save_as_company_alias boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.decide_import_review_group(target_review_group_id uuid, decision text, normalized_marker_type text, save_as_company_alias boolean) TO anon;
GRANT ALL ON FUNCTION public.decide_import_review_group(target_review_group_id uuid, decision text, normalized_marker_type text, save_as_company_alias boolean) TO authenticated;
GRANT ALL ON FUNCTION public.decide_import_review_group(target_review_group_id uuid, decision text, normalized_marker_type text, save_as_company_alias boolean) TO service_role;


--
-- Name: FUNCTION delete_company_point(target_company_point_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.delete_company_point(target_company_point_id uuid) TO anon;
GRANT ALL ON FUNCTION public.delete_company_point(target_company_point_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.delete_company_point(target_company_point_id uuid) TO service_role;


--
-- Name: FUNCTION detect_coordinate_quality(raw_northing double precision, raw_easting double precision, raw_latitude double precision, raw_longitude double precision, declared_epsg integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.detect_coordinate_quality(raw_northing double precision, raw_easting double precision, raw_latitude double precision, raw_longitude double precision, declared_epsg integer) TO anon;
GRANT ALL ON FUNCTION public.detect_coordinate_quality(raw_northing double precision, raw_easting double precision, raw_latitude double precision, raw_longitude double precision, declared_epsg integer) TO authenticated;
GRANT ALL ON FUNCTION public.detect_coordinate_quality(raw_northing double precision, raw_easting double precision, raw_latitude double precision, raw_longitude double precision, declared_epsg integer) TO service_role;


--
-- Name: FUNCTION detect_marker_type(description_text text, code_text text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.detect_marker_type(description_text text, code_text text) TO anon;
GRANT ALL ON FUNCTION public.detect_marker_type(description_text text, code_text text) TO authenticated;
GRANT ALL ON FUNCTION public.detect_marker_type(description_text text, code_text text) TO service_role;


--
-- Name: FUNCTION fast_mark_import_duplicates(target_import_job_id uuid, duplicate_tolerance_ft double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.fast_mark_import_duplicates(target_import_job_id uuid, duplicate_tolerance_ft double precision) TO anon;
GRANT ALL ON FUNCTION public.fast_mark_import_duplicates(target_import_job_id uuid, duplicate_tolerance_ft double precision) TO authenticated;
GRANT ALL ON FUNCTION public.fast_mark_import_duplicates(target_import_job_id uuid, duplicate_tolerance_ft double precision) TO service_role;


--
-- Name: FUNCTION finalize_import_job_processing(target_import_job_id uuid, duplicate_tolerance_ft double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.finalize_import_job_processing(target_import_job_id uuid, duplicate_tolerance_ft double precision) TO anon;
GRANT ALL ON FUNCTION public.finalize_import_job_processing(target_import_job_id uuid, duplicate_tolerance_ft double precision) TO authenticated;
GRANT ALL ON FUNCTION public.finalize_import_job_processing(target_import_job_id uuid, duplicate_tolerance_ft double precision) TO service_role;


--
-- Name: FUNCTION handle_new_user_profile(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_user_profile() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user_profile() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user_profile() TO service_role;


--
-- Name: FUNCTION insert_storage_import_points_chunk(target_import_job_id uuid, points_json jsonb, duplicate_tolerance_ft double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.insert_storage_import_points_chunk(target_import_job_id uuid, points_json jsonb, duplicate_tolerance_ft double precision) TO anon;
GRANT ALL ON FUNCTION public.insert_storage_import_points_chunk(target_import_job_id uuid, points_json jsonb, duplicate_tolerance_ft double precision) TO authenticated;
GRANT ALL ON FUNCTION public.insert_storage_import_points_chunk(target_import_job_id uuid, points_json jsonb, duplicate_tolerance_ft double precision) TO service_role;


--
-- Name: FUNCTION invite_company_member(target_company_id uuid, invite_email text, invite_role text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.invite_company_member(target_company_id uuid, invite_email text, invite_role text) TO anon;
GRANT ALL ON FUNCTION public.invite_company_member(target_company_id uuid, invite_email text, invite_role text) TO authenticated;
GRANT ALL ON FUNCTION public.invite_company_member(target_company_id uuid, invite_email text, invite_role text) TO service_role;


--
-- Name: FUNCTION is_company_admin(target_company_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_company_admin(target_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_company_admin(target_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_company_admin(target_company_id uuid) TO service_role;


--
-- Name: FUNCTION is_company_member(target_company_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_company_member(target_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_company_member(target_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_company_member(target_company_id uuid) TO service_role;


--
-- Name: FUNCTION is_company_owner_or_admin(target_company_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_company_owner_or_admin(target_company_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_company_owner_or_admin(target_company_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_company_owner_or_admin(target_company_id uuid) TO service_role;


--
-- Name: FUNCTION mark_storage_import_failed(target_import_job_id uuid, worker_message text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mark_storage_import_failed(target_import_job_id uuid, worker_message text) TO anon;
GRANT ALL ON FUNCTION public.mark_storage_import_failed(target_import_job_id uuid, worker_message text) TO authenticated;
GRANT ALL ON FUNCTION public.mark_storage_import_failed(target_import_job_id uuid, worker_message text) TO service_role;


--
-- Name: FUNCTION mark_storage_import_processed(target_import_job_id uuid, accepted_path text, review_path text, rejected_path text, duplicate_path text, kml_path text, summary_path text, total_rows bigint, accepted_rows bigint, rejected_rows bigint, duplicate_rows bigint, cleaned_file_size_bytes bigint, worker_message text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mark_storage_import_processed(target_import_job_id uuid, accepted_path text, review_path text, rejected_path text, duplicate_path text, kml_path text, summary_path text, total_rows bigint, accepted_rows bigint, rejected_rows bigint, duplicate_rows bigint, cleaned_file_size_bytes bigint, worker_message text) TO anon;
GRANT ALL ON FUNCTION public.mark_storage_import_processed(target_import_job_id uuid, accepted_path text, review_path text, rejected_path text, duplicate_path text, kml_path text, summary_path text, total_rows bigint, accepted_rows bigint, rejected_rows bigint, duplicate_rows bigint, cleaned_file_size_bytes bigint, worker_message text) TO authenticated;
GRANT ALL ON FUNCTION public.mark_storage_import_processed(target_import_job_id uuid, accepted_path text, review_path text, rejected_path text, duplicate_path text, kml_path text, summary_path text, total_rows bigint, accepted_rows bigint, rejected_rows bigint, duplicate_rows bigint, cleaned_file_size_bytes bigint, worker_message text) TO service_role;


--
-- Name: FUNCTION mark_storage_import_uploaded(target_import_job_id uuid, raw_file_size_bytes bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mark_storage_import_uploaded(target_import_job_id uuid, raw_file_size_bytes bigint) TO anon;
GRANT ALL ON FUNCTION public.mark_storage_import_uploaded(target_import_job_id uuid, raw_file_size_bytes bigint) TO authenticated;
GRANT ALL ON FUNCTION public.mark_storage_import_uploaded(target_import_job_id uuid, raw_file_size_bytes bigint) TO service_role;


--
-- Name: FUNCTION nearby_company_points(target_company_id uuid, user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.nearby_company_points(target_company_id uuid, user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer) TO anon;
GRANT ALL ON FUNCTION public.nearby_company_points(target_company_id uuid, user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.nearby_company_points(target_company_id uuid, user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer) TO service_role;


--
-- Name: FUNCTION nearby_points(user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.nearby_points(user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer) TO anon;
GRANT ALL ON FUNCTION public.nearby_points(user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.nearby_points(user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer) TO service_role;


--
-- Name: FUNCTION nearby_visible_points(target_company_id uuid, user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer, requested_scope text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.nearby_visible_points(target_company_id uuid, user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer, requested_scope text) TO anon;
GRANT ALL ON FUNCTION public.nearby_visible_points(target_company_id uuid, user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer, requested_scope text) TO authenticated;
GRANT ALL ON FUNCTION public.nearby_visible_points(target_company_id uuid, user_lat double precision, user_lng double precision, radius_feet double precision, result_limit integer, requested_scope text) TO service_role;


--
-- Name: FUNCTION normalize_point_text(raw_value text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.normalize_point_text(raw_value text) TO anon;
GRANT ALL ON FUNCTION public.normalize_point_text(raw_value text) TO authenticated;
GRANT ALL ON FUNCTION public.normalize_point_text(raw_value text) TO service_role;


--
-- Name: FUNCTION pointvault_duplicate_grid_key(raw_northing double precision, raw_easting double precision, tolerance_ft double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pointvault_duplicate_grid_key(raw_northing double precision, raw_easting double precision, tolerance_ft double precision) TO anon;
GRANT ALL ON FUNCTION public.pointvault_duplicate_grid_key(raw_northing double precision, raw_easting double precision, tolerance_ft double precision) TO authenticated;
GRANT ALL ON FUNCTION public.pointvault_duplicate_grid_key(raw_northing double precision, raw_easting double precision, tolerance_ft double precision) TO service_role;


--
-- Name: FUNCTION pointvault_import_storage_prefix(target_company_id uuid, target_import_job_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pointvault_import_storage_prefix(target_company_id uuid, target_import_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.pointvault_import_storage_prefix(target_company_id uuid, target_import_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.pointvault_import_storage_prefix(target_company_id uuid, target_import_job_id uuid) TO service_role;


--
-- Name: FUNCTION pointvault_review_signature(description_text text, code_text text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.pointvault_review_signature(description_text text, code_text text) TO anon;
GRANT ALL ON FUNCTION public.pointvault_review_signature(description_text text, code_text text) TO authenticated;
GRANT ALL ON FUNCTION public.pointvault_review_signature(description_text text, code_text text) TO service_role;


--
-- Name: FUNCTION process_import_job(target_import_job_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.process_import_job(target_import_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.process_import_job(target_import_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.process_import_job(target_import_job_id uuid) TO service_role;


--
-- Name: FUNCTION process_import_job_chunk(target_import_job_id uuid, chunk_size integer, duplicate_tolerance_ft double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.process_import_job_chunk(target_import_job_id uuid, chunk_size integer, duplicate_tolerance_ft double precision) TO anon;
GRANT ALL ON FUNCTION public.process_import_job_chunk(target_import_job_id uuid, chunk_size integer, duplicate_tolerance_ft double precision) TO authenticated;
GRANT ALL ON FUNCTION public.process_import_job_chunk(target_import_job_id uuid, chunk_size integer, duplicate_tolerance_ft double precision) TO service_role;


--
-- Name: FUNCTION promote_import_job_chunk(target_import_job_id uuid, chunk_size integer, duplicate_tolerance_ft double precision); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.promote_import_job_chunk(target_import_job_id uuid, chunk_size integer, duplicate_tolerance_ft double precision) TO anon;
GRANT ALL ON FUNCTION public.promote_import_job_chunk(target_import_job_id uuid, chunk_size integer, duplicate_tolerance_ft double precision) TO authenticated;
GRANT ALL ON FUNCTION public.promote_import_job_chunk(target_import_job_id uuid, chunk_size integer, duplicate_tolerance_ft double precision) TO service_role;


--
-- Name: FUNCTION promote_import_job_to_company_points(target_import_job_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.promote_import_job_to_company_points(target_import_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.promote_import_job_to_company_points(target_import_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.promote_import_job_to_company_points(target_import_job_id uuid) TO service_role;


--
-- Name: FUNCTION rebuild_import_review_groups(target_import_job_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.rebuild_import_review_groups(target_import_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.rebuild_import_review_groups(target_import_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.rebuild_import_review_groups(target_import_job_id uuid) TO service_role;


--
-- Name: FUNCTION refresh_import_job_counts(target_import_job_id uuid, mark_processed_when_done boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.refresh_import_job_counts(target_import_job_id uuid, mark_processed_when_done boolean) TO anon;
GRANT ALL ON FUNCTION public.refresh_import_job_counts(target_import_job_id uuid, mark_processed_when_done boolean) TO authenticated;
GRANT ALL ON FUNCTION public.refresh_import_job_counts(target_import_job_id uuid, mark_processed_when_done boolean) TO service_role;


--
-- Name: FUNCTION refresh_import_job_counts_full(target_import_job_id uuid, mark_processed_when_done boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.refresh_import_job_counts_full(target_import_job_id uuid, mark_processed_when_done boolean) TO anon;
GRANT ALL ON FUNCTION public.refresh_import_job_counts_full(target_import_job_id uuid, mark_processed_when_done boolean) TO authenticated;
GRANT ALL ON FUNCTION public.refresh_import_job_counts_full(target_import_job_id uuid, mark_processed_when_done boolean) TO service_role;


--
-- Name: FUNCTION refresh_import_job_counts_light(target_import_job_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.refresh_import_job_counts_light(target_import_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.refresh_import_job_counts_light(target_import_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.refresh_import_job_counts_light(target_import_job_id uuid) TO service_role;


--
-- Name: FUNCTION safe_double(raw_value text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.safe_double(raw_value text) TO anon;
GRANT ALL ON FUNCTION public.safe_double(raw_value text) TO authenticated;
GRANT ALL ON FUNCTION public.safe_double(raw_value text) TO service_role;


--
-- Name: FUNCTION share_company_point_to_community(target_company_point_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.share_company_point_to_community(target_company_point_id uuid) TO anon;
GRANT ALL ON FUNCTION public.share_company_point_to_community(target_company_point_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.share_company_point_to_community(target_company_point_id uuid) TO service_role;


--
-- Name: FUNCTION share_import_job_to_community(target_import_job_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.share_import_job_to_community(target_import_job_id uuid) TO anon;
GRANT ALL ON FUNCTION public.share_import_job_to_community(target_import_job_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.share_import_job_to_community(target_import_job_id uuid) TO service_role;


--
-- Name: FUNCTION storage_path_company_id(object_name text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.storage_path_company_id(object_name text) TO anon;
GRANT ALL ON FUNCTION public.storage_path_company_id(object_name text) TO authenticated;
GRANT ALL ON FUNCTION public.storage_path_company_id(object_name text) TO service_role;


--
-- Name: FUNCTION touch_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_updated_at() TO anon;
GRANT ALL ON FUNCTION public.touch_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.touch_updated_at() TO service_role;


--
-- Name: TABLE community_point_observations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.community_point_observations TO anon;
GRANT ALL ON TABLE public.community_point_observations TO authenticated;
GRANT ALL ON TABLE public.community_point_observations TO service_role;


--
-- Name: TABLE community_points; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.community_points TO anon;
GRANT ALL ON TABLE public.community_points TO authenticated;
GRANT ALL ON TABLE public.community_points TO service_role;


--
-- Name: TABLE company_invites; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.company_invites TO anon;
GRANT ALL ON TABLE public.company_invites TO authenticated;
GRANT ALL ON TABLE public.company_invites TO service_role;


--
-- Name: TABLE company_marker_aliases; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.company_marker_aliases TO anon;
GRANT ALL ON TABLE public.company_marker_aliases TO authenticated;
GRANT ALL ON TABLE public.company_marker_aliases TO service_role;


--
-- Name: TABLE company_memberships; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.company_memberships TO anon;
GRANT ALL ON TABLE public.company_memberships TO authenticated;
GRANT ALL ON TABLE public.company_memberships TO service_role;


--
-- Name: TABLE company_points; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.company_points TO anon;
GRANT ALL ON TABLE public.company_points TO authenticated;
GRANT ALL ON TABLE public.company_points TO service_role;


--
-- Name: TABLE coordinate_zones; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.coordinate_zones TO anon;
GRANT ALL ON TABLE public.coordinate_zones TO authenticated;
GRANT ALL ON TABLE public.coordinate_zones TO service_role;


--
-- Name: TABLE import_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.import_jobs TO anon;
GRANT ALL ON TABLE public.import_jobs TO authenticated;
GRANT ALL ON TABLE public.import_jobs TO service_role;


--
-- Name: TABLE import_point_staging; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.import_point_staging TO anon;
GRANT ALL ON TABLE public.import_point_staging TO authenticated;
GRANT ALL ON TABLE public.import_point_staging TO service_role;


--
-- Name: TABLE import_review_groups; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.import_review_groups TO anon;
GRANT ALL ON TABLE public.import_review_groups TO authenticated;
GRANT ALL ON TABLE public.import_review_groups TO service_role;


--
-- Name: TABLE point_marker_rules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.point_marker_rules TO anon;
GRANT ALL ON TABLE public.point_marker_rules TO authenticated;
GRANT ALL ON TABLE public.point_marker_rules TO service_role;


--
-- Name: TABLE points; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.points TO anon;
GRANT ALL ON TABLE public.points TO authenticated;
GRANT ALL ON TABLE public.points TO service_role;


--
-- Name: SEQUENCE points_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.points_id_seq TO anon;
GRANT ALL ON SEQUENCE public.points_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.points_id_seq TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--


