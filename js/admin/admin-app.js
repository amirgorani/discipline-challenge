// ============================================================
// Admin app shell: authorization gate, login, hash-router.
// Security model: the DB (RLS + RPCs) decides access; this file
// only shapes the user experience accordingly.
// ============================================================
import { getSupabaseConfig } from "../config.js";
import { getClient, resetClient } from "../sb.js";
import { signIn, signOut, getSessionUser, faError } from "../db.js";
import { adminProfile, resolveAdminLogin, touchAdminLogin, invalidateOverview } from "./admin-db.js";
import {
  setMe, viewOverview, viewUsers, viewUserDetail, viewChallengeDetail,
  viewActive, viewAnalytics, viewLogs, viewSettings,
} from "./admin-views.js";
import { avatarLetter, busy, toast, rolePill } from "./admin-ui.js";

const $ = (id) => document.getElementById(id);

/* ---------------- view helpers ---------------- */
function show(id) {
  ["admLogin", "admDenied", "admSetup", "admApp"].forEach((v) => $(v).classList.add("hidden"));
  if (id) $(id).classList.remove("hidden");
}
function setupScreen(title, bodyHtml) {
  $("admSetupTitle").textContent = title;
  $("admSetupBody").innerHTML = bodyHtml;
  show("admSetup");
}

/* ---------------- routing ---------------- */
const TITLES = {
  overview: "نمای کلی",
  users: "مدیریت کاربران",
  user: "پرونده کاربر",
  ch: "جزئیات چالش",
  active: "کاربران فعال",
  analytics: "تحلیل عملکرد",
  logs: "گزارش فعالیت‌ها",
  settings: "تنظیمات مدیریت",
};
const NAV_ROOTS = { overview: "overview", users: "users", user: "users", ch: "users", active: "active", analytics: "analytics", logs: "logs", settings: "settings" };

function parseHash() {
  const raw = (location.hash || "").replace(/^#\/?/, "");
  if (!raw) return null;
  const [name, ...args] = raw.split("/");
  return { name: TITLES[name] ? name : "overview", args };
}
function markNav(root) {
  document.querySelectorAll(".adm-nav-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.route === root);
  });
}
function closeSidebar() {
  $("admSidebar").classList.remove("open");
  $("admBackdrop").classList.remove("show");
}
async function route() {
  const parsed = parseHash();
  if (!parsed) { location.hash = "#/overview"; return; }
  const { name, args } = parsed;
  $("admTitle").textContent = TITLES[name] || "";
  markNav(NAV_ROOTS[name] || "overview");
  closeSidebar();
  const ctx = { host: $("admContent") };
  try {
    if (name === "overview") await viewOverview(ctx);
    else if (name === "users") await viewUsers(ctx);
    else if (name === "user") {
      if (!args[0]) { location.hash = "#/users"; return; }
      await viewUserDetail(ctx, args[0]);
    } else if (name === "ch") {
      if (!args[0]) { location.hash = "#/challenges"; return; }
      await viewChallengeDetail(ctx, args[0]);
    } else if (name === "active") await viewActive(ctx);
    else if (name === "analytics") await viewAnalytics(ctx, args[0] || null);
    else if (name === "logs") await viewLogs(ctx);
    else if (name === "settings") await viewSettings(ctx);
  } catch (e) {
    $("admContent").innerHTML = `<div class="adm-error"><strong>⚠️ ${String(faError(e))}</strong>
      <button class="btn btn-ghost small" onclick="location.reload()" type="button">بارگذاری دوباره</button></div>`;
  }
}
window.addEventListener("hashchange", route);

/* ---------------- session & access ---------------- */
async function deny(message) {
  $("admDeniedMsg").textContent = message || "شما اجازه دسترسی به پنل مدیریت را ندارید.";
  show("admDenied");
}
async function authorize(user, { silentFail = false } = {}) {
  let profile;
  try { profile = await adminProfile(user.id); }
  catch (e) {
    setupScreen("اتصال به پنل ناموفق بود",
      `<p>بررسی نقش حساب انجام نشد: ${String(faError(e))}</p><p>اتصال دیتابیس و اجرای فایل <code>supabase/admin-schema.sql</code> را بررسی کنید.</p>`);
    return false;
  }
  if (!profile) { await deny("حساب شما در دیتابیس برنامه تعریف نشده است."); return false; }
  if (profile.account_status === "suspended") { await deny("حساب مدیر شما معلق شده است. با مدیر ارشد تماس بگیرید."); return false; }
  if (profile.role !== "admin" && profile.role !== "super_admin") {
    if (silentFail) return false;
    await deny("این حساب نقش مدیریتی ندارد. ورود از صفحه کاربر: index.html");
    return false;
  }
  setMe(profile);
  $("admUserPill").innerHTML = `${avatarLetter(profile.username)} ${profile.username} ${rolePill(profile.role)}`;
  $("admSideUser").innerHTML = `<span class="av">${avatarLetter(profile.username)}</span>
    <div><strong>${profile.username}</strong><span>${profile.role === "super_admin" ? "مدیر ارشد" : "مدیر"}</span></div>`;
  show("admApp");
  await route();
  return true;
}

async function boot() {
  if (window.SUPABASE_CONFIG_MISSING || !getSupabaseConfig()) {
    setupScreen("اتصال دیتابیس تنظیم نشده",
      `<p>پنل مدیریت بدون اتصال به Supabase اجرا نمی‌شود. ابتدا در صفحه برنامه اصلی
      <a class="link" href="index.html">index.html</a> آدرس پروژه و کلید anon را در بخش «تغییر اتصال به Supabase» وارد کنید؛
      همان تنظیمات برای این پنل استفاده می‌شود (فقط کلید عمومی anon — کلید service_role هرگز لازم نیست).</p>`);
    return;
  }
  if (!getClient()) { setupScreen("اتصال دیتابیس تنظیم نشده", "<p>کلاینت Supabase ساخته نشد؛ مقادیر پیکربندی را بررسی کنید.</p>"); return; }
  try {
    const user = await getSessionUser();
    if (!user) { show("admLogin"); $("admLoginUser").focus(); return; }
    const ok = await authorize(user);
    if (ok) keepAlive();
  } catch (e) {
    setupScreen("خطا در راه‌اندازی", `<p>${String(faError(e, "راه‌اندازی ناموفق بود."))}</p>`);
  }
}

// periodic re-verify: suspended / de-roled admins are pushed out quickly
let aliveTimer = null;
function keepAlive() {
  clearInterval(aliveTimer);
  aliveTimer = setInterval(async () => {
    try {
      const user = await getSessionUser();
      if (!user) { clearInterval(aliveTimer); await signOut().catch(() => {}); show("admLogin"); return; }
      const p = await adminProfile(user.id);
      if (!p || p.role === "user" || p.account_status === "suspended") {
        clearInterval(aliveTimer);
        await signOut().catch(() => {});
        show("admLogin");
        toast("دسترسی مدیریتی شما به‌روزرسانی یا لغو شد. دوباره وارد شوید.", "error");
      }
    } catch { /* network hiccup — try next tick */ }
  }, 5 * 60_000);
}

/* ---------------- admin login ---------------- */
$("admLoginForm").addEventListener("submit", (ev) => {
  ev.preventDefault();
  busy($("admLoginBtn"), async () => {
    $("admLoginMsg").textContent = "";
    const name = $("admLoginUser").value.trim();
    const pass = $("admLoginPass").value;
    if (!name || !pass) { $("admLoginMsg").textContent = "نام کاربری/ایمیل و رمز عبور را وارد کنید."; return; }
    try {
      let email = name;
      if (!/@/.test(name)) {
        const resolved = await resolveAdminLogin(name);
        if (!resolved) {
          $("admLoginMsg").textContent = "نام کاربری مدیر پیدا نشد یا این حساب مجاز نیست.";
          return;
        }
        email = resolved;
      }
      await signIn(email, pass);
      const user = await getSessionUser();
      if (!user) throw new Error("نشست ساخته نشد. ایمیل خود را تأیید کنید.");
      const ok = await authorize(user);
      if (!ok) { await signOut().catch(() => {}); return; }
      touchAdminLogin(); // audit + last_login (non-fatal)
      $("admLoginUser").value = ""; $("admLoginPass").value = "";
    } catch (e) {
      $("admLoginMsg").textContent = faError(e, "ورود ناموفق بود.");
    }
  });
});
$("admDeniedLogout").addEventListener("click", async () => {
  await signOut().catch(() => {});
  show("admLogin");
});

/* ---------------- logout ---------------- */
async function logout() {
  await signOut().catch(() => {});
  resetClient();
  invalidateOverview();
  show("admLogin");
}
$("admLogoutTop").addEventListener("click", logout);
$("admLogoutSide").addEventListener("click", logout);

/* ---------------- shell controls ---------------- */
$("admRefreshBtn").addEventListener("click", async (e) => {
  await busy(e.currentTarget, async () => {
    invalidateOverview();
    await route();
  });
});
$("admSideToggle").addEventListener("click", () => {
  $("admSidebar").classList.toggle("open");
  $("admBackdrop").classList.toggle("show");
});
$("admBackdrop").addEventListener("click", closeSidebar);
document.querySelectorAll(".adm-nav-item").forEach((b) => b.addEventListener("click", () => {
  location.hash = `#/${b.dataset.route}`;
}));

/* ---------------- boot ---------------- */
// sync logout from other tabs
try {
  getClient()?.auth.onAuthStateChange((ev) => {
    if (ev === "SIGNED_OUT") { show("admLogin"); }
  });
} catch { /* ignore */ }
boot();
