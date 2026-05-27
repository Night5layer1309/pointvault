-- Share *every* private point a company owns to the community pool in one call.
--
-- share_company_points_bulk(uuid[]) already exists, but it requires the client
-- to enumerate point IDs — and the client only ever loads points near the
-- user's location, so it can never reach "all my data". This wrapper finds the
-- company's private points server-side so the user can share everything at once
-- without first loading every point.
--
-- Permission is checked once here (is_company_member); each per-point share goes
-- through share_company_point_to_community, which re-validates membership and
-- handles dedup, the visibility flip, and the community counts.

begin;

create or replace function public.share_all_company_points(target_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  rec record;
  shared integer := 0;
  failed integer := 0;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  if target_company_id is null then
    raise exception 'Missing company.';
  end if;

  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  for rec in
    select id
    from public.company_points
    where company_id = target_company_id
      and visibility <> 'community'
      and geom is not null
  loop
    begin
      perform public.share_company_point_to_community(rec.id);
      shared := shared + 1;
    exception when others then
      failed := failed + 1;
    end;
  end loop;

  return jsonb_build_object('shared', shared, 'failed', failed);
end;
$$;

commit;
