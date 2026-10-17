// ============================================================
// Admin data-access layer over Supabase.
// All privileged READS flow through RLS policies calling
// is_admin() on the database; privileged WRITES go through
// audited security-definer RPCs. The client only ever uses the
// public anon key — authorization is never decided here.
// ============================================================
import { getClient } from "../sb.js";
import { faError } from "../db.js";

export { faError };

function sb() {
  const c = getClient();
  if (!c) throw new Error("اتصال به Supabase پیکربندی نشده است.");
  return c;
}

// Detection helper: admin schema (admin-schema.sql) not applied.
export function isMissingAdminSchema(e) {
  const m = String(e?.message || e || "");
  return /admin_|touch_activity|could not find|does not exist|schema cache/i.test(m)
    && !/invalid login|email|password|JWT/i.test(m);
}

// ---------- own profile (with graceful fallback for old schema) ----------
export async function adminProfile(userId) {
  const c = sb();
  let { data, error } = await c
    .from("profiles")
    .select("id, username, role, account_status, last_login_at, last_activity_at, last_submission_at")
    .eq("id", userId)
    .maybeSingle();
  if (error && /column|schema cache/i.test(String(error.message))) {
    const { data: d2, error: e2 } = await c
      .from("profiles").select("id, username").eq("id", userId).maybeSingle();
    if (e2) throw e2;
    if (!d2) return null;
    return { ...d2, role: "user", account_status: "active" };
  }
  if (error) throw error;
  return data; // null when the profile row does not exist
}

// ---------- admin login helpers ----------
export async function resolveAdminLogin(usernameOrEmail) {
  const name = String(usernameOrEmail || "").trim();
  if (!name) throw new Error("نام کاربری خالی است.");
  if (name.includes("@")) return name; // e-mail path → direct sign-in
  const { data, error } = await sb().rpc("admin_resolve_admin_login", { p_name: name });
  if (error) {
    if (/INVALID_INPUT/i.test(String(error.message))) throw new Error("نام کاربری معتبر نیست.");
    throw error;
  }
  return data || null; // null → not an admin username
}

export async function touchAdminLogin() {
  try { await sb().rpc("touch_admin_login"); return true; } catch { return false; }
}
export async function touchActivity(login = false) {
  try { await sb().rpc("touch_activity", { p_login: login }); return true; } catch { return false; }
}

// ---------- overview dashboard ----------
let overviewCache = { at: 0, data: null };
export function invalidateOverview() { overviewCache = { at: 0, data: null }; }
export async function overviewStats(maxAgeMs = 0) {
  const age = Date.now() - overviewCache.at;
  if (overviewCache.data && maxAgeMs > 0 && age < maxAgeMs) return overviewCache.data;
  const { data, error } = await sb().rpc("admin_overview_stats");
  if (error) throw error;
  overviewCache = { at: Date.now(), data };
  return data;
}

// ---------- users ----------
export async function usersPage({ search = "", status = "all", activity = "all", sort = "created", page = 1, size = 20 } = {}) {
  const { data, error } = await sb().rpc("admin_users_page", {
    p_search: search, p_status: status, p_activity: activity,
    p_sort: sort, p_page: page, p_page_size: size,
  });
  if (error) throw error;
  const rows = data || [];
  const total = rows.length ? Number(rows[0].o_total) : 0;
  return { rows, total };
}

export async function userDetail(userId) {
  const { data, error } = await sb().rpc("admin_user_detail", { p_user: userId });
  if (error) throw error;
  if (!data?.found) throw new Error("کاربر پیدا نشد.");
  return data;
}

// ---------- challenges ----------
export async function challengesPage({ search = "", status = "all", owner = null, sort = "created", page = 1, size = 20 } = {}) {
  const { data, error } = await sb().rpc("admin_challenges_page", {
    p_search: search, p_status: status, p_owner: owner,
    p_sort: sort, p_page: page, p_page_size: size,
  });
  if (error) throw error;
  const rows = data || [];
  const total = rows.length ? Number(rows[0].o_total) : 0;
  return { rows, total };
}

export async function challengeDetail(challengeId) {
  const { data, error } = await sb().rpc("admin_challenge_detail", { p_id: challengeId });
  if (error) throw error;
  if (!data?.found) throw new Error("چالش پیدا نشد.");
  return data;
}

// ---------- per-challenge raw history (bounded by challenge id) ----------
export async function listChallengeSubmissions(challengeId) {
  const { data, error } = await sb().from("daily_submissions")
    .select("*").eq("challenge_id", challengeId).order("day", { ascending: true });
  if (error) throw error;
  return data || [];
}
export async function listChallengeScores(challengeId) {
  const { data, error } = await sb().from("daily_scores")
    .select("*").eq("challenge_id", challengeId).order("day", { ascending: true });
  if (error) throw error;
  return data || [];
}
export async function listChallengeTasks(challengeId) {
  const [t, h] = await Promise.all([
    sb().from("custom_tasks").select("*").eq("challenge_id", challengeId).order("created_at"),
    sb().from("custom_task_history").select("*").eq("challenge_id", challengeId).order("archived_at"),
  ]);
  if (t.error) {
    // old schema without the history table → degrade gracefully
    const { data, error } = await sb().from("custom_tasks").select("*").eq("challenge_id", challengeId).order("created_at");
    if (error) throw error;
    return { tasks: data || [], history: [] };
  }
  return { tasks: t.data || [], history: h.data || [] };
}

// ---------- per-user analytics data (bounded per user) ----------
export async function listUserChallengeIds(userId) {
  const { data, error } = await sb().from("challenges")
    .select("id, name, start_date, duration_days, goal_name, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}
export async function listUserScores(challengeIds, limit = 4000) {
  if (!challengeIds.length) return [];
  const { data, error } = await sb().from("daily_scores")
    .select("challenge_id, day, status, mandatory_points, mandatory_pct, bonus_points, optional_done, optional_total")
    .in("challenge_id", challengeIds)
    .order("day", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse();
}
export async function listUserSubmissions(challengeIds, limit = 2500) {
  if (!challengeIds.length) return [];
  const { data, error } = await sb().from("daily_submissions")
    .select("challenge_id, day, reading_pages, exercise_minutes, goal_minutes, wake_time, no_alcohol, no_smoke, custom_states, notes")
    .in("challenge_id", challengeIds)
    .order("day", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).reverse();
}

// ---------- audit log ----------
export async function auditPage({ action = "all", page = 1, size = 25 } = {}) {
  const { data, error } = await sb().rpc("admin_audit_page", { p_action: action, p_page: page, p_page_size: size });
  if (error) throw error;
  const rows = data || [];
  const total = rows.length ? Number(rows[0].o_total) : 0;
  return { rows, total };
}

// ---------- administrative mutations ----------
export async function setUserStatus(userId, status) {
  const { data, error } = await sb().rpc("admin_set_user_status", { p_target: userId, p_status: status });
  if (error) throw error;
  return data;
}
export async function setUserRole(userId, role) {
  const { data, error } = await sb().rpc("admin_set_user_role", { p_target: userId, p_role: role });
  if (error) throw error;
  return data;
}
