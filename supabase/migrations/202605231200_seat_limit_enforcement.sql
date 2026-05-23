-- Enforce companies.seat_limit on invite acceptance.
--
-- Before this migration accept_company_invitation didn't check the
-- seat limit at all, so a company with seat_limit=5 could grow
-- unbounded as long as people kept scanning the team QR or accepting
-- email invites. Adds a guard that counts active memberships before
-- creating a new one (existing members re-accepting an invite are
-- exempt so they don't get locked out of their own company).
--
-- Idempotent: if you re-run this, it just replaces the function.

begin;

create or replace function public.accept_company_invitation(invite_token uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  invite_row public.company_invites;
  company_seat_limit integer;
  current_seat_count integer;
  user_already_member boolean;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in to accept an invite.';
  end if;

  select * into invite_row
  from public.company_invites
  where token = invite_token
    and expires_at > now()
    and (max_uses is null or uses < max_uses)
  for update;

  if invite_row.id is null then
    raise exception 'Invite not found, already used, or expired.';
  end if;

  if invite_row.email is not null
     and lower(coalesce(auth.jwt() ->> 'email', '')) <> lower(invite_row.email) then
    raise exception 'This invite was sent to a different email address.';
  end if;

  select seat_limit into company_seat_limit
  from public.companies
  where id = invite_row.company_id;

  if company_seat_limit is not null and company_seat_limit > 0 then
    select exists(
      select 1 from public.company_memberships
      where company_id = invite_row.company_id
        and user_id = auth.uid()
        and status = 'active'
    ) into user_already_member;

    if not user_already_member then
      select count(*) into current_seat_count
      from public.company_memberships
      where company_id = invite_row.company_id
        and status = 'active';

      if current_seat_count >= company_seat_limit then
        raise exception 'This company has reached its seat limit (% / %). Ask an owner or admin to upgrade the plan before joining.',
          current_seat_count, company_seat_limit;
      end if;
    end if;
  end if;

  insert into public.company_memberships (company_id, user_id, role, status)
  values (invite_row.company_id, auth.uid(), invite_row.role, 'active')
  on conflict (company_id, user_id) do update
    set role = excluded.role,
        status = 'active';

  update public.company_invites
  set uses = uses + 1,
      accepted_at = coalesce(accepted_at, now()),
      accepted_by = coalesce(accepted_by, auth.uid())
  where id = invite_row.id;

  return invite_row.company_id;
end;
$$;

commit;
