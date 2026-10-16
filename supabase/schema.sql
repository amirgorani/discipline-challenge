-- =============================================================
-- Daily Discipline Planner — Supabase PostgreSQL schema (v3)
-- Run this file once in: Supabase Dashboard → SQL Editor → New query
--
-- Creates: profiles, challenges, mandatory_rules (seed),
--          custom_tasks, daily_submissions, daily_scores,
--          schedule_items + Row Level Security + signup trigger.
--
-- SECURITY: the frontend uses ONLY the public anon key.
-- Never put the service_role key in frontend code.
-- =============================================================

-- ---------- 1) profiles (one row per auth user) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null unique,
  created_at timestamptz not null default now()
);

-- ---------- 2) challenges ----------
create table if not exists public.challenges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  start_date date not null,
  goal_name text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists challenges_user_idx on public.challenges (user_id);

-- ---------- 3) mandatory_rules (fixed reference data, read-only) ----------
create table if not exists public.mandatory_rules (
  key text primary key,
  title text not null,
  description text not null,
  target_text text not null,
  weight numeric not null default 10
);
insert into public.mandatory_rules (key, title, description, target_text, weight) values
  ('reading',   'مطالعه روزانه',   'خواندن حداقل ۱۰ صفحه کتاب در روز',        '≥ ۱۰ صفحه',  10),
  ('exercise',  'ورزش روزانه',     'حداقل ۶۰ دقیقه ورزش در روز',               '≥ ۶۰ دقیقه',  10),
  ('goal',      'پیشرفت هدف',      'حداقل ۶۰ دقیقه کار روی هدف شخصی',          '≥ ۶۰ دقیقه',  10),
  ('wake',      'بیداری زودهنگام', 'بیدار شدن قبل از ساعت ۹:۰۰ صبح',           'قبل از ۹:۰۰', 10),
  ('noAlcohol', 'عدم مصرف الکل',   'عدم مصرف نوشیدنی‌های الکلی',               'رعایت روزانه', 10),
  ('noSmoke',   'دوری از دود',     'دوری از دود و محیط‌های سیگاری',             'رعایت روزانه', 10)
on conflict (key) do update set
  title = excluded.title,
  description = excluded.description,
  target_text = excluded.target_text,
  weight = excluded.weight;

-- ---------- 4) custom_tasks (optional tasks per challenge) ----------
create table if not exists public.custom_tasks (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  title text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists custom_tasks_challenge_idx on public.custom_tasks (challenge_id);

-- ---------- 5) daily_submissions (one row per challenge per day) ----------
create table if not exists public.daily_submissions (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  day date not null,
  reading_pages integer not null default 0 check (reading_pages >= 0),
  exercise_minutes integer not null default 0 check (exercise_minutes >= 0),
  goal_minutes integer not null default 0 check (goal_minutes >= 0),
  wake_time text,
  no_alcohol boolean not null default false,
  no_smoke boolean not null default false,
  custom_states jsonb not null default '{}'::jsonb,
  notes text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (challenge_id, day)
);
create index if not exists submissions_challenge_day_idx on public.daily_submissions (challenge_id, day);

-- ---------- 6) daily_scores (permanent scoring records) ----------
create table if not exists public.daily_scores (
  id uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  day date not null,
  status text not null check (status in ('submitted', 'missed')),
  mandatory_points numeric not null default 0,
  mandatory_pct integer not null default 0,
  bonus_points integer not null default 0,
  optional_done integer not null default 0,
  optional_total integer not null default 0,
  grade text not null default '',
  computed_at timestamptz not null default now(),
  unique (challenge_id, day)
);
create index if not exists scores_challenge_day_idx on public.daily_scores (challenge_id, day);

-- ---------- 7) schedule_items (personal timetable per user) ----------
create table if not exists public.schedule_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  time text not null default '08:00',
  title text not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists schedule_user_day_idx on public.schedule_items (user_id, day);

-- =============================================================
-- Row Level Security — every user sees ONLY their own rows.
-- =============================================================
alter table public.profiles enable row level security;
alter table public.challenges enable row level security;
alter table public.mandatory_rules enable row level security;
alter table public.custom_tasks enable row level security;
alter table public.daily_submissions enable row level security;
alter table public.daily_scores enable row level security;
alter table public.schedule_items enable row level security;

-- profiles: a user can read/insert/update ONLY their own profile
drop policy if exists "own profile select" on public.profiles;
create policy "own profile select" on public.profiles
  for select using (auth.uid() = id);
drop policy if exists "own profile insert" on public.profiles;
create policy "own profile insert" on public.profiles
  for insert with check (auth.uid() = id);
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- challenges: full access to own rows only
drop policy if exists "own challenges" on public.challenges;
create policy "own challenges" on public.challenges
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- mandatory_rules: readable by everyone (anon + authenticated), writable by nobody via API
drop policy if exists "public read rules" on public.mandatory_rules;
create policy "public read rules" on public.mandatory_rules
  for select using (true);

-- custom_tasks: only through a challenge owned by the caller
drop policy if exists "own challenge tasks" on public.custom_tasks;
create policy "own challenge tasks" on public.custom_tasks
  for all
  using (exists (
    select 1 from public.challenges c
    where c.id = custom_tasks.challenge_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.challenges c
    where c.id = custom_tasks.challenge_id and c.user_id = auth.uid()
  ));

-- daily_submissions: only through a challenge owned by the caller
drop policy if exists "own challenge submissions" on public.daily_submissions;
create policy "own challenge submissions" on public.daily_submissions
  for all
  using (exists (
    select 1 from public.challenges c
    where c.id = daily_submissions.challenge_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.challenges c
    where c.id = daily_submissions.challenge_id and c.user_id = auth.uid()
  ));

-- daily_scores: only through a challenge owned by the caller
drop policy if exists "own challenge scores" on public.daily_scores;
create policy "own challenge scores" on public.daily_scores
  for all
  using (exists (
    select 1 from public.challenges c
    where c.id = daily_scores.challenge_id and c.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.challenges c
    where c.id = daily_scores.challenge_id and c.user_id = auth.uid()
  ));

-- schedule_items: full access to own rows only
drop policy if exists "own schedule" on public.schedule_items;
create policy "own schedule" on public.schedule_items
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- =============================================================
-- Auto-create a profile row on signup (runs with definer rights,
-- so it works regardless of RLS). The app also ensures the
-- profile client-side as a fallback.
-- =============================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data ->> 'username', ''), split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
