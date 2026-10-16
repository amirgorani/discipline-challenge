-- =============================================================
-- Migration 002 — optional task descriptions
-- Run once in Supabase Dashboard → SQL Editor → New query
-- (only needed if you already ran schema.sql before this file
-- existed; fresh installs should include this column already)
-- =============================================================
alter table public.custom_tasks
  add column if not exists description text not null default '';
