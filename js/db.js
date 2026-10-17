// ============================================================
// Data-access layer over Supabase (PostgreSQL + Auth).
// Every query runs as the signed-in user with the anon key;
// Row Level Security guarantees users only touch their own rows.
// ============================================================
import { getClient } from "./sb.js";
import { grade, enumerateDays, todayStr, effectiveTasks, dailyResult } from "./scoring.js";

function sb() {
  const c = getClient();
  if (!c) throw new Error("اتصال به Supabase پیکربندی نشده است.");
  return c;
}

// ---------- error translation ----------
export function faError(e, fallback = "خطایی رخ داد. دوباره تلاش کنید.") {
  const m = String(e?.message || e || "");
  if (/invalid login credentials/i.test(m)) return "ایمیل یا رمز عبور اشتباه است.";
  if (/user already registered|already exists/i.test(m)) return "این ایمیل قبلاً ثبت شده است. وارد شوید.";
  if (/password.*weak|password should be/i.test(m)) return "رمز عبور باید حداقل ۶ کاراکتر باشد.";
  if (/email.*confirm/i.test(m)) return "لطفاً ابتدا ایمیل خود را تأیید کنید.";
  if (/duplicate key.*username/i.test(m)) return "این نام کاربری گرفته شده است.";
  if (/invalid.*email/i.test(m)) return "ایمیل معتبر نیست.";
  if (/rate limit|too many/i.test(m)) return "درخواست‌ها زیاد است. کمی بعد تلاش کنید.";
  if (/Failed to fetch|NetworkError|network/i.test(m)) return "مشکل اتصال به اینترنت یا آدرس سرور.";
  if (/relation .* does not exist/i.test(m)) return "جدول‌های دیتابیس ساخته نشده‌اند. فایل supabase/schema.sql را اجرا کنید.";
  if (/JWT|jwt|not authenticated|auth/i.test(m)) return "نشست شما منقضی شده است. دوباره وارد شوید.";
  return e?.message ? `${fallback} (${m})` : fallback;
}

// ---------- auth ----------
export async function signUp(email, password, username) {
  const { data, error } = await sb().auth.signUp({
    email: email.trim(),
    password,
    options: { data: { username: username.trim() } },
  });
  if (error) throw error;
  return { user: data.user, session: data.session, needsConfirmation: !data.session };
}

export async function signIn(email, password) {
  const { data, error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw error;
  return data;
}

export async function signOut() {
  const { error } = await sb().auth.signOut();
  if (error) throw error;
}

export async function getSessionUser() {
  const { data } = await sb().auth.getSession();
  return data.session?.user || null;
}

export function onAuthChange(cb) {
  return sb().onAuthChange
    ? sb().auth.onAuthStateChange((_ev, session) => cb(session?.user || null))
    : { data: { subscription: { unsubscribe() {} } } };
}

// Ensure a profiles row exists (trigger usually creates it; fallback here).
export async function ensureProfile(user, fallbackName) {
  const c = sb();
  // Admin-panel columns (account_status/role) may not exist if the
  // optional admin schema was not applied — degrade gracefully.
  let { data, error } = await c.from("profiles")
    .select("id, username, account_status, role")
    .eq("id", user.id).maybeSingle();
  if (error && /column|schema cache/i.test(String(error.message))) {
    const retry = await c.from("profiles").select("id, username").eq("id", user.id).maybeSingle();
    data = retry.data; error = retry.error;
    if (data) data = { ...data, account_status: "active", role: "user" };
  }
  if (error) throw error;
  if (data) return data;
  const base = (user.user_metadata?.username || fallbackName || String(user.email).split("@")[0] || "کاربر").trim().slice(0, 30);
  let username = base, profile = null, lastErr = null;
  for (let i = 0; i < 5; i++) {
    const { data: ins, error: insErr } = await c.from("profiles").insert({ id: user.id, username }).select().single();
    if (!insErr) { profile = ins; break; }
    lastErr = insErr;
    if (!/duplicate|already|unique/i.test(String(insErr.message))) throw insErr;
    username = `${base}${Math.floor(100 + Math.random() * 900)}`;
  }
  if (!profile) throw lastErr || new Error("ساخت پروفایل ناموفق بود.");
  return { ...profile, account_status: profile.account_status || "active", role: profile.role || "user" };
}

// Heartbeat for admin activity views (login + periodic app loads).
// Silently ignored when the optional admin schema is not applied.
export async function touchActivity(login = false) {
  try { await sb().rpc("touch_activity", { p_login: login }); return true; }
  catch { return false; }
}

// ---------- challenges ----------
export async function listChallenges() {
  const { data, error } = await sb().from("challenges").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  return data;
}
export async function createChallenge(name, startDate, goalName) {
  const user = (await sb().auth.getUser()).data.user;
  const { data, error } = await sb().from("challenges")
    .insert({ user_id: user.id, name, start_date: startDate, goal_name: goalName || "" })
    .select().single();
  if (error) throw error;
  return data;
}
export async function updateChallenge(id, patch) {
  const { data, error } = await sb().from("challenges").update(patch).eq("id", id).select().single();
  if (error) throw error;
  return data;
}
export async function deleteChallenge(id) {
  const { error } = await sb().from("challenges").delete().eq("id", id);
  if (error) throw error;
}

// ---------- custom (optional) tasks ----------
// Task descriptions require migration-002. If the column does not exist
// yet in the user's database, we fall back to title-only writes so the
// app keeps working; the UI then hides description fields for the session.
let taskDescSupported = true;
export function taskDescriptionSupported() { return taskDescSupported; }
function isMissingColumnError(e) {
  const m = String(e?.message || e || "");
  return /description/i.test(m) && /column|schema cache|could not find/i.test(m);
}
export async function listTasks(challengeId) {
  const { data, error } = await sb().from("custom_tasks").select("*").eq("challenge_id", challengeId).order("created_at");
  if (error) throw error;
  return data;
}
export async function addTask(challengeId, title, description = "") {
  description = String(description || "").slice(0, 200);
  if (taskDescSupported) {
    const { data, error } = await sb().from("custom_tasks")
      .insert({ challenge_id: challengeId, title, description }).select().single();
    if (!error) return data;
    if (!isMissingColumnError(error)) throw error;
    taskDescSupported = false;
  }
  const { data, error } = await sb().from("custom_tasks")
    .insert({ challenge_id: challengeId, title }).select().single();
  if (error) throw error;
  return data;
}
export async function updateTask(id, patch) {
  const clean = {};
  if (patch.title !== undefined) clean.title = String(patch.title).slice(0, 120);
  if (patch.description !== undefined && taskDescSupported) clean.description = String(patch.description || "").slice(0, 200);
  if (taskDescSupported && patch.description !== undefined) {
    const { data, error } = await sb().from("custom_tasks").update(clean).eq("id", id).select().single();
    if (!error) return data;
    if (!isMissingColumnError(error)) throw error;
    taskDescSupported = false;
    delete clean.description;
  }
  const { data, error } = await sb().from("custom_tasks").update(clean).eq("id", id).select().single();
  if (error) throw error;
  return data;
}
export async function renameTask(id, title) {
  return updateTask(id, { title });
}
export async function deleteTask(id) {
  const { error } = await sb().from("custom_tasks").delete().eq("id", id);
  if (error) throw error;
}

// ---------- submissions ----------
export function toEntry(row) {
  if (!row) return null;
  return {
    reading_pages: row.reading_pages || 0,
    exercise_minutes: row.exercise_minutes || 0,
    goal_minutes: row.goal_minutes || 0,
    wake_time: row.wake_time || "",
    no_alcohol: !!row.no_alcohol,
    no_smoke: !!row.no_smoke,
    custom_states: row.custom_states || {},
    notes: row.notes || "",
  };
}
export async function listSubmissions(challengeId) {
  const { data, error } = await sb().from("daily_submissions").select("*").eq("challenge_id", challengeId);
  if (error) throw error;
  const map = {};
  for (const r of data) map[r.day] = toEntry(r);
  return map;
}
export async function upsertSubmission(challengeId, day, entry) {
  const payload = {
    challenge_id: challengeId,
    day,
    reading_pages: Math.max(0, Math.floor(Number(entry.reading_pages) || 0)),
    exercise_minutes: Math.max(0, Math.floor(Number(entry.exercise_minutes) || 0)),
    goal_minutes: Math.max(0, Math.floor(Number(entry.goal_minutes) || 0)),
    wake_time: entry.wake_time || null,
    no_alcohol: !!entry.no_alcohol,
    no_smoke: !!entry.no_smoke,
    custom_states: entry.custom_states || {},
    notes: String(entry.notes || "").slice(0, 500),
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await sb().from("daily_submissions")
    .upsert(payload, { onConflict: "challenge_id,day" }).select().single();
  if (error) throw error;
  return data;
}
export async function deleteSubmission(challengeId, day) {
  const { error } = await sb().from("daily_submissions").delete().eq("challenge_id", challengeId).eq("day", day);
  if (error) throw error;
  // The score row for that day becomes a missed record (recomputed lazily).
  await sb().from("daily_scores").delete().eq("challenge_id", challengeId).eq("day", day);
}

// ---------- scoring records ----------
export function scoreRow(challengeId, day, entry, tasks) {
  const r = dailyResult(entry, effectiveTasks(tasks, day));
  return {
    challenge_id: challengeId,
    day,
    status: "submitted",
    mandatory_points: r.points,
    mandatory_pct: r.pct,
    bonus_points: r.bonus,
    optional_done: r.optDone,
    optional_total: r.optTotal,
    grade: grade(r.pct),
    computed_at: new Date().toISOString(),
  };
}
export async function saveScoreRow(row) {
  const { error } = await sb().from("daily_scores").upsert(row, { onConflict: "challenge_id,day" });
  if (error) throw error;
}
export async function listScores(challengeId) {
  const { data, error } = await sb().from("daily_scores").select("*").eq("challenge_id", challengeId).order("day");
  if (error) throw error;
  return data;
}
// Persist "missed" score rows for days that passed without a submission.
// Idempotent: re-running only refreshes the same rows.
export async function ensureMissedRecords(challenge, submissions, tasks) {
  const t = todayStr();
  if (challenge.start_date > t) return 0;
  const days = enumerateDays(challenge.start_date, t).filter((d) => d !== t && !submissions[d]);
  if (!days.length) return 0;
  const rows = days.map((d) => {
    const eff = effectiveTasks(tasks, d);
    return {
      challenge_id: challenge.id,
      day: d,
      status: "missed",
      mandatory_points: 0,
      mandatory_pct: 0,
      bonus_points: 0,
      optional_done: 0,
      optional_total: eff.length,
      grade: grade(0),
      computed_at: new Date().toISOString(),
    };
  });
  const { error } = await sb().from("daily_scores").upsert(rows, { onConflict: "challenge_id,day" });
  if (error) throw error;
  return rows.length;
}

// ---------- schedule ----------
export async function listSchedule(day) {
  const { data, error } = await sb().from("schedule_items").select("*").eq("day", day).order("time");
  if (error) throw error;
  return data;
}
export async function addSchedule(day, time, title) {
  const user = (await sb().auth.getUser()).data.user;
  const { data, error } = await sb().from("schedule_items")
    .insert({ user_id: user.id, day, time, title }).select().single();
  if (error) throw error;
  return data;
}
export async function toggleSchedule(id, done) {
  const { error } = await sb().from("schedule_items").update({ done }).eq("id", id);
  if (error) throw error;
}
export async function deleteSchedule(id) {
  const { error } = await sb().from("schedule_items").delete().eq("id", id);
  if (error) throw error;
}

// ---------- connectivity check (setup screen) ----------
export async function testConnection() {
  const { error } = await sb().from("mandatory_rules").select("key").limit(1);
  if (error) throw error;
  return true;
}
