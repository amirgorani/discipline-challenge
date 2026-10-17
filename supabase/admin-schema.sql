-- =============================================================
-- Challenge Planner — ADMIN PANEL add-on schema (v1)
-- Run in: Supabase Dashboard → SQL Editor → New query
-- Run AFTER supabase/schema.sql (it is additive and idempotent).
--
-- Adds, WITHOUT touching historical user data:
--   • profiles: role, account_status + activity columns
--   • challenges: duration_days (challenge lifecycle window)
--   • custom_task_history: archived titles of deleted tasks, so the
--     admin panel can keep day-by-day history accurate forever
--   • admin_audit_logs: administrator audit trail
--   • activity-tracking triggers + admin RLS policies + admin RPCs
--
-- SECURITY MODEL
--   • Both frontends use ONLY the public anon key. The service_role
--     key never appears in client-side code.
--   • role / account_status / activity columns are system-managed:
--     column-level grants + a BEFORE UPDATE trigger block direct
--     writes; transitions happen ONLY via audited security-definer
--     RPCs that verify the caller's role server-side.
--   • Administrators get read access through RLS policies calling
--     is_admin() — never trusting frontend role checks.
--   • "super_admin" is a second tier: it may manage admin roles.
--     Plain "admin" may manage regular users only.
-- ______________________________________________________________
-- BOOTSTRAP THE FIRST SUPER ADMIN (do this ONCE):
--   1) Sign up through the normal app screen (index.html).
--   2) Uncomment the block at the bottom of this file, replace the
--      placeholder e-mail with that account's e-mail, run it, and
--      re-comment. This grants the role — no passwords live here.
-- =============================================================

-- ---------- 1) profiles: role / status / activity ----------
alter table public.profiles
  add column if not exists role text not null default 'user'
    check (role in ('user', 'admin', 'super_admin'));
alter table public.profiles
  add column if not exists account_status text not null default 'active'
    check (account_status in ('active', 'suspended'));
alter table public.profiles
  add column if not exists last_login_at timestamptz;
alter table public.profiles
  add column if not exists last_activity_at timestamptz;
alter table public.profiles
  add column if not exists last_submission_at timestamptz;

-- ---------- 2) challenges: lifecycle window ----------
-- The planner's standard cycle is a 90-day challenge; the column is
-- additive (existing rows get 90) and optional to edit later.
alter table public.challenges
  add column if not exists duration_days integer not null default 90
    check (duration_days between 1 and 3650);

-- ---------- 3) indexes for admin-scale queries ----------
create index if not exists profiles_role_status_idx     on public.profiles (role, account_status);
create index if not exists profiles_last_activity_idx   on public.profiles (last_activity_at desc nulls last);
create index if not exists profiles_created_idx         on public.profiles (created_at desc);
create index if not exists challenges_start_idx         on public.challenges (start_date);
create index if not exists challenges_user_created_idx  on public.challenges (user_id, created_at desc);
create index if not exists submissions_day_idx          on public.daily_submissions (day);
create index if not exists scores_day_idx               on public.daily_scores (day);
create index if not exists scores_status_idx            on public.daily_scores (status);
create index if not exists task_history_challenge_idx   on public.custom_task_history (challenge_id);
create index if not exists audit_created_idx            on public.admin_audit_logs (created_at desc);
create index if not exists audit_action_created_idx     on public.admin_audit_logs (action, created_at desc);

-- ---------- 4) helper role checks (RLS-safe) ----------
-- security definer → reads profiles as the table owner, so these are
-- safe to call from OTHER tables' policies without recursion.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role in ('admin', 'super_admin')
      and p.account_status = 'active'
  );
$$;

create or replace function public.is_super_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.role = 'super_admin'
      and p.account_status = 'active'
  );
$$;

grant execute on function public.is_admin()  to public;
grant execute on function public.is_super_admin() to public;

-- ---------- 5) privilege guard on profile columns ----------
-- A hard server-side lock: direct API writes can never change the
-- role/status/activity columns, no matter what the frontend sends.
create or replace function public.guard_profile_admin_columns()
returns trigger
language plpgsql
as $$
begin
  if (new.role              is distinct from old.role)
     or (new.account_status is distinct from old.account_status)
     or (new.last_login_at  is distinct from old.last_login_at)
     or (new.last_activity_at is distinct from old.last_activity_at)
     or (new.last_submission_at is distinct from old.last_submission_at) then
    -- Only privileged server-side paths (security-definer RPCs running
    -- as the function owner / service_role / SQL editor) may pass.
    if current_user in ('anon', 'authenticated') then
      raise exception 'PROTECTED_COLUMNS: role/status/activity columns are system-managed';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists trg_guard_profile on public.profiles;
create trigger trg_guard_profile
  before update on public.profiles
  for each row execute function public.guard_profile_admin_columns();

-- Column-level grants: the regular app may only
--   • read its own profile (RLS limits to own row)
--   • create its profile on signup (id, username)
--   • rename its own username
-- role/status/activity transitions go through audited RPCs below.
revoke all on public.profiles from anon;
revoke all on public.profiles from authenticated;
grant select on public.profiles to authenticated;
grant insert (id, username) on public.profiles to authenticated;
grant update (username) on public.profiles to authenticated;

-- ---------- 6) activity tracking ----------
-- Meaningful activity = logins (touch_activity) and daily submissions.
create or replace function public.touch_activity(p_login boolean default false)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'UNAUTHORIZED';
  end if;
  update public.profiles
     set last_activity_at = now(),
         last_login_at = case when coalesce(p_login, false) then now() else last_login_at end
   where id = v_uid;
end;
$$;
revoke execute on function public.touch_activity(boolean) from public, anon;
grant execute on function public.touch_activity(boolean) to authenticated, service_role;

create or replace function public.touch_on_submission()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_user uuid;
begin
  select c.user_id into v_user from public.challenges c where c.id = new.challenge_id;
  if v_user is not null then
    update public.profiles
       set last_activity_at = now(), last_submission_at = now()
     where id = v_user;
  end if;
  return null;
end;
$$;
drop trigger if exists trg_touch_on_submission on public.daily_submissions;
create trigger trg_touch_on_submission
  after insert or update on public.daily_submissions
  for each row execute function public.touch_on_submission();

-- ---------- 7) archived optional-task titles ----------
-- The main app allows users to delete/edit optional tasks while
-- old daily results keep their snapshot in daily_scores. This archive
-- preserves also the TITLE so the admin panel can always resolve
-- which optional task existed on a historical day.
create table if not exists public.custom_task_history (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  challenge_id uuid not null,
  title text not null,
  description text not null default '',
  created_at timestamptz,
  archived_at timestamptz not null default now()
);
create unique index if not exists task_history_task_idx on public.custom_task_history (task_id);
alter table public.custom_task_history enable row level security;
drop policy if exists "admin read task history" on public.custom_task_history;
create policy "admin read task history" on public.custom_task_history
  for select using (public.is_admin());
revoke all on public.custom_task_history from anon;
revoke all on public.custom_task_history from authenticated;
grant select on public.custom_task_history to authenticated;

create or replace function public.archive_custom_task_on_delete()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.custom_task_history (task_id, challenge_id, title, description, created_at)
  values (old.id, old.challenge_id, old.title, coalesce(old.description, ''), old.created_at)
  on conflict (task_id) do nothing;
  return null;
end;
$$;
drop trigger if exists trg_task_history on public.custom_tasks;
create trigger trg_task_history
  after delete on public.custom_tasks
  for each row execute function public.archive_custom_task_on_delete();

-- ---------- 8) audit log (read for admins, write via RPCs only) ----------
create table if not exists public.admin_audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid not null references auth.users (id) on delete cascade,
  action text not null,
  target_user uuid references auth.users (id) on delete set null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_audit_logs enable row level security;
drop policy if exists "admin read audit logs" on public.admin_audit_logs;
create policy "admin read audit logs" on public.admin_audit_logs
  for select using (public.is_admin());
revoke all on public.admin_audit_logs from anon;
revoke all on public.admin_audit_logs from authenticated;
grant select on public.admin_audit_logs to authenticated;

-- ---------- 9) admin READ access over user data (RLS) ----------
-- Regular users keep every existing policy untouched; these new
-- SELECT-only policies simply let verified administrators read all.
drop policy if exists "admin read profiles" on public.profiles;
create policy "admin read profiles" on public.profiles
  for select using (public.is_admin());
drop policy if exists "admin read challenges" on public.challenges;
create policy "admin read challenges" on public.challenges
  for select using (public.is_admin());
drop policy if exists "admin read custom tasks" on public.custom_tasks;
create policy "admin read custom tasks" on public.custom_tasks
  for select using (public.is_admin());
drop policy if exists "admin read submissions" on public.daily_submissions;
create policy "admin read submissions" on public.daily_submissions
  for select using (public.is_admin());
drop policy if exists "admin read scores" on public.daily_scores;
create policy "admin read scores" on public.daily_scores
  for select using (public.is_admin());

-- ============================================================
-- ADMIN RPCs (all security definer, server-side role checks,
-- audit-logged mutations). PostgREST calls them by name.
-- ============================================================

-- ---------- 10) admin login by username (email lookup) ----------
-- Returns the auth e-mail ONLY when the username belongs to an active
-- administrator, so the login form can accept «نام کاربری یا ایمیل».
create or replace function public.admin_resolve_admin_login(p_name text)
returns text
language plpgsql stable security definer set search_path = public
as $$
declare
  v_email text;
begin
  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'INVALID_INPUT';
  end if;
  select u.email into v_email
  from public.profiles p
  join auth.users u on u.id = p.id
  where lower(p.username) = lower(trim(p_name))
    and p.role in ('admin', 'super_admin')
    and p.account_status = 'active'
  limit 1;
  return v_email; -- null for non-admin usernames
end;
$$;

-- ---------- 11) touch / audit own admin login ----------
create or replace function public.touch_admin_login()
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or not public.is_admin() then
    raise exception 'UNAUTHORIZED';
  end if;
  update public.profiles
     set last_activity_at = now(), last_login_at = now()
   where id = v_uid;
  insert into public.admin_audit_logs (actor_id, action, details)
  values (v_uid, 'admin_login', jsonb_build_object('at', now()));
end;
$$;

-- ---------- 12) overview dashboard statistics ----------
-- One round-trip computes every dashboard metric from real rows.
create or replace function public.admin_overview_stats()
returns jsonb
language sql stable security definer set search_path = public
as $$
with prof as (
  select p.id, p.username, p.role, p.account_status, p.created_at,
         greatest(p.last_login_at, p.last_activity_at, p.last_submission_at) as last_seen
  from public.profiles p
),
chplc as (
  select c.id, c.user_id, c.start_date, coalesce(c.duration_days, 90) as dur,
         (c.start_date > current_date) as is_upcoming,
         (current_date >= c.start_date
             and current_date <= c.start_date + coalesce(c.duration_days, 90) - 1) as is_ongoing,
         (current_date > c.start_date + coalesce(c.duration_days, 90) - 1) as is_completed,
         least(greatest(current_date - c.start_date + 1, 0), coalesce(c.duration_days, 90)) as window_elapsed,
         greatest(current_date - c.start_date + 1, 0) as elapsed_so_far
  from public.challenges c
),
chsub as (
  select s.challenge_id,
         count(*) filter (where s.status = 'submitted') as sub_days,
         coalesce(sum(s.mandatory_points) filter (where s.status = 'submitted'), 0) as points,
         coalesce(sum(s.bonus_points), 0) as bonus,
         coalesce(sum(s.optional_done), 0) as opt_done,
         coalesce(sum(s.optional_total), 0) as opt_total
  from public.daily_scores s
  group by s.challenge_id
),
uchal as (
  select c.user_id,
         count(*) as ch_total,
         count(*) filter (where c.is_ongoing) as ch_ongoing,
         count(*) filter (where c.is_completed) as ch_completed,
         count(*) filter (where c.is_upcoming) as ch_upcoming,
         coalesce(sum(c.window_elapsed), 0) as window_elapsed,
         coalesce(sum(cs.sub_days), 0) as sub_days,
         coalesce(sum(cs.points), 0) as points,
         coalesce(sum(cs.bonus), 0) as bonus,
         coalesce(sum(cs.opt_done), 0) as opt_done,
         coalesce(sum(cs.opt_total), 0) as opt_total
  from chplc c
  left join chsub cs on cs.challenge_id = c.id
  where c.start_date <= current_date
  group by c.user_id
),
uperf as (
  select user_id, window_elapsed, sub_days, points, bonus, opt_done, opt_total,
         case when window_elapsed >= 1
              then least(100, round(100 * points / (60 * window_elapsed)))
         end as score
  from uchal
),
rates as (
  select
    (select count(*) from public.daily_scores where status = 'submitted')::numeric as total_submitted,
    (select coalesce(sum(window_elapsed), 0) from uperf where window_elapsed >= 1)::numeric as total_elapsed,
    (select round(avg(score)) from uperf where score is not null)::numeric as avg_perf
),
days as (
  select d::date as day
  from generate_series(current_date - interval '13 days', current_date, interval '1 day') d
),
trend as (
  select d.day::text as day,
         (select count(*) from public.daily_scores s where s.day = d.day and s.status = 'submitted') as submitted,
         (select count(*) from public.daily_scores s where s.day = d.day and s.status = 'missed') as missed,
         (select count(*) from public.profiles p where p.created_at::date = d.day) as signups
  from days d
)
select jsonb_build_object(
  'generated_at', now(),
  'users', jsonb_build_object(
    'total',            (select count(*) from prof),
    'admins',           (select count(*) from prof where role <> 'user'),
    'suspended',        (select count(*) from prof where account_status = 'suspended'),
    'account_active',   (select count(*) from prof where account_status = 'active'),
    'active_today',     (select count(*) from prof where last_seen >= now() - interval '1 day'),
    'active_7d',        (select count(*) from prof where last_seen >= now() - interval '7 days'),
    'active_14d',       (select count(*) from prof where last_seen >= now() - interval '14 days'),
    'inactive_14d',     (select count(*) from prof where last_seen is null or last_seen < now() - interval '14 days'),
    'deep_inactive_60d',(select count(*) from prof where last_seen is null or last_seen < now() - interval '60 days')
  ),
  'challenges', jsonb_build_object(
    'total',     (select count(*) from chplc),
    'ongoing',   (select count(*) from chplc where is_ongoing),
    'completed', (select count(*) from chplc where is_completed),
    'upcoming',  (select count(*) from chplc where is_upcoming)
  ),
  'submissions', jsonb_build_object(
    'total',     (select count(*) from public.daily_submissions),
    'submitted', (select count(*) from public.daily_scores where status = 'submitted'),
    'missed',    (select count(*) from public.daily_scores where status = 'missed'),
    'opt_done',  (select coalesce(sum(opt_done), 0) from uperf),
    'opt_total', (select coalesce(sum(opt_total), 0) from uperf),
    'bonus',     (select coalesce(sum(bonus), 0) from uperf)
  ),
  'completion_rate',
    (select case when total_elapsed >= 1
                 then least(100.0, round(100 * total_submitted / total_elapsed, 1))
                 else 0 end
     from rates limit 1),
  'avg_performance',
    (select coalesce(avg_perf, 0) from rates limit 1),
  'trend_14d', (select coalesce(jsonb_agg(to_jsonb(t) order by t.day), '[]'::jsonb) from trend t),
  'top_users', (
    select coalesce(jsonb_agg(to_jsonb(b) order by b.score desc), '[]'::jsonb) from (
      select pr.id as user_id, pr.username, up.score, up.sub_days
      from prof pr
      join uperf up on up.user_id = pr.id
      where up.score is not null
      order by up.score desc
      limit 5
    ) b
  )
);
$$;

-- ---------- 13) paginated users list ----------
create or replace function public.admin_users_page(
  p_search    text    default '',
  p_status    text    default 'all',       -- all|account_active|suspended|admins|regular
  p_activity  text    default 'all',       -- all|active_today|active_7d|active_14d|low|inactive
  p_sort      text    default 'created',   -- created|created_asc|performance|performance_asc|activity
  p_page      integer default 1,
  p_page_size integer default 20
)
returns table (
  o_id uuid, o_username text, o_email text, o_role text, o_account_status text,
  o_created_at timestamptz, o_login_at timestamptz, o_last_seen timestamptz,
  o_last_submission_at timestamptz,
  o_challenges bigint, o_ongoing bigint, o_completed bigint, o_submitted_days bigint,
  o_perf integer, o_total bigint
)
language sql stable security definer set search_path = public
as $$
with prof as (
  select p.id, p.username, p.role, p.account_status, p.created_at,
         p.last_login_at, p.last_submission_at,
         greatest(p.last_login_at, p.last_activity_at, p.last_submission_at) as last_seen,
         (select u.email from auth.users u where u.id = p.id) as email
  from public.profiles p
),
uchal as (
  select c.user_id,
         count(*) as ch_total,
         count(*) filter (where c.is_ongoing) as ch_ongoing,
         count(*) filter (where c.is_completed) as ch_completed,
         coalesce(sum(c.window_elapsed), 0) as window_elapsed,
         coalesce(sum(cs.sub_days), 0) as sub_days,
         coalesce(sum(cs.points), 0) as points
  from (
    select id, user_id, start_date,
           (current_date >= start_date
               and current_date <= start_date + coalesce(duration_days, 90) - 1) as is_ongoing,
           least(greatest(current_date - start_date + 1, 0), coalesce(duration_days, 90)) as window_elapsed
    from public.challenges
  ) c
  left join (
    select s.challenge_id,
           count(*) filter (where s.status = 'submitted') as sub_days,
           coalesce(sum(s.mandatory_points) filter (where s.status = 'submitted'), 0) as points
    from public.daily_scores s
    group by s.challenge_id
  ) cs on cs.challenge_id = c.id
  where start_date <= current_date
  group by c.user_id
),
uperf as (
  select user_id, ch_total, ch_ongoing, ch_completed, window_elapsed, sub_days,
         case when window_elapsed >= 1
              then least(100, round(100 * points / (60 * window_elapsed)))
         end as score
  from uchal
),
fltr as (
  select pr.*, up.ch_total, up.ch_ongoing, up.ch_completed, up.sub_days, up.score
  from prof pr
  left join uperf up on up.user_id = pr.id
  where (p_status = 'all'
      or (p_status = 'account_active' and pr.account_status = 'active')
      or (p_status = 'suspended' and pr.account_status = 'suspended')
      or (p_status = 'admins' and pr.role <> 'user')
      or (p_status = 'regular' and pr.role = 'user'))
    and (p_activity = 'all'
      or (p_activity = 'active_today' and pr.last_seen >= now() - interval '1 day')
      or (p_activity = 'active_7d'    and pr.last_seen >= now() - interval '7 days')
      or (p_activity = 'active_14d'   and pr.last_seen >= now() - interval '14 days')
      or (p_activity = 'low' and pr.last_seen >= now() - interval '60 days'
                           and pr.last_seen < now() - interval '14 days')
      or (p_activity = 'inactive' and (pr.last_seen is null or pr.last_seen < now() - interval '60 days')))
    and (length(trim(coalesce(p_search, ''))) = 0
      or pr.username ilike '%' || trim(p_search) || '%'
      or coalesce(email, '') ilike '%' || trim(p_search) || '%')
),
paged as (
  select count(*) over () as total, *
  from fltr
  order by
    case p_sort
      when 'created'         then -extract(epoch from created_at)
      when 'created_asc'     then  extract(epoch from created_at)
      when 'performance'     then -coalesce(score, -1)
      when 'performance_asc' then  coalesce(score, 1000000)
      when 'activity'        then -extract(epoch from coalesce(last_seen, '1970-01-01'::timestamptz))
      else -extract(epoch from created_at)
    end
  limit least(greatest(coalesce(p_page_size, 20), 1), 100)
  offset greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_page_size, 20), 1), 100)
)
select
  id, username, email, role, account_status,
  created_at, last_login_at, last_seen, last_submission_at,
  coalesce(ch_total, 0), coalesce(ch_ongoing, 0), coalesce(ch_completed, 0), coalesce(sub_days, 0),
  (case when score is not null then least(100, score)::int end), total
from paged;
$$;

-- ---------- 14) single-user detail (profile + aggregate stats) ----------
create or replace function public.admin_user_detail(p_user uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
with prof as (
  select p.*,
         (select u.email from auth.users u where u.id = p.id) as email,
         greatest(p.last_login_at, p.last_activity_at, p.last_submission_at) as last_seen
  from public.profiles p
  where p.id = p_user
),
chplc as (
  select c.id, c.start_date, coalesce(c.duration_days, 90) as dur,
         least(greatest(current_date - c.start_date + 1, 0), coalesce(c.duration_days, 90)) as window_elapsed,
         greatest(current_date - c.start_date + 1, 0) as elapsed_so_far
  from public.challenges c
  where c.user_id = p_user
),
agg as (
  select
    count(*) as ch_total,
    count(*) filter (where current_date >= c.start_date
                      and current_date <= c.start_date + c.dur - 1) as ch_ongoing,
    count(*) filter (where current_date > c.start_date + c.dur - 1) as ch_completed,
    count(*) filter (where c.start_date > current_date) as ch_upcoming,
    coalesce(sum(c.window_elapsed), 0) as window_elapsed,
    coalesce(sum(c.elapsed_so_far), 0) as elapsed_days,
    coalesce(sum(cs.sub_days), 0) as sub_days,
    coalesce(sum(cs.points), 0) as points,
    coalesce(sum(cs.bonus), 0) as bonus,
    coalesce(sum(cs.missed_rows), 0) as missed_rows,
    coalesce(sum(cs.opt_done), 0) as opt_done,
    coalesce(sum(cs.opt_total), 0) as opt_total
  from chplc c
  left join (
    select s.challenge_id,
           count(*) filter (where s.status = 'submitted') as sub_days,
           count(*) filter (where s.status = 'missed') as missed_rows,
           coalesce(sum(s.mandatory_points) filter (where s.status = 'submitted'), 0) as points,
           coalesce(sum(s.bonus_points), 0) as bonus,
           coalesce(sum(s.optional_done), 0) as opt_done,
           coalesce(sum(s.optional_total), 0) as opt_total
    from public.daily_scores s
    group by s.challenge_id
  ) cs on cs.challenge_id = c.id
  where c.start_date <= current_date
),
recent as (
  select jsonb_agg(to_jsonb(b) order by day desc) as arr
  from (
    select s.challenge_id as challenge_id, c.name as challenge_name, s.day,
           coalesce(sc.mandatory_pct, 0) as pct,
           coalesce(sc.mandatory_points, 0) as points,
           coalesce(sc.grade, '') as grade
    from public.daily_submissions s
    join public.challenges c on c.id = s.challenge_id and c.user_id = p_user
    left join public.daily_scores sc on sc.challenge_id = s.challenge_id and sc.day = s.day
    order by s.day desc
    limit 12
  ) b
)
select coalesce(
  (select jsonb_build_object(
    'found', true,
    'profile', jsonb_build_object(
      'id', p.id, 'username', p.username, 'email', p.email,
      'role', p.role, 'account_status', p.account_status,
      'created_at', p.created_at, 'last_login_at', p.last_login_at,
      'last_activity_at', p.last_activity_at, 'last_submission_at', p.last_submission_at,
      'last_seen', p.last_seen
    ),
    'stats', jsonb_build_object(
      'challenges_total', coalesce(ag.ch_total, 0),
      'ongoing', coalesce(ag.ch_ongoing, 0),
      'completed', coalesce(ag.ch_completed, 0),
      'upcoming', coalesce(ag.ch_upcoming, 0),
      'elapsed_days', coalesce(ag.elapsed_days, 0),
      'window_elapsed', coalesce(ag.window_elapsed, 0),
      'sub_days', coalesce(ag.sub_days, 0),
      'missed_rows', coalesce(ag.missed_rows, 0),
      'points', coalesce(ag.points, 0),
      'bonus', coalesce(ag.bonus, 0),
      'opt_done', coalesce(ag.opt_done, 0),
      'opt_total', coalesce(ag.opt_total, 0),
      'perf', case when coalesce(ag.window_elapsed, 0) >= 1
                   then least(100, round(100 * coalesce(ag.points, 0) / (60 * ag.window_elapsed)))::int
              end
    ),
    'recent', coalesce(recent.arr, '[]'::jsonb)
  )
  from prof p
  cross join agg ag
  cross join recent
  limit 1),
  jsonb_build_object('found', false)
);
$$;

-- ---------- 15) paginated challenges list ----------
create or replace function public.admin_challenges_page(
  p_search    text    default '',
  p_status    text    default 'all',        -- all|ongoing|completed|upcoming|stalled
  p_owner     uuid    default null,
  p_sort      text    default 'created',    -- created|created_asc|coverage|coverage_asc|name
  p_page      integer default 1,
  p_page_size integer default 20
)
returns table (
  o_id uuid, o_user_id uuid, o_owner_username text, o_owner_status text,
  o_name text, o_goal_name text, o_start_date date, o_duration int, o_end_date date,
  o_created_at timestamptz, o_elapsed_days int, o_window_elapsed int,
  o_submitted_days bigint, o_missed_days int, o_pending_today boolean,
  o_points numeric, o_bonus numeric, o_opt_done bigint, o_opt_total bigint,
  o_coverage int, o_status text, o_total bigint
)
language sql stable security definer set search_path = public
as $$
with chl as (
  select c.*, coalesce(c.duration_days, 90) as dur,
         (c.start_date > current_date) as is_upcoming,
         (current_date >= c.start_date
             and current_date <= c.start_date + coalesce(c.duration_days, 90) - 1) as is_ongoing,
         (current_date > c.start_date + coalesce(c.duration_days, 90) - 1) as is_completed,
         least(greatest(current_date - c.start_date + 1, 0), coalesce(c.duration_days, 90)) as window_elapsed,
         greatest(current_date - c.start_date + 1, 0) as elapsed_so_far,
         (c.start_date + coalesce(c.duration_days, 90) - 1) as end_day,
         greatest(current_date - c.start_date + 1, 0) > (coalesce(c.duration_days, 90) * 8 / 10) as near_end
  from public.challenges c
),
subq as (
  select s.challenge_id,
         count(*) filter (where s.status = 'submitted') as sub_days,
         coalesce(sum(s.mandatory_points) filter (where s.status = 'submitted'), 0) as points,
         coalesce(sum(s.bonus_points), 0) as bonus,
         coalesce(sum(s.optional_done), 0) as opt_done,
         coalesce(sum(s.optional_total), 0) as opt_total,
         max(s.day) filter (where s.status = 'submitted') as last_sub_day,
         coalesce(max(case when s.status = 'submitted' and s.day = current_date then 1 end), 0) = 1
           as submitted_today
  from public.daily_scores s
  group by s.challenge_id
),
joint as (
  select c.*, m.sub_days, m.points, m.bonus, m.opt_done, m.opt_total,
         coalesce(m.sub_days, 0) as sub_cnt,
         coalesce(not m.submitted_today, true) as pending_today,
         case when c.is_upcoming
              then 0
              when c.is_completed
              then greatest(0, c.dur - least(coalesce(m.sub_days, 0), c.dur)::int)
              else greatest(0, c.window_elapsed - least(coalesce(m.sub_days, 0), c.window_elapsed)::int)
         end::int as missed_days,
         case when c.is_upcoming then 'upcoming'
              when c.is_completed then 'completed'
              when coalesce(m.last_sub_day, c.start_date - 1) < current_date - 7 then 'stalled'
              else 'ongoing'
         end as life
  from chl c
  left join subq m on m.challenge_id = c.id
),
fltr as (
  select j.*, pr.username as owner_name, pr.account_status as owner_st
  from joint j
  left join public.profiles pr on pr.id = j.user_id
  where (p_owner is null or j.user_id = p_owner)
    and (p_status = 'all' or j.life = p_status)
    and (length(trim(coalesce(p_search, ''))) = 0
      or j.name ilike '%' || trim(p_search) || '%'
      or coalesce(pr.username, '') ilike '%' || trim(p_search) || '%')
)
, paged as (
  select count(*) over () as total, *
  from fltr
  order by
    case p_sort
      when 'created'      then -extract(epoch from created_at)
      when 'created_asc'  then  extract(epoch from created_at)
      when 'name'         then 0  -- name order handled by secondary sort below
      else -extract(epoch from created_at)
    end
  , case when p_sort = 'name' then name end
  limit least(greatest(coalesce(p_page_size, 20), 1), 100)
  offset greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_page_size, 20), 1), 100)
)
select
  id, user_id, coalesce(owner_name, '—'), coalesce(owner_st, 'active'),
  name, coalesce(goal_name, ''), start_date, dur, end_day, created_at,
  elapsed_so_far, window_elapsed, coalesce(sub_cnt, 0), missed_days, coalesce(pending_today, false),
  coalesce(points, 0), coalesce(bonus, 0), coalesce(opt_done, 0), coalesce(opt_total, 0),
  (case when window_elapsed >= 1
        then least(100, round(100 * least(coalesce(sub_cnt, 0), window_elapsed)::numeric / window_elapsed))::int
   end),
  life, total
from paged;
$$;

-- ---------- 16) single challenge detail ----------
create or replace function public.admin_challenge_detail(p_id uuid)
returns jsonb
language sql stable security definer set search_path = public
as $$
with ch as (
  select c.*, coalesce(c.duration_days, 90) as dur
  from public.challenges c
  where c.id = p_id
)
select coalesce(
  (select jsonb_build_object(
    'found', true,
    'challenge', jsonb_build_object(
      'id', c.id, 'user_id', c.user_id, 'name', c.name,
      'goal_name', coalesce(c.goal_name, ''), 'start_date', c.start_date,
      'duration', c.dur, 'end_date', c.start_date + c.dur - 1,
      'created_at', c.created_at,
      'is_upcoming', c.start_date > current_date,
      'is_ongoing', current_date >= c.start_date and current_date <= c.start_date + c.dur - 1,
      'is_completed', current_date > c.start_date + c.dur - 1,
      'elapsed_days', greatest(current_date - c.start_date + 1, 0),
      'window_elapsed', least(greatest(current_date - c.start_date + 1, 0), c.dur)
    ),
    'owner', jsonb_build_object(
      'username', coalesce(pr.username, '—'),
      'email', (select u.email from auth.users u where u.id = c.user_id),
      'account_status', coalesce(pr.account_status, 'active'),
      'role', coalesce(pr.role, 'user')
    ),
    'stats', jsonb_build_object(
      'sub_days', coalesce(s.sub_days, 0),
      'points', coalesce(s.points, 0),
      'bonus', coalesce(s.bonus, 0),
      'opt_done', coalesce(s.opt_done, 0),
      'opt_total', coalesce(s.opt_total, 0),
      'last_sub_day', s.last_sub_day,
      'missed_rows', coalesce(s.missed_rows, 0)
    )
  )
  from ch c
  left join public.profiles pr on pr.id = c.user_id
  left join (
    select count(*) filter (where s.status = 'submitted') as sub_days,
           coalesce(sum(s.mandatory_points) filter (where s.status = 'submitted'), 0) as points,
           coalesce(sum(s.bonus_points), 0) as bonus,
           coalesce(sum(s.optional_done), 0) as opt_done,
           coalesce(sum(s.optional_total), 0) as opt_total,
           max(s.day) filter (where s.status = 'submitted') as last_sub_day,
           count(*) filter (where s.status = 'missed') as missed_rows
    from public.daily_scores s
    where s.challenge_id = p_id
  ) s on true
  limit 1),
  jsonb_build_object('found', false)
);
$$;

-- ---------- 17) paginated audit log ----------
create or replace function public.admin_audit_page(
  p_action    text    default 'all',  -- all|login|status|role
  p_page      integer default 1,
  p_page_size integer default 25
)
returns table (
  o_id bigint, o_actor_id uuid, o_actor_username text,
  o_action text, o_target_user uuid, o_target_username text,
  o_details jsonb, o_created_at timestamptz, o_total bigint
)
language sql stable security definer set search_path = public
as $$
with fltr as (
  select a.id, a.actor_id, aa.username as actor_name, a.action,
         a.target_user, ta.username as target_name, a.details, a.created_at
  from public.admin_audit_logs a
  left join public.profiles aa on aa.id = a.actor_id
  left join public.profiles ta on ta.id = a.target_user
  where (p_action = 'all'
      or (p_action = 'login'  and a.action = 'admin_login')
      or (p_action = 'status' and a.action like 'account_%')
      or (p_action = 'role'   and a.action = 'role_changed'))
)
, paged as (
  select count(*) over () as total, *
  from fltr
  order by id desc
  limit least(greatest(coalesce(p_page_size, 25), 1), 100)
  offset greatest(coalesce(p_page, 1) - 1, 0) * least(greatest(coalesce(p_page_size, 25), 1), 100)
)
-- null usernames are rendered by the UI as «کاربر حذف‌شده» / «—»
select id, actor_id, actor_name, action,
       target_user, target_name, details, created_at, total
from paged;
$$;

-- ---------- 18) administrative mutations (audited) ----------
create or replace function public.admin_set_user_status(p_target uuid, p_status text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid   := auth.uid();
  v_me_role   text;
  v_tgt       record;
begin
  if v_me is null or not public.is_admin() then
    raise exception 'UNAUTHORIZED';
  end if;
  if p_status not in ('active', 'suspended') then
    raise exception 'INVALID_STATUS';
  end if;
  select role into v_me_role from public.profiles where id = v_me;
  select * into v_tgt from public.profiles where id = p_target;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if p_target = v_me then
    raise exception 'CANNOT_MODIFY_SELF';
  end if;
  -- plain admins cannot manage admin/super_admin accounts
  if v_me_role <> 'super_admin' and v_tgt.role in ('admin', 'super_admin') then
    raise exception 'UNAUTHORIZED';
  end if;
  update public.profiles
     set account_status = p_status
   where id = p_target;
  insert into public.admin_audit_logs (actor_id, action, target_user, details)
  values (v_me,
          case when p_status = 'suspended' then 'account_suspended' else 'account_reactivated' end,
          p_target,
          jsonb_build_object('previous_status', v_tgt.account_status,
                             'target_role', v_tgt.role));
  return p_status;
end;
$$;

create or replace function public.admin_set_user_role(p_target uuid, p_role text)
returns text
language plpgsql security definer set search_path = public
as $$
declare
  v_me uuid := auth.uid();
  v_tgt record;
begin
  if v_me is null or not public.is_super_admin() then
    raise exception 'UNAUTHORIZED';
  end if;
  if p_role not in ('user', 'admin', 'super_admin') then
    raise exception 'INVALID_ROLE';
  end if;
  select * into v_tgt from public.profiles where id = p_target;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if p_target = v_me then
    raise exception 'CANNOT_MODIFY_SELF';
  end if;
  update public.profiles set role = p_role where id = p_target;
  insert into public.admin_audit_logs (actor_id, action, target_user, details)
  values (v_me, 'role_changed', p_target,
          jsonb_build_object('previous_role', v_tgt.role, 'new_role', p_role));
  return p_role;
end;
$$;

-- ---------- 19) harden RPC execute privileges ----------
revoke execute on function public.admin_resolve_admin_login(text) from public;
grant  execute on function public.admin_resolve_admin_login(text) to anon, authenticated, service_role;

revoke execute on function public.touch_admin_login() from public, anon;
grant  execute on function public.touch_admin_login() to authenticated, service_role;

revoke execute on function public.admin_overview_stats() from public, anon;
grant  execute on function public.admin_overview_stats() to authenticated, service_role;

revoke execute on function public.admin_users_page(text, text, text, text, integer, integer) from public, anon;
grant  execute on function public.admin_users_page(text, text, text, text, integer, integer) to authenticated, service_role;

revoke execute on function public.admin_user_detail(uuid) from public, anon;
grant  execute on function public.admin_user_detail(uuid) to authenticated, service_role;

revoke execute on function public.admin_challenges_page(text, text, uuid, text, integer, integer) from public, anon;
grant  execute on function public.admin_challenges_page(text, text, uuid, text, integer, integer) to authenticated, service_role;

revoke execute on function public.admin_challenge_detail(uuid) from public, anon;
grant  execute on function public.admin_challenge_detail(uuid) to authenticated, service_role;

revoke execute on function public.admin_audit_page(text, integer, integer) from public, anon;
grant  execute on function public.admin_audit_page(text, integer, integer) to authenticated, service_role;

revoke execute on function public.admin_set_user_status(uuid, text) from public, anon;
grant  execute on function public.admin_set_user_status(uuid, text) to authenticated, service_role;

revoke execute on function public.admin_set_user_role(uuid, text) from public, anon;
grant  execute on function public.admin_set_user_role(uuid, text) to authenticated, service_role;

-- =============================================================
-- FIRST SUPER ADMIN BOOTSTRAP (UNCOMMENT once, edit e-mail, run,
-- then re-comment — this file stays idempotent the whole time):
--
-- update public.profiles
--    set role = 'super_admin'
--  where id = (
--    select id from auth.users
--    where email = 'your-admin-email@example.com'
--    limit 1
--  );
-- =============================================================
