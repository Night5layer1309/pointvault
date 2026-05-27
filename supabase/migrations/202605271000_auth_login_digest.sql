-- Daily login-activity digest emailed via Resend.
--
-- Supabase records auth events in auth.audit_log_entries, but that schema is
-- not exposed through PostgREST, so we read it from a SECURITY DEFINER function
-- (owned by postgres) and push a summary out through Resend's HTTP API using
-- pg_net. pg_cron runs it once a day.
--
-- Only *successful* events live in this table: logins, new signups, and
-- password-reset requests. Failed/wrong-password attempts are NOT here (they
-- only appear in the dashboard Auth Logs), so they are intentionally absent.
--
-- SECRETS (set once via the Supabase SQL editor — do NOT commit real values):
--   select vault.create_secret('re_your_resend_api_key', 'resend_api_key');
--   select vault.create_secret('PointVault Alerts <alerts@your-verified-domain>', 'auth_digest_from');
-- The 'from' address must be on a domain you've verified in Resend.

begin;

create extension if not exists pg_net;
create extension if not exists pg_cron;

create or replace function public.send_auth_login_digest(window_hours integer default 24)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  _api_key text;
  _from text;
  _to text := 'skinners1309@gmail.com';
  _since timestamptz := now() - make_interval(hours => window_hours);
  _login_count integer := 0;
  _signup_count integer := 0;
  _recovery_count integer := 0;
  _rows_html text := '';
  _html text;
  _subject text;
begin
  select decrypted_secret into _api_key from vault.decrypted_secrets where name = 'resend_api_key';
  select decrypted_secret into _from from vault.decrypted_secrets where name = 'auth_digest_from';

  if _api_key is null then
    raise exception 'Missing Vault secret: resend_api_key';
  end if;
  if _from is null then
    raise exception 'Missing Vault secret: auth_digest_from';
  end if;

  with events as (
    select
      e.created_at,
      (e.payload::jsonb ->> 'action') as action,
      (e.payload::jsonb ->> 'actor_username') as email,
      e.ip_address
    from auth.audit_log_entries e
    where e.created_at >= _since
      and (e.payload::jsonb ->> 'action') in ('login', 'user_signedup', 'user_recovery_requested')
  )
  select
    count(*) filter (where action = 'login'),
    count(*) filter (where action = 'user_signedup'),
    count(*) filter (where action = 'user_recovery_requested'),
    coalesce(string_agg(
      format(
        '<tr><td style="padding:4px 10px;border-bottom:1px solid #eee;">%s</td>'
        '<td style="padding:4px 10px;border-bottom:1px solid #eee;">%s</td>'
        '<td style="padding:4px 10px;border-bottom:1px solid #eee;">%s</td>'
        '<td style="padding:4px 10px;border-bottom:1px solid #eee;">%s</td></tr>',
        to_char(created_at at time zone 'America/New_York', 'Mon DD HH24:MI'),
        case action
          when 'login' then 'Sign-in'
          when 'user_signedup' then 'New signup'
          when 'user_recovery_requested' then 'Password reset'
          else action
        end,
        coalesce(email, '—'),
        coalesce(ip_address::text, '—')
      ),
      '' order by created_at desc
    ), '')
  into _login_count, _signup_count, _recovery_count, _rows_html
  from events;

  _subject := format(
    'PointVault logins: %s sign-in%s, %s signup%s (last %sh)',
    _login_count, case when _login_count = 1 then '' else 's' end,
    _signup_count, case when _signup_count = 1 then '' else 's' end,
    window_hours
  );

  if _rows_html = '' then
    _html := format(
      '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;">'
      '<h2 style="margin-bottom:4px;">PointVault login summary</h2>'
      '<p style="color:#475569;">No sign-ins, signups, or password-reset requests in the last %s hours.</p></div>',
      window_hours
    );
  else
    _html := format(
      '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;">'
      '<h2 style="margin-bottom:4px;">PointVault login summary</h2>'
      '<p style="color:#475569;margin-top:0;">Last %s hours · %s sign-in(s) · %s signup(s) · %s password reset(s) · times in ET</p>'
      '<table style="border-collapse:collapse;font-size:13px;">'
      '<thead><tr>'
      '<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #cbd5e1;">When</th>'
      '<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #cbd5e1;">Event</th>'
      '<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #cbd5e1;">User</th>'
      '<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #cbd5e1;">IP</th>'
      '</tr></thead><tbody>%s</tbody></table></div>',
      window_hours, _login_count, _signup_count, _recovery_count, _rows_html
    );
  end if;

  perform net.http_post(
    url := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || _api_key,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object(
      'from', _from,
      'to', jsonb_build_array(_to),
      'subject', _subject,
      'html', _html
    )
  );

  return jsonb_build_object(
    'logins', _login_count,
    'signups', _signup_count,
    'recoveries', _recovery_count,
    'sent_to', _to
  );
end;
$$;

-- Run daily at 13:00 UTC (~8a EST / 9a EDT). Named schedule upserts, so
-- re-applying this migration won't create duplicate jobs.
select cron.schedule(
  'auth-login-digest-daily',
  '0 13 * * *',
  $job$ select public.send_auth_login_digest(); $job$
);

commit;
