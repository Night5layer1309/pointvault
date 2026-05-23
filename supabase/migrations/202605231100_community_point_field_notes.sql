-- Community point field notes (append-only).
--
-- Lets contributing companies leave narrative notes on a community point that
-- other full-access companies can read. "Field notes" deliberately avoids the
-- word "observation" because community_point_observations already exists as a
-- link table (one row per company contribution to a deduped community point).
--
-- Write gate: caller's company must have actually shared a point at this
-- location (i.e., already has a community_point_observations row).
-- Read gate: caller's company must have community access tier 'contributor'
-- or 'balanced' (computed by company_community_access).
-- Append-only: no UPDATE/DELETE RPCs are exposed.

begin;

create table public.community_point_notes (
  id uuid primary key default gen_random_uuid(),
  community_point_id uuid not null
    references public.community_points(id) on delete cascade,
  company_id uuid not null
    references public.companies(id) on delete cascade,
  user_id uuid not null,
  body text not null check (length(trim(body)) > 0 and length(body) <= 4000),
  created_at timestamptz not null default now()
);

create index community_point_notes_point_idx
  on public.community_point_notes(community_point_id, created_at desc);

alter table public.community_points
  add column note_count integer not null default 0;

alter table public.community_point_notes enable row level security;
-- No direct policies. All access goes through SECURITY DEFINER RPCs below.

create or replace function public.add_community_point_note(
  target_community_point_id uuid,
  target_company_id uuid,
  note_body text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  trimmed_body text;
  new_note_id uuid;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  trimmed_body := trim(coalesce(note_body, ''));
  if trimmed_body = '' then
    raise exception 'Field note body cannot be empty.';
  end if;
  if length(trimmed_body) > 4000 then
    raise exception 'Field notes are limited to 4000 characters.';
  end if;

  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of the company you specified.';
  end if;

  if not exists (
    select 1 from public.community_point_observations
    where community_point_id = target_community_point_id
      and company_id = target_company_id
  ) then
    raise exception 'Only companies that have shared a point at this location can post field notes.';
  end if;

  insert into public.community_point_notes (community_point_id, company_id, user_id, body)
  values (target_community_point_id, target_company_id, auth.uid(), trimmed_body)
  returning id into new_note_id;

  update public.community_points
    set note_count = note_count + 1
    where id = target_community_point_id;

  return new_note_id;
end;
$$;

create or replace function public.list_community_point_notes(
  target_community_point_id uuid,
  target_company_id uuid
) returns table (
  id uuid,
  body text,
  company_id uuid,
  company_name text,
  user_id uuid,
  user_email text,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path to 'public'
as $$
declare
  access_tier text;
begin
  if auth.uid() is null then
    raise exception 'You must be signed in.';
  end if;

  if not public.is_company_member(target_company_id) then
    raise exception 'You are not a member of the company you specified.';
  end if;

  access_tier := public.company_community_access(target_company_id);
  if access_tier not in ('contributor', 'balanced') then
    raise exception 'Your company needs full community access to read field notes.';
  end if;

  return query
  select n.id, n.body, n.company_id, c.name, n.user_id, p.email, n.created_at
  from public.community_point_notes n
  join public.companies c on c.id = n.company_id
  left join public.profiles p on p.id = n.user_id
  where n.community_point_id = target_community_point_id
  order by n.created_at desc;
end;
$$;

commit;
