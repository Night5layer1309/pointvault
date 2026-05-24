-- Bulk share helper. share_company_point_to_community(point_id) already
-- handles a single point (dedup, links, visibility flip, counts). This
-- wrapper just loops it over an array of point IDs in one call so the
-- 'Share all visible points to community' button doesn't have to make
-- one round trip per point.
--
-- Each ID is validated by share_company_point_to_community itself
-- (is_company_member check inside), so we don't need a separate
-- permission check here.

begin;

create or replace function public.share_company_points_bulk(target_point_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  point_id uuid;
  shared integer := 0;
  failed integer := 0;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  if target_point_ids is null or cardinality(target_point_ids) = 0 then
    return jsonb_build_object('shared', 0, 'failed', 0);
  end if;

  foreach point_id in array target_point_ids loop
    begin
      perform public.share_company_point_to_community(point_id);
      shared := shared + 1;
    exception when others then
      failed := failed + 1;
    end;
  end loop;

  return jsonb_build_object('shared', shared, 'failed', failed);
end;
$$;

commit;
