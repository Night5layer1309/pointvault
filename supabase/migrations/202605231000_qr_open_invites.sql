-- QR onboarding: enable open (no-email, multi-use) company invites.
--
-- Before this migration, company_invites required an email and was single-use
-- (gated by accepted_at IS NULL). For QR onboarding we want a single token an
-- owner can show in the office and many employees can scan within a TTL window.
--
-- Backwards compatible: existing per-email invites continue to behave as
-- single-use (max_uses defaults to 1) and existing accepted invites get
-- uses=1 backfilled so they stay "used".

begin;

alter table public.company_invites
  alter column email drop not null,
  add column max_uses integer default 1,
  add column uses integer not null default 0;

-- Existing accepted invites should look used under the new semantics.
update public.company_invites
set uses = 1
where accepted_at is not null
  and uses = 0;

-- Replace accept_company_invitation to support multi-use + nullable email.
-- Uses FOR UPDATE so concurrent acceptances on a capped invite serialize.
create or replace function public.accept_company_invitation(invite_token uuid)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  invite_row public.company_invites;
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

-- New RPC for open invites (no email, optional usage cap).
-- TTL default 24 hours per user spec; max_uses default null means unlimited.
create or replace function public.create_open_company_invite(
  target_company_id uuid,
  ttl_minutes integer default 1440,
  invite_role text default 'member',
  invite_max_uses integer default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  new_token uuid;
begin
  if not public.is_company_admin(target_company_id) then
    raise exception 'Only company owners and admins can create invites.';
  end if;

  if invite_role not in ('admin', 'member') then
    raise exception 'Invite role must be admin or member.';
  end if;

  if ttl_minutes < 1 or ttl_minutes > 43200 then
    raise exception 'TTL must be between 1 minute and 30 days.';
  end if;

  if invite_max_uses is not null and invite_max_uses < 1 then
    raise exception 'Max uses must be at least 1 (or null for unlimited).';
  end if;

  insert into public.company_invites (
    company_id, email, role, invited_by, expires_at, max_uses
  ) values (
    target_company_id,
    null,
    invite_role,
    auth.uid(),
    now() + make_interval(mins => ttl_minutes),
    invite_max_uses
  )
  returning token into new_token;

  return new_token;
end;
$$;

commit;
