-- Drop NOT NULL on companies.seat_limit so subscribed companies can have
-- seat_limit = null = unlimited. The stripe-webhook function tries to
-- assign null when a company has an active/trialing subscription; before
-- this change that update was rejected with a 23502 violation, leaving
-- subscribed customers stuck on the small free-tier seat cap.

begin;

alter table public.companies
  alter column seat_limit drop not null;

commit;
