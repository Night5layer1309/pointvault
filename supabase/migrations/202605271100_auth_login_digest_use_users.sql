-- Rebuild the daily login digest to read from auth.users instead of
-- auth.audit_log_entries. That audit table is empty on this project (nothing
-- writes to it — confirmed 2026-05-27), so the previous version always reported
-- zero. auth.users.last_sign_in_at is reliably updated on every sign-in.
--
-- Trade-offs vs the audit log: shows each user's MOST RECENT sign-in within the
-- window (not every individual login), and no IP address (not retained here).
-- Source columns: auth.users.last_sign_in_at (logins), auth.users.created_at
-- (new signups). The cron schedule from the prior migration is unchanged.

begin;

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
    select u.email, u.last_sign_in_at as ts, 'Sign-in' as kind, 1 as is_login, 0 as is_signup
    from auth.users u
    where u.last_sign_in_at >= _since
    union all
    select u.email, u.created_at as ts, 'New signup' as kind, 0 as is_login, 1 as is_signup
    from auth.users u
    where u.created_at >= _since
  )
  select
    coalesce(sum(is_login), 0)::integer,
    coalesce(sum(is_signup), 0)::integer,
    coalesce(string_agg(
      format(
        '<tr><td style="padding:4px 10px;border-bottom:1px solid #eee;">%s</td>'
        '<td style="padding:4px 10px;border-bottom:1px solid #eee;">%s</td>'
        '<td style="padding:4px 10px;border-bottom:1px solid #eee;">%s</td></tr>',
        to_char(ts at time zone 'America/New_York', 'Mon DD HH24:MI'),
        kind,
        coalesce(email, '—')
      ),
      '' order by ts desc
    ), '')
  into _login_count, _signup_count, _rows_html
  from events;

  _subject := format(
    'PointVault logins: %s sign-in%s, %s new signup%s (last %sh)',
    _login_count, case when _login_count = 1 then '' else 's' end,
    _signup_count, case when _signup_count = 1 then '' else 's' end,
    window_hours
  );

  if _rows_html = '' then
    _html := format(
      '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;">'
      '<h2 style="margin-bottom:4px;">PointVault login summary</h2>'
      '<p style="color:#475569;">No sign-ins or new signups in the last %s hours.</p></div>',
      window_hours
    );
  else
    _html := format(
      '<div style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;">'
      '<h2 style="margin-bottom:4px;">PointVault login summary</h2>'
      '<p style="color:#475569;margin-top:0;">Last %s hours · %s sign-in(s) · %s new signup(s) · times in ET</p>'
      '<table style="border-collapse:collapse;font-size:13px;">'
      '<thead><tr>'
      '<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #cbd5e1;">When</th>'
      '<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #cbd5e1;">Event</th>'
      '<th style="text-align:left;padding:4px 10px;border-bottom:2px solid #cbd5e1;">User</th>'
      '</tr></thead><tbody>%s</tbody></table>'
      '<p style="color:#94a3b8;font-size:11px;margin-top:12px;">Shows each user''s most recent sign-in in the window. Failed logins are not tracked.</p></div>',
      window_hours, _login_count, _signup_count, _rows_html
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
    'sent_to', _to
  );
end;
$$;

commit;
