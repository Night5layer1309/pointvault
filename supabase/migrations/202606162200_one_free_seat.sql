-- Drop the free-tier seat limit from 5 to 1 — at sign-up the owner is alone
-- until they subscribe (or accept an invite to an existing company). Matches
-- the value the stripe-webhook now flips to on cancellation. Existing
-- companies keep their current seat_limit; this only changes the default for
-- new rows.

begin;

alter table public.companies
  alter column seat_limit set default 1;

commit;
