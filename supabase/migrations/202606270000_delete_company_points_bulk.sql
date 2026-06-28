-- Bulk delete companion to delete_company_point. Used by the new
-- box-select-on-map flow so the user can lasso bad points and remove them
-- in one round trip. Loops the per-point function so all the membership /
-- side-effect logic (community_point_observations cleanup, etc.) runs
-- per row.

begin;

create or replace function public.delete_company_points_bulk(target_point_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  point_id uuid;
  deleted integer := 0;
  failed integer := 0;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  if target_point_ids is null or cardinality(target_point_ids) = 0 then
    return jsonb_build_object('deleted', 0, 'failed', 0);
  end if;

  foreach point_id in array target_point_ids loop
    begin
      perform public.delete_company_point(point_id);
      deleted := deleted + 1;
    exception when others then
      failed := failed + 1;
    end;
  end loop;

  return jsonb_build_object('deleted', deleted, 'failed', failed);
end;
$$;

grant execute on function public.delete_company_points_bulk(uuid[]) to authenticated;
grant execute on function public.delete_company_points_bulk(uuid[]) to service_role;

commit;
