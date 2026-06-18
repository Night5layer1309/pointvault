-- Peek at a company invite by token WITHOUT consuming it, so the sign-in
-- screen can show the inviting company's name to the user before they sign
-- in. Callable by anon (the user isn't signed in yet when this fires).
--
-- Returns valid=true with company_name + role when the token resolves to an
-- unexpired invite that still has uses remaining; valid=false with a short
-- reason otherwise. Never reveals more than the company name + role, even on
-- error, so the token surface stays narrow.

begin;

create or replace function public.lookup_company_invite(invite_token uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  rec record;
begin
  if invite_token is null then
    return jsonb_build_object('valid', false, 'reason', 'missing_token');
  end if;

  select
    ci.expires_at,
    ci.max_uses,
    ci.uses,
    ci.role,
    ci.email,
    c.name as company_name
  into rec
  from public.company_invites ci
  join public.companies c on c.id = ci.company_id
  where ci.token = invite_token;

  if rec is null then
    return jsonb_build_object('valid', false, 'reason', 'not_found');
  end if;

  if rec.expires_at <= now() then
    return jsonb_build_object('valid', false, 'reason', 'expired', 'company_name', rec.company_name);
  end if;

  if rec.max_uses is not null and rec.uses >= rec.max_uses then
    return jsonb_build_object('valid', false, 'reason', 'used_up', 'company_name', rec.company_name);
  end if;

  return jsonb_build_object(
    'valid', true,
    'company_name', rec.company_name,
    'role', rec.role,
    'email_locked', rec.email is not null
  );
end;
$$;

grant execute on function public.lookup_company_invite(uuid) to anon;
grant execute on function public.lookup_company_invite(uuid) to authenticated;
grant execute on function public.lookup_company_invite(uuid) to service_role;

commit;
