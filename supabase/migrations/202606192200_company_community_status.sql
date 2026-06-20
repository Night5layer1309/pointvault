-- Tiny status-shaper RPC for the new Community Standing card. The frontend
-- can't read the companies table directly (RLS), so this wraps the
-- counts + the computed tier (from company_community_access) in one call.

begin;

create or replace function public.get_company_community_status(target_company_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  c public.companies;
  tier text;
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  select * into c from public.companies where id = target_company_id;
  if c.id is null then
    raise exception 'Company not found.';
  end if;

  tier := public.company_community_access(target_company_id);

  return jsonb_build_object(
    'tier', tier,
    'sharing_enabled', coalesce(c.community_sharing_enabled, false),
    'shared_count', coalesce(c.community_points_shared_count, 0),
    'viewed_count', coalesce(c.community_points_viewed_count, 0),
    'last_share_at', c.last_community_share_at,
    'access_override', c.community_access_override
  );
end;
$$;

grant execute on function public.get_company_community_status(uuid) to authenticated;
grant execute on function public.get_company_community_status(uuid) to service_role;

commit;
