-- The TeamPanel was reading from public.profiles, which is essentially empty
-- (only the owner happens to have a row), so members showed as raw UUIDs.
-- Every signed-in user actually exists in auth.users with email + name +
-- last_sign_in_at + created_at, but auth.users isn't reachable from the
-- frontend. This SECURITY DEFINER RPC bridges the gap: it returns the
-- profile rows for every member of a company the caller belongs to.
--
-- Returns nothing for non-members of the target company (membership check
-- raises). Safe to expose to authenticated; never returns data about users
-- outside the caller's company.

begin;

create or replace function public.get_company_member_profiles(target_company_id uuid)
returns table (
  user_id uuid,
  email text,
  full_name text,
  created_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
security definer
stable
set search_path to 'public'
as $$
begin
  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of this company.';
  end if;

  return query
  select
    u.id,
    u.email::text,
    coalesce(
      nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
      nullif(trim(u.raw_user_meta_data ->> 'name'), '')
    )::text as full_name,
    u.created_at,
    u.last_sign_in_at
  from auth.users u
  inner join public.company_memberships m on m.user_id = u.id
  where m.company_id = target_company_id;
end;
$$;

grant execute on function public.get_company_member_profiles(uuid) to authenticated;
grant execute on function public.get_company_member_profiles(uuid) to service_role;

commit;
