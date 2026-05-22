-- PointVault company account system
-- Adds company-owned accounts, memberships, invitations, RLS helpers,
-- and a company-scoped nearby-points RPC.

create extension if not exists pgcrypto;
create extension if not exists postgis;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  owner_id uuid not null references auth.users(id) on delete restrict,
  plan_status text not null default 'trial' check (plan_status in ('trial', 'active', 'past_due', 'canceled')),
  seat_limit integer not null default 5 check (seat_limit > 0),
  stripe_customer_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.company_memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  status text not null default 'active' check (status in ('active', 'invited', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, user_id)
);

create table if not exists public.company_invites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  token uuid not null unique default gen_random_uuid(),
  invited_by uuid not null references auth.users(id) on delete cascade,
  accepted_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  expires_at timestamptz not null default (now() + interval '14 days'),
  created_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function public.touch_updated_at();

drop trigger if exists companies_touch_updated_at on public.companies;
create trigger companies_touch_updated_at before update on public.companies
for each row execute function public.touch_updated_at();

drop trigger if exists memberships_touch_updated_at on public.company_memberships;
create trigger memberships_touch_updated_at before update on public.company_memberships
for each row execute function public.touch_updated_at();

create or replace function public.handle_new_user_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users
for each row execute function public.handle_new_user_profile();

create or replace function public.is_company_member(target_company_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_memberships cm
    where cm.company_id = target_company_id
      and cm.user_id = auth.uid()
      and cm.status = 'active'
  );
$$;

create or replace function public.is_company_admin(target_company_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.company_memberships cm
    where cm.company_id = target_company_id
      and cm.user_id = auth.uid()
      and cm.status = 'active'
      and cm.role in ('owner', 'admin')
  );
$$;

create or replace function public.create_company_with_owner(company_name text, company_slug text default null, full_name text default null)
returns public.companies language plpgsql security definer set search_path = public as $$
declare
  created_company public.companies;
  base_slug text;
  final_slug text;
begin
  if auth.uid() is null then raise exception 'You must be signed in to create a company.'; end if;
  if nullif(trim(company_name), '') is null then raise exception 'Company name is required.'; end if;

  base_slug := lower(regexp_replace(coalesce(nullif(trim(company_slug), ''), trim(company_name)), '[^a-zA-Z0-9]+', '-', 'g'));
  final_slug := trim(both '-' from base_slug);
  if final_slug = '' then final_slug := 'company-' || left(gen_random_uuid()::text, 8); end if;

  insert into public.profiles (id, email, full_name)
  values (auth.uid(), auth.jwt() ->> 'email', coalesce(full_name, ''))
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(nullif(excluded.full_name, ''), public.profiles.full_name);

  insert into public.companies (name, slug, owner_id)
  values (trim(company_name), final_slug, auth.uid())
  returning * into created_company;

  insert into public.company_memberships (company_id, user_id, role, status)
  values (created_company.id, auth.uid(), 'owner', 'active')
  on conflict (company_id, user_id) do update set role = 'owner', status = 'active';

  return created_company;
end;
$$;

create or replace function public.invite_company_member(target_company_id uuid, invite_email text, invite_role text default 'member')
returns uuid language plpgsql security definer set search_path = public as $$
declare invite_token uuid;
begin
  if not public.is_company_admin(target_company_id) then
    raise exception 'Only company owners and admins can invite team members.';
  end if;
  if invite_role not in ('admin', 'member') then raise exception 'Invite role must be admin or member.'; end if;

  insert into public.company_invites (company_id, email, role, invited_by)
  values (target_company_id, lower(trim(invite_email)), invite_role, auth.uid())
  returning token into invite_token;
  return invite_token;
end;
$$;

create or replace function public.accept_company_invitation(invite_token uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare invite_row public.company_invites;
begin
  if auth.uid() is null then raise exception 'You must be signed in to accept an invite.'; end if;
  select * into invite_row from public.company_invites
  where token = invite_token and accepted_at is null and expires_at > now();
  if invite_row.id is null then raise exception 'Invite not found, already used, or expired.'; end if;
  if lower(coalesce(auth.jwt() ->> 'email', '')) <> lower(invite_row.email) then
    raise exception 'This invite was sent to a different email address.';
  end if;

  insert into public.company_memberships (company_id, user_id, role, status)
  values (invite_row.company_id, auth.uid(), invite_row.role, 'active')
  on conflict (company_id, user_id) do update set role = excluded.role, status = 'active';

  update public.company_invites set accepted_at = now(), accepted_by = auth.uid() where id = invite_row.id;
  return invite_row.company_id;
end;
$$;

alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.company_memberships enable row level security;
alter table public.company_invites enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
create policy "Users can read their own profile" on public.profiles for select using (id = auth.uid());

drop policy if exists "Users can update their own profile" on public.profiles;
create policy "Users can update their own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "Company members can read company" on public.companies;
create policy "Company members can read company" on public.companies for select using (public.is_company_member(id));

drop policy if exists "Company owners can create company" on public.companies;
create policy "Company owners can create company" on public.companies for insert with check (owner_id = auth.uid());

drop policy if exists "Company admins can update company" on public.companies;
create policy "Company admins can update company" on public.companies for update using (public.is_company_admin(id)) with check (public.is_company_admin(id));

drop policy if exists "Members can read company memberships" on public.company_memberships;
create policy "Members can read company memberships" on public.company_memberships for select using (public.is_company_member(company_id));

drop policy if exists "Admins can manage company memberships" on public.company_memberships;
create policy "Admins can manage company memberships" on public.company_memberships for all using (public.is_company_admin(company_id)) with check (public.is_company_admin(company_id));

drop policy if exists "Admins can read company invites" on public.company_invites;
create policy "Admins can read company invites" on public.company_invites for select using (public.is_company_admin(company_id));

drop policy if exists "Admins can create company invites" on public.company_invites;
create policy "Admins can create company invites" on public.company_invites for insert with check (public.is_company_admin(company_id));

drop policy if exists "Admins can update company invites" on public.company_invites;
create policy "Admins can update company invites" on public.company_invites for update using (public.is_company_admin(company_id)) with check (public.is_company_admin(company_id));

do $$
begin
  if to_regclass('public.survey_points') is not null then
    alter table public.survey_points add column if not exists company_id uuid references public.companies(id) on delete cascade;
    create index if not exists survey_points_company_id_idx on public.survey_points(company_id);
    alter table public.survey_points enable row level security;

    execute 'drop policy if exists "Company members can read survey points" on public.survey_points';
    execute 'create policy "Company members can read survey points" on public.survey_points for select using (public.is_company_member(company_id))';
    execute 'drop policy if exists "Company members can insert survey points" on public.survey_points';
    execute 'create policy "Company members can insert survey points" on public.survey_points for insert with check (public.is_company_member(company_id))';
    execute 'drop policy if exists "Company members can update survey points" on public.survey_points';
    execute 'create policy "Company members can update survey points" on public.survey_points for update using (public.is_company_member(company_id)) with check (public.is_company_member(company_id))';
    execute 'drop policy if exists "Company admins can delete survey points" on public.survey_points';
    execute 'create policy "Company admins can delete survey points" on public.survey_points for delete using (public.is_company_admin(company_id))';
  end if;
end;
$$;

create or replace function public.nearby_company_points(
  target_company_id uuid,
  user_lat double precision,
  user_lng double precision,
  radius_feet double precision default 5280,
  result_limit integer default 500
)
returns table (
  id text,
  point_id text,
  name text,
  status text,
  reliability text,
  latitude double precision,
  longitude double precision,
  northing text,
  easting text,
  coordinate_system text,
  job text,
  source_file text,
  county text,
  crew text,
  last_found date,
  description text,
  distance_feet double precision
)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_company_member(target_company_id) then raise exception 'You are not a member of this company.'; end if;
  if to_regclass('public.survey_points') is null then return; end if;

  return query execute '
    select sp.id::text, sp.point_id::text, coalesce(sp.name, sp.point_id::text) as name,
      coalesce(sp.status, ''found'') as status, coalesce(sp.reliability, ''C'') as reliability,
      sp.latitude::double precision, sp.longitude::double precision, sp.northing::text,
      sp.easting::text, sp.coordinate_system::text, sp.job::text, sp.source_file::text,
      sp.county::text, sp.crew::text, sp.last_found::date, sp.description::text,
      (st_distance(st_setsrid(st_makepoint(sp.longitude, sp.latitude), 4326)::geography,
                   st_setsrid(st_makepoint($3, $2), 4326)::geography) * 3.28084)::double precision as distance_feet
    from public.survey_points sp
    where sp.company_id = $1 and sp.latitude is not null and sp.longitude is not null
      and (st_distance(st_setsrid(st_makepoint(sp.longitude, sp.latitude), 4326)::geography,
                       st_setsrid(st_makepoint($3, $2), 4326)::geography) * 3.28084) <= $4
    order by distance_feet asc limit $5
  ' using target_company_id, user_lat, user_lng, radius_feet, result_limit;
end;
$$;

grant execute on function public.create_company_with_owner(text, text, text) to authenticated;
grant execute on function public.invite_company_member(uuid, text, text) to authenticated;
grant execute on function public.accept_company_invitation(uuid) to authenticated;
grant execute on function public.nearby_company_points(uuid, double precision, double precision, double precision, integer) to authenticated;
