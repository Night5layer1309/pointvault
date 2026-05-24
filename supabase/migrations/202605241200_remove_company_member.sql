-- Lets a company owner or admin remove a member from their team.
--
-- Rules:
--   - Caller must be owner or admin of the target company
--   - You can't remove yourself (owners would orphan the company; everyone
--     else can just sign out instead)
--   - The company owner can never be removed (the owner has to transfer
--     ownership separately, which isn't built yet)
--   - Admins cannot remove other admins -- only the owner can do that.
--     Prevents admins from booting each other in a war
--
-- Removal is a hard delete from company_memberships. The user's account is
-- not touched; they just lose access to this specific company. Their
-- point observations and field notes remain in the company's data (they
-- still have authorship attribution on past contributions).

begin;

create or replace function public.remove_company_member(
  target_company_id uuid,
  target_user_id uuid
) returns boolean
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  caller_role text;
  target_role text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  select cm.role into caller_role
  from public.company_memberships cm
  where cm.company_id = target_company_id
    and cm.user_id = auth.uid()
    and cm.status = 'active';

  if caller_role is null or caller_role not in ('owner', 'admin') then
    raise exception 'Only company owners and admins can remove members.';
  end if;

  if target_user_id = auth.uid() then
    raise exception 'You can''t remove yourself. Sign out instead, or transfer ownership first.';
  end if;

  select cm.role into target_role
  from public.company_memberships cm
  where cm.company_id = target_company_id
    and cm.user_id = target_user_id
    and cm.status = 'active';

  if target_role is null then
    raise exception 'That person is not an active member of this company.';
  end if;

  if target_role = 'owner' then
    raise exception 'The company owner cannot be removed.';
  end if;

  if caller_role = 'admin' and target_role = 'admin' then
    raise exception 'Admins cannot remove other admins. Only the company owner can do that.';
  end if;

  delete from public.company_memberships cm
  where cm.company_id = target_company_id
    and cm.user_id = target_user_id;

  return true;
end;
$$;

commit;
