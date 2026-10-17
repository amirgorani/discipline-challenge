// ============================================================
// Admin panel views — each view renders into #admContent.
// Reuses the scoring/date helpers from ../scoring.js so score
// definitions and history rules never get duplicated.
// Charts via admin-charts.js · data via admin-db.js.
// ============================================================
import {
  todayStr, addDays, parseDay, daysBetween,
  faNum, faDate, faShort, esc,
  RULES, MAX_MANDATORY, BONUS_PER_TASK, BONUS_CAP,
  rulePoints10, ruleMet, effectiveTasks, grade, dayStatus, fmt,
} from "../scoring.js";
import { faError, toEntry } from "../db.js";
import {
  statCard, accountPill, rolePill, lifePill, activityPill, actionLabel,
  setLoading, emptyState, errorState, confirmAction, toast,
  paginationBar, bindPager, dt, rel, pct, avatarLetter, labelDetails,
} from "./admin-ui.js";
import { lineChart, barChart, doughnutChart, colors, isAvailable } from "./admin-charts.js";
import {
  overviewStats, usersPage, userDetail, challengesPage, challengeDetail,
  listChallengeSubmissions, listChallengeScores, listChallengeTasks,
  listUserChallengeIds, listUserScores, listUserSubmissions,
  auditPage, setUserStatus, setUserRole, isMissingAdminSchema,
} from "./admin-db.js";

/* ============================================================
   In-session state (filters survive navigation)
   ============================================================ */
const V = {
  users: { q: "", status: "all", activity: "all", sort: "created", page: 1 },
  chal: { q: "", status: "all", sort: "created", page: 1 },
  active: { mode: "all" },
  analytics: { userId: null, challengeId: null },
  logs: { action: "all", page: 1 },
  day: {}, // per-challenge day-browsing state
};
let me = null; // current admin profile (set by the app shell)
export function setMe(profile) { me = profile; }
function isSuper() { return me?.role === "super_admin"; }
function canManage(u) {
  // plain admins manage regular users; super admins manage everyone else
  return u && u.o_id !== me?.id && (isSuper() || u.o_role === "user");
}

/* ============================================================
   shared renderers
   ============================================================ */
function renderError(host, e, rerender) {
  if (isMissingAdminSchema(e)) {
    host.innerHTML = `
      <div class="adm-card">
        <div class="adm-card-head"><h2>پنل مدیریت هنوز نصب نشده است</h2></div>
        <p class="small muted">ساختار پنل مدیریت در دیتابیس اجرا نشده است. در داشبورد Supabase وارد
        <strong>SQL Editor → New query</strong> شوید، محتوای کامل فایل <code>supabase/admin-schema.sql</code> را
        اجرا کنید و سپس این صفحه را دوباره باز کنید. (فایل <code>supabase/schema.sql</code> برنامه اصلی باید قبلاً اجرا شده باشد.)</p>
        <button class="btn btn-primary retry2" type="button">تلاش دوباره</button>
      </div>`;
    host.querySelector(".retry2").addEventListener("click", rerender);
    return;
  }
  host.innerHTML = errorState(faError(e, "دریافت داده از سرور ناموفق بود."));
  host.querySelector(".retry")?.addEventListener("click", rerender);
}
function crumbs(items) {
  return `<div class="crumbs">${items.map((i, idx) => {
    if (idx < items.length - 1 && i.href) return `<a class="link" href="#/${i.href}">${esc(i.label)}</a> ‹ `;
    return esc(i.label);
  }).join("")}</div>`;
}
function chartBox(id, height, headHtml = "") {
  return `<div class="chart-box" style="height:${height}px"><canvas id="${id}"></canvas></div>${headHtml ? "" : ""}`;
}

/* ============================================================
   1) OVERVIEW DASHBOARD
   ============================================================ */
export async function viewOverview({ host }) {
  setLoading(host);
  let ov;
  try { ov = await overviewStats(60_000); }
  catch (e) { renderError(host, e, () => viewOverview({ host })); return; }

  const u = ov.users ?? {}, c = ov.challenges ?? {}, s = ov.submissions ?? {};
  const trend = ov.trend_14d || [];
  const labels = trend.map((t) => faShort(t.day));
  const subData = trend.map((t) => t.submitted);
  const missData = trend.map((t) => t.missed);
  const signUpData = trend.map((t) => t.signups);

  const bands = [
    { l: "فعال امروز", v: (u.active_today || 0), cls: colors().green },
    { l: "۱ تا ۷ روز", v: (u.active_7d || 0) - (u.active_today || 0), cls: colors().blue },
    { l: "۸ تا ۱۴ روز", v: (u.active_14d || 0) - (u.active_7d || 0), cls: colors().blue2 },
    { l: "کم‌فعال (۱۵ تا ۶۰ روز)", v: (u.inactive_14d || 0) - (u.deep_inactive_60d || 0), cls: colors().amber },
    { l: "غیرفعال (۶۰ روز و بیشتر)", v: (u.deep_inactive_60d || 0), cls: colors().red },
  ];
  const rate = Math.max(0, Math.min(100, Number(ov.completion_rate ?? 0)));

  host.innerHTML = `
    ${crumbs([{ label: "پنل مدیریت ‹ نمای کلی" }])}
    <div class="adm-grid-4">
      ${statCard({ icon: "👤", label: "کاربران ثبت‌نام‌شده", value: faNum(u.total ?? 0), sub: `حساب فعال: ${faNum(u.account_active ?? 0)} · مدیر: ${faNum(u.admins ?? 0)}` })}
      ${statCard({ icon: "🟢", label: "کاربران فعال (۱۴ روز اخیر)", value: faNum(u.active_14d ?? 0), sub: `امروز: ${faNum(u.active_today ?? 0)} · ۷ روز: ${faNum(u.active_7d ?? 0)}` })}
      ${statCard({ icon: "⚪", label: "کاربران غیرفعال (۱۴+ روز)", value: faNum(u.inactive_14d ?? 0), sub: `بیش از ۶۰ روز بی‌فعالیت: ${faNum(u.deep_inactive_60d ?? 0)}` })}
      ${statCard({ icon: "🚫", label: "حساب‌های معلق", value: faNum(u.suspended ?? 0), sub: "ورود این حساب‌ها مسدود است" })}
      ${statCard({ icon: "🏆", label: "چالش‌های ثبت‌شده", value: faNum(c.total ?? 0), sub: `شروع‌نشده: ${faNum(c.upcoming ?? 0)}` })}
      ${statCard({ icon: "⚡", label: "چالش‌های در جریان", value: faNum(c.ongoing ?? 0), sub: "داخل بازه دوره خود" })}
      ${statCard({ icon: "🏁", label: "چالش‌های پایان‌یافته", value: faNum(c.completed ?? 0), sub: "دوره کامل شده" })}
      ${statCard({ icon: "📝", label: "ثبت‌های روزانه کل", value: faNum(s.total ?? 0), sub: `روزهای از دست رفته ثبت‌شده: ${faNum(s.missed ?? 0)}` })}
      ${statCard({ icon: "✅", label: "نرخ تکمیل کل", value: pct(rate), sub: `وظایف اختیاری انجام‌شده: ${faNum(s.opt_done ?? 0)} از ${faNum(s.opt_total ?? 0)}`,
        extraHtml: `<div class="adm-progress"><div style="width:${rate}%"></div></div>` })}
      ${statCard({ icon: "🎯", label: "میانگین عملکرد کاربران", value: pct(ov.avg_performance ?? 0), sub: "میانگین امتیاز کلی چالش‌ها" })}
    </div>

    <div class="adm-grid-2 adm-grid-charts" style="margin-top:1rem">
      <div class="adm-card">
        <div class="adm-card-head"><h3>ثبت روزانه در ۱۴ روز اخیر</h3><a class="btn btn-ghost small" href="#/challenges">همه چالش‌ها</a></div>
        ${chartBox("ovTrend", 200)}
      </div>
      <div class="adm-card">
        <div class="adm-card-head"><h3>ثبت‌نام روزانه (۱۴ روز اخیر)</h3><a class="btn btn-ghost small" href="#/users">همه کاربران</a></div>
        ${chartBox("ovSignup", 200)}
      </div>
    </div>
    <div class="adm-grid-2 adm-grid-charts">
      <div class="adm-card">
        <div class="adm-card-head"><h3>وضعیت فعالیت کاربران</h3><a class="btn btn-ghost small" href="#/active">کاربران فعال</a></div>
        ${chartBox("ovUsers", 200)}
      </div>
      <div class="adm-card">
        <div class="adm-card-head"><h3>چرخه چالش‌ها</h3></div>
        ${chartBox("ovChal", 200)}
      </div>
    </div>

    <div class="adm-grid-2" style="margin-top:0">
      <div class="adm-card">
        <div class="adm-card-head"><h3>برترین کاربران (امتیاز عملکرد)</h3></div>
        <div class="adm-table-wrap"><table><thead><tr><th>کاربر</th><th>روزهای ثبت‌شده</th><th>امتیاز</th></tr></thead>
        <tbody id="ovTop"></tbody></table></div>
      </div>
      <div class="adm-card">
        <div class="adm-card-head"><h3>آخرین اقدامات مدیریتی</h3><a class="btn btn-ghost small" href="#/logs">گزارش کامل</a></div>
        <div class="adm-facts" id="ovAudit"></div>
      </div>
    </div>`;

  if (isAvailable()) {
    const C = colors();
    lineChart("ovTrend", labels, [
      { label: "روزهای ثبت‌شده", data: subData, color: C.green },
      { label: "روزهای از دست رفته", data: missData, color: C.red },
    ]);
    barChart("ovSignup", labels, [{ label: "ثبت‌نام", data: signUpData }]);
    if (bands.some((b) => b.v > 0)) {
      doughnutChart("ovUsers", bands.map((b) => b.l), bands.map((b) => Math.max(0, b.v)), bands.map((b) => b.cls));
    }
    doughnutChart("ovChal", ["در جریان", "پایان دوره", "شروع نشده"],
      [c.ongoing ?? 0, c.completed ?? 0, c.upcoming ?? 0],
      [colors().blue, colors().blue2, colors().muted]);
  }

  host.querySelector("#ovTop").innerHTML = (ov.top_users || []).map((t) => `
    <tr class="rowclick" data-uid="${esc(String(t.user_id))}">
      <td><div class="user-cell"><span class="av">${avatarLetter(t.username)}</span><div><strong>${esc(t.username)}</strong></div></div></td>
      <td>${faNum(t.sub_days || 0)}</td>
      <td><strong>${pct(t.score)}</strong></td>
    </tr>`).join("") || `<tr><td colspan="3">${emptyState({ icon: "🙂", title: "داده امتیازی ثبت نشده است", sub: "پس از اولین ثبت‌های روزانه، صدرنشینان اینجا می‌آیند." })}</td></tr>`;
  host.querySelectorAll("#ovTop .rowclick").forEach((tr) => {
    tr.addEventListener("click", () => { location.hash = `#/users/${tr.dataset.uid}`; });
  });

  try {
    const lg = await auditPage({ action: "all", page: 1, size: 5 });
    host.querySelector("#ovAudit").innerHTML = lg.rows.map((r) => `
      <div class="f" style="flex-direction:column;align-items:stretch">
        <div class="row" style="justify-content:space-between">${actionLabel(r.o_action)}<span class="muted small">${rel(r.o_created_at)}</span></div>
        <span class="small">${esc(r.o_actor_username || "—")}${r.o_target_username && r.o_target_username !== "—" ? ` → ${esc(r.o_target_username)}` : ""}</span>
      </div>`).join("") || emptyState({ icon: "🧾", title: "گزارشی ثبت نشده است", sub: "پس از اولین اقدام مدیریتی نمایش داده می‌شود." });
  } catch { /* audit preview is non-critical */ }
}

/* ============================================================
   2) USERS MANAGEMENT
   ============================================================ */
const STATUS_OPTS = [
  ["all", "همه کاربران"],
  ["regular", "کاربران عادی"],
  ["admins", "مدیران"],
  ["account_active", "حساب فعال"],
  ["suspended", "حساب معلق"],
];
const ACTIVITY_OPTS = [
  ["all", "همه سطوح فعالیت"],
  ["active_today", "فعال امروز"],
  ["active_7d", "فعال ۷ روز اخیر"],
  ["active_14d", "فعال ۱۴ روز اخیر"],
  ["low", "کم‌فعال (۱۵ تا ۶۰ روز)"],
  ["inactive", "غیرفعال (۶۰+ روز)"],
];
const SORT_OPTS = [
  ["created", "جدیدترین ثبت‌نام"],
  ["created_asc", "قدیمی‌ترین ثبت‌نام"],
  ["performance", "بالاترین عملکرد"],
  ["performance_asc", "کمترین عملکرد"],
  ["activity", "آخرین فعالیت"],
];

function usersToolbarHTML(v) {
  return `
  <div class="adm-toolbar">
    <input type="text" id="uSearch" placeholder="جستجو: نام کاربری یا ایمیل ..." value="${esc(v.q)}" />
    <select id="uStatus">${STATUS_OPTS.map((o) => `<option value="${o[0]}" ${v.status === o[0] ? "selected" : ""}>${o[1]}</option>`).join("")}</select>
    <select id="uActivity">${ACTIVITY_OPTS.map((o) => `<option value="${o[0]}" ${v.activity === o[0] ? "selected" : ""}>${o[1]}</option>`).join("")}</select>
    <select id="uSort">${SORT_OPTS.map((o) => `<option value="${o[0]}" ${v.sort === o[0] ? "selected" : ""}>${o[1]}</option>`).join("")}</select>
  </div>`;
}
function bindUserControls(v, rerender) {
  const search = document.getElementById("uSearch");
  let deb = null;
  search.addEventListener("input", () => {
    clearTimeout(deb);
    deb = setTimeout(() => { v.q = search.value.trim(); v.page = 1; rerender(); }, 450);
  });
  document.getElementById("uStatus").addEventListener("change", (e) => { v.status = e.target.value; v.page = 1; rerender(); });
  document.getElementById("uActivity").addEventListener("change", (e) => { v.activity = e.target.value; v.page = 1; rerender(); });
  document.getElementById("uSort").addEventListener("change", (e) => { v.sort = e.target.value; v.page = 1; rerender(); });
}
function userActionButtons(u) {
  if (!canManage(u)) return "";
  const id = String(u.o_id);
  const isSus = u.o_account_status === "suspended";
  const btns = [
    `<button class="btn btn-ghost small" data-view="${id}" type="button">مشاهده</button>`,
    isSus
      ? `<button class="btn btn-ghost small" data-unban="${id}" type="button">✅ بازفعال‌سازی</button>`
      : `<button class="btn btn-danger-ghost small" data-ban="${id}" type="button">🚫 تعلیق</button>`,
  ];
  if (isSuper() && u.o_id !== me?.id) {
    btns.push(u.o_role === "user"
      ? `<button class="btn btn-ghost small" data-prom="${id}" type="button">⬆ ارتقا به مدیر</button>`
      : `<button class="btn btn-ghost small" data-dem="${id}" type="button">⬇ تنزیل به کاربر</button>`);
  }
  return btns.join("");
}
function bindUserActionButtons(host, rows, rerender) {
  host.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    location.hash = `#/users/${b.dataset.view}`;
  }));
  host.querySelectorAll("[data-ban]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const row = rows.find((r) => String(r.o_id) === b.dataset.ban);
    const ok = await confirmAction({
      title: "تعلیق حساب کاربر",
      message: `حساب «${row?.o_username || "این کاربر"}» تعلیق شود؟ کاربر اجازه ورود بعدی را از دست می‌دهد. سوابق داده او حفظ می‌شود و ثبت‌های قبلی دست‌نخورده می‌ماند.`,
      okLabel: "تعلیق حساب",
    });
    if (!ok) return;
    try { await setUserStatus(b.dataset.ban, "suspended"); toast("حساب کاربر معلق شد.", "success"); rerender(); }
    catch (err) { toast(faError(err, "عملیات ناموفق بود."), "error"); }
  }));
  host.querySelectorAll("[data-unban]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    try { await setUserStatus(b.dataset.unban, "active"); toast("حساب کاربر بازفعال شد.", "success"); rerender(); }
    catch (err) { toast(faError(err, "عملیات ناموفق بود."), "error"); }
  }));
  host.querySelectorAll("[data-prom]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const row = rows.find((r) => String(r.o_id) === b.dataset.prom);
    const ok = await confirmAction({
      title: "ارتقا به مدیر",
      message: `«${row?.o_username || ""}» به نقش مدیر ارتقا یابد؟ دسترسی خواندن همه داده‌های کاربران و انجام اقدامات مدیریتی داده می‌شود.`,
      okLabel: "ارتقا به مدیر", danger: false, okClass: "btn-primary",
    });
    if (!ok) return;
    try { await setUserRole(b.dataset.prom, "admin"); toast("کاربر به نقش مدیر ارتقا یافت.", "success"); rerender(); }
    catch (err) { toast(faError(err, "عملیات ناموفق بود."), "error"); }
  }));
  host.querySelectorAll("[data-dem]").forEach((b) => b.addEventListener("click", async (e) => {
    e.stopPropagation();
    const row = rows.find((r) => String(r.o_id) === b.dataset.dem);
    const ok = await confirmAction({
      title: "تنزیل نقش",
      message: `نقش «${row?.o_username || ""}» به کاربر عادی تنزیل یابد؟`,
      okLabel: "تنزیل به کاربر", danger: false, okClass: "btn-primary",
    });
    if (!ok) return;
    try { await setUserRole(b.dataset.dem, "user"); toast("نقش به کاربر عادی تنزیل یافت.", "success"); rerender(); }
    catch (err) { toast(faError(err, "عملیات ناموفق بود."), "error"); }
  }));
}

export async function viewUsers({ host }) {
  const v = V.users;
  const rerender = () => viewUsers({ host });
  host.innerHTML = `${crumbs([{ label: "پنل مدیریت ‹ کاربران" }])}${usersToolbarHTML(v)}
    <div id="uList"><div class="adm-skeleton"><div class="sk"></div></div></div>
    <div id="uPager"></div>`;
  bindUserControls(v, rerender);
  let res;
  try { res = await usersPage({ ...v, size: 20 }); }
  catch (e) { renderError(host, e, rerender); return; }
  const rows = res.rows || [];
  const list = host.querySelector("#uList");
  if (!rows.length) {
    list.innerHTML = `<div class="adm-card">${emptyState({
      icon: "👥", title: "کاربری یافت نشد",
      sub: v.q || v.status !== "all" || v.activity !== "all" ? "فیلترها را تغییر دهید یا جستجو را پاک کنید." : "هنوز کاربری ثبت‌نام نکرده است.",
    })}</div>`;
    return;
  }
  list.innerHTML = `<div class="adm-card"><div class="adm-table-wrap"><table>
    <thead><tr><th>کاربر</th><th>ایمیل</th><th>ثبت‌نام</th><th>حساب</th><th>فعالیت</th><th>چالش‌ها</th><th>روزهای ثبت</th><th>عملکرد</th><th>اقدامات</th></tr></thead>
    <tbody>
      ${rows.map((r) => `
      <tr class="rowclick" data-uid="${esc(String(r.o_id))}">
        <td><div class="user-cell"><span class="av">${avatarLetter(r.o_username)}</span>
          <div><strong>${esc(r.o_username)}</strong><span class="muted small" style="display:block">${rolePill(r.o_role)}</span></div></div></td>
        <td class="muted">${esc(r.o_email || "—")}</td>
        <td>${faDate(String(r.o_created_at).slice(0, 10))}</td>
        <td>${accountPill(r.o_account_status)}</td>
        <td>${activityPill(r.o_last_seen)}<div class="muted small">${rel(r.o_last_seen)}</div></td>
        <td>${faNum(r.o_challenges || 0)} <span class="muted small">(${faNum(r.o_ongoing || 0)} فعال / ${faNum(r.o_completed || 0)} پایان)</span></td>
        <td>${faNum(r.o_submitted_days || 0)}</td>
        <td>${r.o_perf === null ? `<span class="muted">—</span>` : `<strong>${pct(r.o_perf)}</strong>`}</td>
        <td>${userActionButtons(r)}</td>
      </tr>`).join("")}
    </tbody></table></div></div>`;
  host.querySelector("#uPager").innerHTML =
    paginationBar({ page: v.page, size: 20, total: res.total, onGo: (p) => { v.page = p; rerender(); } });
  host.querySelectorAll("tr.rowclick").forEach((tr) => tr.addEventListener("click", () => {
    location.hash = `#/users/${tr.dataset.uid}`;
  }));
  bindUserActionButtons(host, rows, rerender);
}

/* ============================================================
   3) ACTIVE / INACTIVE USERS
   ============================================================ */
export async function viewActive({ host }) {
  const modes = [
    ["all", "همه", () => 0],
    ["active_today", "فعال امروز", (u) => u.active_today],
    ["active_7d", "۷ روز اخیر", (u) => u.active_7d],
    ["active_14d", "۱۴ روز اخیر", (u) => u.active_14d],
    ["low", "کم‌فعال", (u) => Math.max(0, (u.inactive_14d || 0) - (u.deep_inactive_60d || 0))],
    ["inactive", "غیرفعال ۶۰+", (u) => u.deep_inactive_60d],
  ];
  const mode = V.active.mode || "all";
  const activity = mode === "all" ? "all" : mode;
  const rerender = () => viewActive({ host });
  host.innerHTML = `
    ${crumbs([{ label: "پنل مدیریت", href: "overview" }, { label: "کاربران فعال" }])}
    <div id="actHead"><div class="adm-skeleton"><div class="sk"></div></div></div>
    <p class="small muted">تفاوت <strong>وضعیت حساب</strong> (فعال / معلق — حق ورود) و <strong>وضعیت فعالیت</strong> (ثبت روزانه و تعامل) رعایت شده است؛ حساب فعال ممکن است غیرفعال باشد و بالعکس.</p>
    <div class="adm-chips" id="actChips" style="margin-bottom:.9rem"></div>
    <div id="actList"><div class="adm-skeleton"><div class="sk"></div></div></div>`;
  let ov, res;
  try {
    [ov, res] = await Promise.all([
      overviewStats(60_000).catch(() => null),
      usersPage({ activity, sort: "activity", status: "all", page: 1, size: 100 }),
    ]);
  } catch (e) { renderError(host, e, rerender); return; }
  const u = ov?.users ?? {};
  const countFor = (fn) => faNum(fn(u) ?? 0) ?? "۰";
  host.querySelector("#actHead").innerHTML = `
    <div class="adm-grid-4">
      ${statCard({ icon: "📅", label: "فعال امروز", value: faNum(u.active_today ?? 0), sub: "ورود یا ثبت در ۲۴ ساعت اخیر" })}
      ${statCard({ icon: "🗓", label: "فعال ۷ روز اخیر", value: faNum(u.active_7d ?? 0), sub: "کم‌فعال‌تر از امروز" })}
      ${statCard({ icon: "🟡", label: "کم‌فعال (۱۵ تا ۶۰ روز)", value: faNum(Math.max(0, (u.inactive_14d ?? 0) - (u.deep_inactive_60d ?? 0))), sub: "فعالیتشان میان ۱۵ تا ۶۰ روز پیش بوده است" })}
      ${statCard({ icon: "🔴", label: "غیرفعال (۶۰+ روز)", value: faNum(u.deep_inactive_60d ?? 0), sub: "نیازمند پیگیری مدیر" })}
    </div>`;
  host.querySelector("#actChips").innerHTML = modes.map((m) =>
    `<button class="chip ${mode === m[0] ? "active" : ""}" data-mode="${m[0]}" type="button">${m[1]} <span class="count">${mode === "all" ? faNum(ov?.users?.total ?? 0) : countFor(m[2])}</span></button>`).join("");
  host.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
    V.active.mode = b.dataset.mode; rerender();
  }));
  const list = host.querySelector("#actList");
  const rows = res.rows || [];
  if (!rows.length) {
    list.innerHTML = `<div class="adm-card">${emptyState({ icon: "🔍", title: "کاربری در این بازه نیست", sub: "بازهٔ فعالیت دیگری را انتخاب کنید." })}</div>`;
    return;
  }
  list.innerHTML = `<div class="adm-card"><div class="adm-table-wrap"><table>
    <thead><tr><th>کاربر</th><th>آخرین فعالیت</th><th>آخرین ثبت روزانه</th><th>روزهای ثبت</th><th>چالش‌ها</th><th>عملکرد</th><th>اقدامات</th></tr></thead>
    <tbody>${rows.map((r) => `
      <tr class="rowclick" data-uid="${esc(String(r.o_id))}">
        <td><div class="user-cell"><span class="av">${avatarLetter(r.o_username)}</span>
          <div><strong>${esc(r.o_username)}</strong><span class="muted small" style="display:block">${accountPill(r.o_account_status)} ${rolePill(r.o_role)}</span></div></div></td>
        <td>${activityPill(r.o_last_seen)}<div class="muted small">${rel(r.o_last_seen)}</div></td>
        <td>${r.o_last_submission_at ? `<span class="pill ok">ثبت فعال</span><div class="muted small">${rel(r.o_last_submission_at)}</div>` : `<span class="pill miss">بدون ثبت روزانه</span>`}</td>
        <td>${faNum(r.o_submitted_days || 0)}</td>
        <td>${faNum(r.o_challenges || 0)} <span class="muted small">(${faNum(r.o_ongoing || 0)} فعال)</span></td>
        <td>${r.o_perf === null ? `<span class="muted">—</span>` : `<strong>${pct(r.o_perf)}</strong>`}</td>
        <td>${userActionButtons(r)}</td>
      </tr>`).join("")}
    </tbody></table></div></div>`;
  list.querySelectorAll("tr.rowclick").forEach((tr) => tr.addEventListener("click", () => {
    location.hash = `#/users/${tr.dataset.uid}`;
  }));
  bindUserActionButtons(list, rows, rerender);
}

/* ============================================================
   4) INDIVIDUAL USER DETAILS
   ============================================================ */
export async function viewUserDetail({ host }, userId) {
  host.innerHTML = `${crumbs([{ label: "پنل مدیریت", href: "overview" }, { label: "کاربران", href: "users" }, { label: "پرونده کاربر" }])}
    <div class="adm-skeleton"><div class="sk"></div><div class="sk"></div></div>`;
  const rerender = () => viewUserDetail({ host }, userId);
  let det, ch;
  try {
    [det, ch] = await Promise.all([userDetail(userId), challengesPage({ owner: userId, size: 50 })]);
  } catch (e) { renderError(host, e, rerender); return; }

  const p = det.profile, st = det.stats;
  const roleTxt = p.role === "super_admin" ? "مدیر ارشد" : p.role === "admin" ? "مدیر" : "کاربر عادی";
  const selfRow = { o_id: p.id, o_role: p.role };
  const manageable = p.id !== me?.id && canManage(selfRow);

  host.innerHTML = `
    ${crumbs([{ label: "پنل مدیریت", href: "overview" }, { label: "کاربران", href: "users" }, { label: p.username }])}
    <div class="adm-card">
      <div class="adm-profile">
        <div class="av-lg">${avatarLetter(p.username)}</div>
        <div style="min-width:0">
          <h2>${esc(p.username)} ${accountPill(p.account_status)} ${rolePill(p.role)}</h2>
          <div class="sub">${esc(p.email || "ایمیل نمایش داده نشده")} · نقش: ${roleTxt}</div>
          <div class="sub">ثبت‌نام: ${faDate(String(p.created_at).slice(0, 10))} · آخرین فعالیت: ${rel(p.last_seen)} (${dt(p.last_seen)})</div>
          <div class="sub">آخرین ثبت روزانه: ${p.last_submission_at ? `${rel(p.last_submission_at)} (${dt(p.last_submission_at)})` : "هیچ ثبت روزانه‌ای نداشته است"}</div>
        </div>
        <div class="acts">
          <a class="btn btn-primary small" href="#/analytics/${userId}">📈 تحلیل‌های کامل</a>
          ${manageable ? (p.account_status === "suspended"
            ? `<button class="btn btn-primary small" data-unban type="button">✅ بازفعال‌سازی حساب</button>`
            : `<button class="btn btn-danger-ghost small" data-ban type="button">🚫 تعلیق حساب</button>`) : ""}
          ${isSuper() && p.id !== me?.id && p.role === "user"
            ? `<button class="btn btn-ghost small" data-prom type="button">⬆ ارتقا به مدیر</button>` : ""}
        </div>
      </div>
    </div>

    <div class="adm-grid-4">
      ${statCard({ icon: "🏆", label: "چالش‌ها", value: faNum(st.challenges_total), sub: `${faNum(st.ongoing)} در جریان · ${faNum(st.completed)} پایان‌یافته` })}
      ${statCard({ icon: "✅", label: "روزهای ثبت‌شده", value: faNum(st.sub_days), sub: `از ${faNum(st.window_elapsed)} روز داخل دوره‌ها` })}
      ${statCard({ icon: "🎯", label: "عملکرد کلی کاربر", value: st.perf === null ? "–" : pct(st.perf), sub: "امتیاز کلی نسبت به روزهای دوره" })}
      ${statCard({ icon: "➕", label: "امتیاز مثبت / تشویقی", value: `${faNum(st.points)} / ‎${faNum(st.bonus)}`, numSmall: true, sub: `وظایف اختیاری: ${faNum(st.opt_done)} از ${faNum(st.opt_total)}` })}
    </div>

    <div class="adm-card">
      <div class="adm-card-head"><h3>چالش‌های این کاربر</h3><span class="muted small">برای مشاهده جزئیات روزها، چالش را کلیک کنید</span></div>
      ${ch.rows.length ? `<div class="adm-table-wrap"><table>
        <thead><tr><th>چالش</th><th>شروع</th><th>دوره</th><th>روزهای سپری</th><th>ثبت / از دست رفته</th><th>پوشش دوره</th><th>وضعیت</th></tr></thead>
        <tbody>
        ${ch.rows.map((r) => `
          <tr class="rowclick" data-ch="${esc(String(r.o_id))}">
            <td><strong>${esc(r.o_name)}</strong>${r.o_goal_name ? `<div class="muted small">${esc(r.o_goal_name)}</div>` : ""}</td>
            <td>${faDate(String(r.o_start_date))}</td>
            <td>${faNum(r.o_duration)} روز</td>
            <td>${faNum(r.o_elapsed_days)}</td>
            <td><span class="green">${faNum(r.o_submitted_days || 0)}</span> / <span class="red">${faNum(r.o_missed_days || 0)}</span></td>
            <td>${pct(r.o_coverage === null ? null : r.o_coverage)}
              <div class="adm-progress" style="min-width:70px"><div style="width:${Math.min(100, r.o_coverage ?? 0)}%"></div></div></td>
            <td>${lifePill(r.o_status)}</td>
          </tr>`).join("")}
        </tbody></table></div>` : emptyState({ icon: "🏆", title: "چالش ثبت نشده", sub: "این کاربر هنوز چالشی نساخته است." })}
    </div>

    <div class="adm-card">
      <div class="adm-card-head"><h3>آخرین ثبت‌های روزانه کاربر</h3></div>
      ${det.recent?.length ? `<div class="adm-facts">${det.recent.map((r) => `
        <div class="f"><span>${esc(r.challenge_name)} — ${faDate(String(r.day))}</span>
        <strong><span class="green">${faNum(r.points)} امتیاز</span> · ${pct(r.pct)} · ${esc(r.grade || "—")}</strong></div>`).join("")}</div>`
        : emptyState({ icon: "📝", title: "ثبتی وجود ندارد", sub: "کاربر هنوز نتیجه‌ی روزانه‌ای ثبت نکرده است." })}
    </div>`;

  host.querySelector("[data-ban]")?.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "تعلیق حساب کاربر",
      message: `حساب «${p.username}» تعلیق شود؟ کاربر اجازه ورود بعدی را از دست می‌دهد. سوابق داده او حفظ می‌شود.`,
      okLabel: "تعلیق حساب",
    });
    if (!ok) return;
    try { await setUserStatus(userId, "suspended"); toast("حساب کاربر معلق شد.", "success"); rerender(); }
    catch (e2) { toast(faError(e2, "عملیات ناموفق بود."), "error"); }
  });
  host.querySelector("[data-unban]")?.addEventListener("click", async () => {
    try { await setUserStatus(userId, "active"); toast("حساب کاربر بازفعال شد.", "success"); rerender(); }
    catch (e2) { toast(faError(e2, "عملیات ناموفق بود."), "error"); }
  });
  host.querySelector("[data-prom]")?.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "ارتقا به مدیر",
      message: `«${p.username}» به نقش مدیر ارتقا یابد؟`,
      okLabel: "ارتقا به مدیر", danger: false, okClass: "btn-primary",
    });
    if (!ok) return;
    try { await setUserRole(userId, "admin"); toast("کاربر به نقش مدیر ارتقا یافت.", "success"); rerender(); }
    catch (e2) { toast(faError(e2, "عملیات ناموفق بود."), "error"); }
  });
  host.querySelectorAll("tr.rowclick").forEach((tr) => tr.addEventListener("click", () => {
    location.hash = `#/ch/${tr.dataset.ch}`;
  }));
}

/* ============================================================
   5) CHALLENGE DETAIL & DAILY MONITORING
   ============================================================ */
// merge live tasks with archived titles (deleted tasks still resolve)
function mergeTaskSources(tasks, history) {
  const map = new Map();
  for (const h of history || []) {
    map.set(h.task_id, { id: h.task_id, title: h.title, description: h.description || "", created_at: h.created_at, archived: true });
  }
  for (const t of tasks || []) {
    map.set(t.id, { id: t.id, title: t.title, description: t.description || "", created_at: t.created_at, archived: false });
  }
  return [...map.values()].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}
function dayClass(status) {
  return { submitted: "ok", missed: "missed", pending: "pending", future: "future", pre: "pre" }[status] || "";
}
function dayLabel(status) {
  return { submitted: "ثبت‌شده", missed: "از دست رفته", pending: "در انتظار (امروز)", future: "آینده", pre: "قبل از شروع" }[status] || "";
}
function coveragePct(c, stats) {
  if (!c.window_elapsed) return null;
  return Math.min(100, (Number(stats?.sub_days ?? 0) / c.window_elapsed) * 100);
}
function parseMonthOf(dayStr) {
  const d = parseDay(dayStr);
  return { y: d.getFullYear(), m: d.getMonth() };
}
function monthTitle(y, m) {
  return new Date(y, m, 15).toLocaleDateString("fa-IR", { year: "numeric", month: "long" });
}

export async function viewChallengeDetail({ host }, challengeId) {
  setLoading(host);
  let det;
  try { det = await challengeDetail(challengeId); }
  catch (e) { renderError(host, e, () => viewChallengeDetail({ host }, challengeId)); return; }
  const c = det.challenge;
  let subs, scores, tasksSrc;
  try {
    [subs, scores, tasksSrc] = await Promise.all([
      listChallengeSubmissions(challengeId),
      listChallengeScores(challengeId),
      listChallengeTasks(challengeId),
    ]);
  } catch (e) { renderError(host, e, () => viewChallengeDetail({ host }, challengeId)); return; }

  const subMap = new Map(subs.map((r) => [r.day, r]));
  const scoreMap = new Map(scores.map((r) => [r.day, r]));
  const mergedTasks = mergeTaskSources(tasksSrc.tasks, tasksSrc.history);
  cardRefTasks[challengeId] = mergedTasks;

  const start = c.start_date;
  const endDay = c.is_completed ? c.end_date : todayStr();
  const browseEnd = endDay < start ? start : endDay;
  const lastSubmittedDay = [...scores].reverse().find((r) => r.status === "submitted")?.day
    || subs[subs.length - 1]?.day || browseEnd;
  if (!V.day[challengeId]) {
    const m0 = parseMonthOf(lastSubmittedDay);
    V.day[challengeId] = { ...m0, sel: null };
  }
  const dv = V.day[challengeId];
  const stats = det.stats || {};

  host.innerHTML = `
    ${crumbs([{ label: "پنل مدیریت", href: "overview" }, { label: "کاربر", href: `users/${c.user_id}` }, { label: c.name }])}
    <div class="adm-card">
      <div class="adm-profile">
        <div style="min-width:0">
          <h2>🏆 ${esc(c.name)} ${lifePill(c.is_upcoming ? "upcoming" : c.is_completed ? "completed" : "ongoing")}</h2>
          <div class="sub">مدیریت داده: <a class="link" href="#/users/${c.user_id}">${esc(det.owner.username)}</a> ${accountPill(det.owner.account_status)}</div>
          ${c.goal_name ? `<div class="sub">هدف شخصی: ${esc(c.goal_name)}</div>` : ""}
        </div>
      </div>
    </div>

    <div class="adm-grid-4">
      ${statCard({ icon: "🧭", label: "شروع چالش", value: faDate(String(c.start_date)), numSmall: true, sub: `دوره: ${faNum(c.duration)} روز · پایان: ${faDate(String(c.end_date))}` })}
      ${statCard({ icon: "⏳", label: "روزهای سپری‌شده از شروع", value: faNum(c.elapsed_days), sub: `${c.is_completed ? "دوره کامل شده است" : c.is_upcoming ? "چالش شروع نشده" : "دوره در جریان است"}` })}
      ${statCard({ icon: "✅", label: "ثبت‌شده / از دست رفته", value: `${faNum(stats.sub_days ?? 0)} / ${faNum(stats.missed_rows ?? 0)}`, numSmall: true, sub: `پوشش دوره: ${pct(coveragePct(c, stats))}` })}
      ${statCard({ icon: "🎯", label: "امتیاز اجباری / تشویقی", value: `${faNum(Number(stats.points ?? 0))} / ‎${faNum(Number(stats.bonus ?? 0))}`, numSmall: true, sub: `وظایف اختیاری: ${faNum(stats.opt_done ?? 0)} از ${faNum(stats.opt_total ?? 0)}` })}
    </div>

    <div class="adm-card">
      <div class="adm-card-head">
        <h3 id="calTitle">${monthTitle(dv.y, dv.m)}</h3>
        <select id="calMonth" class="adm-month-select"></select>
      </div>
      <div class="legend">
        <span><i class="dot ok"></i> ثبت کامل</span>
        <span><i class="dot partial"></i> ثبت ناقص</span>
        <span><i class="dot missed"></i> از دست رفته</span>
        <span><i class="dot pending"></i> در انتظار (امروز)</span>
        <span><i class="dot future"></i> آینده</span>
        <span><i class="dot pre"></i> قبل از شروع</span>
      </div>
      <div class="day-dow"><span>ش</span><span>ی</span><span>د</span><span>س</span><span>چ</span><span>پ</span><span>ج</span></div>
      <div class="day-grid" id="dayGrid"></div>
      <div id="dayDetail" style="margin-top:.9rem"></div>
    </div>

    <div class="adm-card">
      <div class="adm-card-head"><h3>روند امتیاز روزانه (درصد اجباری)</h3></div>
      ${chartBox("chTrend", 190)}
    </div>`;

  // month dropdown bounded from start month to current browse end
  const months = [];
  const cur = parseMonthOf(start);
  const last = parseMonthOf(browseEnd);
  while (cur.y < last.y || (cur.y === last.y && cur.m <= last.m)) {
    months.push({ y: cur.y, m: cur.m });
    cur.m += 1; if (cur.m > 11) { cur.m = 0; cur.y += 1; }
  }
  const sel = host.querySelector("#calMonth");
  sel.innerHTML = months.map((x) =>
    `<option value="${x.y}-${x.m}" ${x.y === dv.y && x.m === dv.m ? "selected" : ""}>${monthTitle(x.y, x.m)}</option>`).join("");
  sel.addEventListener("change", () => {
    const [y, m] = sel.value.split("-").map(Number);
    V.day[challengeId] = { y, m, sel: null };
    drawAll();
  });

  const grid = host.querySelector("#dayGrid");
  const title = host.querySelector("#calTitle");
  function drawAll() {
    title.textContent = monthTitle(dv.y, dv.m);
    drawDayGrid(grid, dv, subMap, scoreMap, c, challengeId, sel);
    if (dv.sel) renderDayDetail(grid.closest(".adm-card"), dv.sel, subMap, scoreMap, mergedTasks, c);
  }
  drawAll();

  // trend chart of submitted-day pct
  const trendRows = scores.filter((r) => r.status === "submitted");
  if (isAvailable() && trendRows.length) {
    lineChart("chTrend", trendRows.map((r) => faShort(r.day)),
      [{ label: "درصد روز", data: trendRows.map((r) => Number(r.mandatory_pct || 0)), color: colors().blue }],
      { yMax: 100, fill: false });
  }
}

function drawDayGrid(grid, dv, subMap, scoreMap, c, cid, sel) {
  const y = dv.y, m = dv.m;
  const today = todayStr();
  const first = new Date(y, m, 1);
  const lead = (first.getDay() + 1) % 7; // Persian week starts Saturday
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(`<div></div>`);
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const hasSub = subMap.get(ds) || null;
    const st = dayStatus(ds, c.start_date, today, !!hasSub);
    const sc = scoreMap.get(ds);
    const tag = hasSub
      ? `٪${faNum(sc?.mandatory_pct ?? 0)}`
      : st === "missed" ? "از دست رفته" : dayLabel(st);
    cells.push(`<div class="day-cell ${dayClass(st)} ${ds === today ? "today" : ""} ${dv.sel === ds ? "sel" : ""}" data-day="${ds}">
      <span class="d">${faNum(d)}</span>
      <span class="s">${esc(tag)}</span>
    </div>`);
  }
  grid.innerHTML = cells.join("");
  grid.querySelectorAll("[data-day]").forEach((el) => el.addEventListener("click", () => {
    dv.sel = el.dataset.day;
    sel.value = `${dv.y}-${dv.m}`;
    grid.querySelectorAll(".day-cell").forEach((x) => x.classList.remove("sel"));
    el.classList.add("sel");
    const card = grid.closest(".adm-card");
    renderDayDetail(card, dv.sel, subMap, scoreMap, cardRefTasks[cid] || [], c);
  }));
}
// per-challenge tasks cache used by day detail clicks
const cardRefTasks = {};

function renderDayDetail(card, ds, subMap, scoreMap, tasks, c) {
  const el = card.querySelector("#dayDetail");
  if (!ds || !el) { if (el) el.innerHTML = ""; return; }
  const hasSub = subMap.get(ds) || null;
  const sc = scoreMap.get(ds) || null;
  const today = todayStr();
  const st = dayStatus(ds, c.start_date, today, !!hasSub);
  const head = `<strong>${faDate(ds)}</strong><span class="muted">${esc(dayLabel(st))}</span>`;

  if (st === "future" || st === "pre") {
    el.innerHTML = `<div class="verdict">${head}<span class="muted small">${st === "pre"
      ? "این روز قبل از تاریخ شروع چالش است و هرگز محاسبه نمی‌شود."
      : "این روز هنوز نرسیده است."}</span></div>`;
    return;
  }
  if (!hasSub) {
    el.innerHTML = `<div class="verdict" style="flex-direction:column;align-items:stretch">
      <div class="row" style="justify-content:space-between">${head}${sc ? `<span class="muted small">وضعیت در رکورد امتیاز: ${esc(sc.status)}</span>` : ""}</div>
      <span class="small">${st === "missed"
        ? "روز گذشته و <strong class=\"red\">بدون ثبت</strong> — طبق قواعد امتیازدهی، امتیاز صفر می‌گیرد."
        : "امروز است و کاربر هنوز نتیجه ثبت نکرده است."}</span>
    </div>`;
    return;
  }

  const entry = toEntry(hasSub);
  const eff = effectiveTasks(tasks, ds); // only tasks created on/before that day
  const states = entry.custom_states || {};
  const doneRules = RULES.filter((r) => ruleMet(entry, r.key));
  const perRule = RULES.map((r) => {
    const pts = Math.round(rulePoints10(entry, r.key) * 10) / 10;
    const met = ruleMet(entry, r.key);
    const val = r.key === "reading" ? `${faNum(Number(entry.reading_pages) || 0)} صفحه`
      : r.key === "exercise" ? `${faNum(Number(entry.exercise_minutes) || 0)} دقیقه`
      : r.key === "goal" ? `${faNum(Number(entry.goal_minutes) || 0)} دقیقه`
      : r.key === "wake" ? (entry.wake_time || "—")
      : (r.key === "noAlcohol" ? entry.no_alcohol : entry.no_smoke) ? "رعایت شد" : "رعایت نشد";
    return { r, pts, met, val };
  });
  const optDone = eff.filter((t) => !!states[t.id]);
  const optNot = eff.filter((t) => !states[t.id]);
  const bonus = Math.min(optDone.length * BONUS_PER_TASK, BONUS_CAP);

  el.innerHTML = `
    <div class="verdict" style="justify-content:space-between">
      <div class="row">${head}</div>
      <div class="row" style="gap:.8rem">
        <span class="small">امتیاز اجباری: <strong class="green">${faNum(sc?.mandatory_points ?? 0)}</strong> / ${faNum(MAX_MANDATORY)}</span>
        <span class="small">درصد: <strong>${pct(sc?.mandatory_pct ?? 0)}</strong></span>
        <span class="small">تشویقی: <strong class="blue">‎+${faNum(sc?.bonus_points ?? bonus)}</strong></span>
        <span class="small">رتبه: <strong>${esc(sc?.grade || grade(sc?.mandatory_pct ?? 0))}</strong></span>
      </div>
    </div>
    <h4 style="margin-top:.8rem">قوانین اجباری (${faNum(doneRules.length)} از ${faNum(RULES.length)} کامل)</h4>
    <div class="rule-list">
      ${perRule.map((x) => `
      <div class="rule-row">
        <span class="t"><strong>${x.r.ico} ${esc(x.r.title)}</strong><br/>
          <em>مقدار ثبت‌شده: ${esc(x.val)} — هدف: ${esc(x.r.desc)}</em></span>
        <span class="row">
          ${x.met ? `<span class="pill ok">انجام کامل</span>` : x.pts > 0 ? `<span class="pill pending">جزئی</span>` : `<span class="pill miss">انجام نشد</span>`}
          <span class="pts">${faNum(x.pts)} از ۱۰</span>
        </span>
      </div>`).join("")}
    </div>
    <h4 style="margin-top:.9rem">وظایف اختیاری آن روز (${faNum(optDone.length)} از ${faNum(eff.length)})</h4>
    ${eff.length ? `<div class="rule-list">
      ${optDone.map((t) => `<div class="rule-row"><span class="t">✅ ${esc(t.title)}</span><span class="pill ok">انجام‌شده</span></div>`).join("")}
      ${optNot.map((t) => `<div class="rule-row"><span class="t">☑️ ${esc(t.title)}${t.archived ? ` <span class="pill none">وظیفه بعداً حذف شده</span>` : ""}</span><span class="pill none">انجام نشد</span></div>`).join("")}
      ${bonus >= BONUS_CAP ? `<div class="rule-row muted small">سقف تشویقی روزانه (${faNum(BONUS_CAP)}) در این روز پر شده است.</div>` : ""}
    </div>` : `<p class="muted small">در آن روز، بازی کاربر وظایف اختیاری‌ای تعریف نکرده بود.</p>`}
    ${entry.notes ? `<h4 style="margin-top:.8rem">یادداشت کاربر</h4>
      <div style="white-space:pre-wrap;background:#0a1330;border:1px solid var(--line);border-radius:10px;padding:.6rem .7rem;font-size:.82rem">${esc(entry.notes)}</div>` : ""}
    <div class="adm-facts" style="margin-top:.8rem">
      <div class="f"><span>زمان ثبت / آخرین به‌روزرسانی رکورد این روز</span><strong>${hasSub.updated_at ? dt(hasSub.updated_at) : "—"}</strong></div>
    </div>`;
}

/* ============================================================
   6) PERFORMANCE ANALYTICS (per user)
   ============================================================ */
function weekStartSat(ds) {
  const d = parseDay(ds);
  d.setDate(d.getDate() - ((d.getDay() + 1) % 7)); // Saturday-start week
  return fmt(d);
}
function jalaliMonthKey(ds) {
  return parseDay(ds).toLocaleDateString("fa-IR", { year: "numeric", month: "long" });
}

export async function viewAnalytics({ host }, userId) {
  if (!userId && !V.analytics.userId) { await renderAnalyticsPicker({ host }); return; }
  const uid = userId || V.analytics.userId;
  const rerender = () => viewAnalytics({ host }, uid);
  setLoading(host);
  let challengeList, scores, subs;
  try {
    challengeList = await listUserChallengeIds(uid);
    const ids = challengeList.map((c) => c.id);
    [scores, subs] = await Promise.all([listUserScores(ids), listUserSubmissions(ids)]);
  } catch (e) { renderError(host, e, rerender); return; }

  const selCh = challengeList.length === 1 ? challengeList[0].id : (challengeList.some((c) => c.id === V.analytics.challengeId) ? V.analytics.challengeId : null);
  if (!challengeList.length) {
    host.innerHTML = `${crumbs([{ label: "پنل مدیریت", href: "overview" }, { label: "تحلیل عملکرد" }])}
      <div class="adm-card">${emptyState({ icon: "📈", title: "این کاربر چالشی ندارد", sub: "برای تحلیل، کاربر دیگری را انتخاب کنید.",
        actionHtml: `<button class="btn btn-primary small" id="anChangeUser" type="button">انتخاب کاربر دیگر</button>` })}</div>`;
    host.querySelector("#anChangeUser").addEventListener("click", () => { V.analytics.userId = null; viewAnalytics({ host }, null); });
    return;
  }
  V.analytics.challengeId = selCh;
  V.analytics.userId = uid;

  const shownIds = challengeList.filter((c) => !selCh || c.id === selCh).map((c) => c.id);
  const rows = scores.filter((r) => shownIds.includes(r.challenge_id));
  const subRows = subs.filter((r) => shownIds.includes(r.challenge_id));

  const submitted = rows.filter((r) => r.status === "submitted");
  const missed = rows.filter((r) => r.status === "missed");
  const byDayAsc = [...rows].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const subByDay = new Map(subRows.map((r) => [r.day, r]));

  // weekly & monthly & pos/neg aggregations
  const weekAvg = new Map(), monthAvg = new Map(), weekPos = new Map(), weekNeg = new Map(), weekBonus = new Map(), weekMiss = new Map(), monthMiss = new Map();
  for (const r of rows) {
    const wk = weekStartSat(r.day), mk = jalaliMonthKey(r.day);
    if (r.status === "submitted") {
      const W = weekAvg.get(wk) || { n: 0, sum: 0 };
      W.n++; W.sum += Number(r.mandatory_pct || 0); weekAvg.set(wk, W);
      const M = monthAvg.get(mk) || { n: 0, sum: 0 };
      M.n++; M.sum += Number(r.mandatory_pct || 0); monthAvg.set(mk, M);
      const pts = Number(r.mandatory_points || 0);
      weekPos.set(wk, (weekPos.get(wk) || 0) + pts);
      weekNeg.set(wk, (weekNeg.get(wk) || 0) + Math.max(0, MAX_MANDATORY - pts));
      weekBonus.set(wk, (weekBonus.get(wk) || 0) + Number(r.bonus_points || 0));
    } else {
      weekMiss.set(wk, (weekMiss.get(wk) || 0) + 1);
      monthMiss.set(mk, (monthMiss.get(mk) || 0) + 1);
    }
  }
  const weekKeys = [...new Set([...weekAvg.keys(), ...weekMiss.keys()])].sort();
  const monthKeys = [...new Set([...monthAvg.keys(), ...monthMiss.keys()])].sort();

  // per-rule counters from raw submission values (identical formula to the user app)
  const ruleCounts = RULES.map((r) => ({ ...r, done: 0 }));
  for (const r of submitted) {
    const entry = subByDay.get(r.day);
    if (!entry) continue;
    ruleCounts.forEach((rc, i) => { if (ruleMet(entry, RULES[i].key)) rc.done++; });
  }
  const nSub = submitted.length;

  // trend verdict: last 7 submitted vs previous 7
  const subAsc = [...submitted].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  const avg = (arr) => arr.length ? arr.reduce((a, r) => a + Number(r.mandatory_pct || 0), 0) / arr.length : null;
  const a1 = avg(subAsc.slice(-7)), a0 = avg(subAsc.slice(-14, -7));
  let verdict, vcls;
  if (a1 === null) { verdict = "داده کافی برای قضاوت نیست"; vcls = "none"; }
  else if (a0 === null) { verdict = `میانگین ثبت‌های اخیر: ${pct(a1)}`; vcls = "blue"; }
  else if (a1 - a0 >= 5) { verdict = "در حال بهبود"; vcls = "ok"; }
  else if (a0 - a1 >= 5) { verdict = "افت عملکرد — نیازمند پیگیری"; vcls = "miss"; }
  else { verdict = "ثبات نسبی"; vcls = "pending"; }
  // streaks over the union of submission days
  const daysSet = new Set(subRows.map((r) => r.day));
  let curStreak = 0, cursor = daysSet.has(todayStr()) ? todayStr() : addDays(todayStr(), -1);
  while (daysSet.has(cursor)) { curStreak++; cursor = addDays(cursor, -1); }
  let best = 0, run = 0, prev = null;
  for (const d of [...daysSet].sort()) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    best = Math.max(best, run); prev = d;
  }
  const avgAll = nSub ? submitted.reduce((a, r) => a + Number(r.mandatory_pct || 0), 0) / nSub : 0;

  host.innerHTML = `
    ${crumbs([{ label: "پنل مدیریت", href: "overview" }, { label: "تحلیل عملکرد" }])}
    <div class="adm-card">
      <div class="adm-profile">
        <div class="sub" style="min-width:0">تحلیل روزانه / هفتگی / ماهانه از داده واقعی ثبت‌ها</div>
        <div class="acts">
          <a class="btn btn-ghost small" href="#/users/${uid}">پرونده کاربر</a>
          <button class="btn btn-ghost small" id="anChangeUser" type="button">تغییر کاربر</button>
        </div>
      </div>
      <div class="adm-chips" style="margin-top:.7rem">
        <button class="chip ${!selCh ? "active" : ""}" data-ch="all" type="button">همه چالش‌ها (${faNum(challengeList.length)})</button>
        ${challengeList.map((c) => `<button class="chip ${selCh === c.id ? "active" : ""}" data-ch="${c.id}" type="button">${esc(c.name)}</button>`).join("")}
      </div>
    </div>

    ${!rows.length ? `<div class="adm-card">${emptyState({ icon: "📈", title: "داده‌ای برای تحلیل نیست", sub: "این کاربر هنوز نتیجه روزانه‌ای ثبت نکرده است." })}</div>` : `
    <div class="verdict" style="margin-bottom:.9rem">
      <span class="pill ${vcls === "ok" ? "ok" : vcls === "miss" ? "miss" : vcls === "blue" ? "blue" : "pending"}">${esc(verdict)}</span>
      ${a1 !== null && a0 !== null ? `<span class="muted small">۷ ثبت اخیر: ${pct(a1)} · هفته قبل: ${pct(a0)}</span>` : ""}
      <span class="muted small">رشته فعلی <strong>${faNum(curStreak)}</strong> · بهترین رشته <strong>${faNum(best)}</strong> روز</span>
      <span class="muted small"> میانگین کل: ${pct(avgAll)} · از دست رفته: ${faNum(missed.length)} روز</span>
    </div>

    <div class="adm-grid-2 adm-grid-charts">
      <div class="adm-card"><div class="adm-card-head"><h3>عملکرد روزانه (درصد اجباری)</h3></div>${chartBox("anDaily", 200)}</div>
      <div class="adm-card"><div class="adm-card-head"><h3>مثبت در برابر منفی (هفتگی)</h3></div>${chartBox("anPosNeg", 200)}</div>
    </div>
    <div class="adm-grid-2 adm-grid-charts">
      <div class="adm-card"><div class="adm-card-head"><h3>میانگین هفتگی</h3></div>${chartBox("anWeekly", 180)}</div>
      <div class="adm-card"><div class="adm-card-head"><h3>میانگین ماهانه</h3></div>${chartBox("anMonthly", 180)}</div>
    </div>
    <div class="adm-grid-2 adm-grid-charts">
      <div class="adm-card"><div class="adm-card-head"><h3>نرخ اتمام هر قانون اجباری</h3></div>${chartBox("anRules", 180)}</div>
      <div class="adm-card"><div class="adm-card-head"><h3>روند روزهای از دست رفته (هفتگی)</h3></div>${chartBox("anMissed", 180)}</div>
    </div>

    <div class="adm-card">
      <div class="adm-card-head"><h3>کارنامه قوانین (روزهای ثبت‌شده)</h3></div>
      <div class="adm-table-wrap"><table>
        <thead><tr><th>قانون</th><th>انجام موفق</th><th>ناموفق</th><th>نرخ موفقیت</th></tr></thead>
        <tbody>${ruleCounts.map((r) => `
          <tr><td>${r.ico} ${esc(r.title)}</td><td class="green">${faNum(r.done)}</td>
          <td class="red">${faNum(nSub - r.done)}</td><td>${nSub ? pct((r.done / nSub) * 100) : "—"}</td></tr>`).join("")}
        </tbody></table></div>
    </div>

    <div class="adm-card">
      <div class="adm-card-head"><h3>جمع‌بندی هفتگی</h3></div>
      <div class="adm-table-wrap"><table>
        <thead><tr><th>هفته (از شنبه)</th><th>میانگین روزهای ثبت</th><th>ثبت‌شده</th><th>از دست رفته</th><th>تشویقی هفته</th></tr></thead>
        <tbody>${weekKeys.map((wk) => `
          <tr><td>${faShort(wk)}</td>
          <td>${weekAvg.get(wk) ? pct(weekAvg.get(wk).sum / weekAvg.get(wk).n) : "—"}</td>
          <td class="green">${faNum(weekAvg.get(wk)?.n || 0)}</td>
          <td class="red">${faNum(weekMiss.get(wk) || 0)}</td>
          <td>${faNum(Math.round(weekBonus.get(wk) || 0))}</td></tr>`).join("")}
        </tbody></table></div>
    </div>`}
  `;

  host.querySelector("#anChangeUser").addEventListener("click", () => {
    V.analytics.userId = null; V.analytics.challengeId = null;
    viewAnalytics({ host }, null);
  });
  host.querySelectorAll("[data-ch]").forEach((b) => b.addEventListener("click", () => {
    V.analytics.challengeId = b.dataset.ch === "all" ? null : b.dataset.ch;
    rerender();
  }));

  if (!rows.length || !isAvailable()) return;
  const C = colors();
  if (byDayAsc.length) {
    lineChart("anDaily", byDayAsc.map((r) => faShort(r.day)),
      [{ label: "درصد روز", data: byDayAsc.map((r) => Number(r.mandatory_pct || 0)), color: C.blue }],
      { yMax: 100 });
  }
  if (weekKeys.length) {
    barChart("anPosNeg", weekKeys.map((w) => faShort(w)), [
      { label: "امتیاز مثبت", data: weekKeys.map((w) => Math.round(weekPos.get(w) || 0)), color: C.green, stack: "s" },
      { label: "منفی / از دست رفته", data: weekKeys.map((w) => Math.round(weekNeg.get(w) || 0) + (weekMiss.get(w) || 0) * MAX_MANDATORY), color: C.red, stack: "s" },
    ], { stacked: true });
    barChart("anWeekly", weekKeys.map((w) => faShort(w)), [
      { label: "میانگین درصد", data: weekKeys.map((w) => weekAvg.get(w) ? Math.round(weekAvg.get(w).sum / weekAvg.get(w).n) : 0), color: C.blue },
    ], { yMax: 100 });
    lineChart("anMissed", weekKeys.map((w) => faShort(w)),
      [{ label: "روزهای از دست رفته", data: weekKeys.map((w) => weekMiss.get(w) || 0), color: C.red }]);
  }
  if (monthKeys.length) {
    barChart("anMonthly", monthKeys, [
      { label: "میانگین درصد", data: monthKeys.map((m) => monthAvg.get(m) ? Math.round(monthAvg.get(m).sum / monthAvg.get(m).n) : 0), color: C.blue2 },
    ], { yMax: 100 });
  }
  barChart("anRules", ruleCounts.map((r) => r.ico), [
    { label: "نرخ موفقیت (٪)", data: ruleCounts.map((r) => nSub ? Math.round((r.done / nSub) * 100) : 0), color: C.green },
  ], { yMax: 100 });
}

async function renderAnalyticsPicker({ host }) {
  const rerender = () => renderAnalyticsPicker({ host });
  setLoading(host);
  let res;
  try { res = await usersPage({ sort: "activity", size: 8, page: 1 }); }
  catch (e) { renderError(host, e, rerender); return; }
  const drawList = (rows) => rows.map((r) => `
    <div class="rule-row rowclick" style="cursor:pointer" data-uid="${esc(String(r.o_id))}">
      <div class="user-cell"><span class="av">${avatarLetter(r.o_username)}</span>
        <div><strong>${esc(r.o_username)}</strong><span class="muted small" style="display:block">${rel(r.o_last_seen)}</span></div></div>
      <div class="row">${rolePill(r.o_role)}<span class="muted small">${faNum(r.o_challenges || 0)} چالش</span></div>
    </div>`).join("") || emptyState({ icon: "🔍", title: "موردی پیدا نشد", sub: "نام دیگری را جستجو کنید." });
  host.innerHTML = `
    ${crumbs([{ label: "پنل مدیریت", href: "overview" }, { label: "تحلیل عملکرد" }])}
    <div class="adm-card">
      <div class="adm-card-head"><h3>انتخاب کاربر برای تحلیل</h3></div>
      <div class="adm-toolbar"><input type="text" id="anSearch" placeholder="جستجوی نام کاربری..." /></div>
      <div id="anRes"></div>
    </div>`;
  const resBox = host.querySelector("#anRes");
  resBox.innerHTML = drawList(res.rows || []);
  resBox.querySelectorAll(".rowclick").forEach((el) => el.addEventListener("click", () => {
    V.analytics.userId = el.dataset.uid; V.analytics.challengeId = null;
    viewAnalytics({ host }, el.dataset.uid);
  }));
  let deb = null;
  host.querySelector("#anSearch").addEventListener("input", async (e) => {
    clearTimeout(deb);
    deb = setTimeout(async () => {
      try {
        const r2 = await usersPage({ search: e.target.value.trim(), size: 8, page: 1 });
        resBox.innerHTML = drawList(r2.rows || []);
        resBox.querySelectorAll(".rowclick").forEach((el) => el.addEventListener("click", () => {
          V.analytics.userId = el.dataset.uid; V.analytics.challengeId = null;
          viewAnalytics({ host }, el.dataset.uid);
        }));
      } catch { /* keep previous list */ }
    }, 400);
  });
}

/* ============================================================
   7) AUDIT LOGS
   ============================================================ */
export async function viewLogs({ host }) {
  const v = V.logs;
  const rerender = () => viewLogs({ host });
  host.innerHTML = `
    ${crumbs([{ label: "پنل مدیریت", href: "overview" }, { label: "گزارش فعالیت‌ها" }])}
    <div class="adm-toolbar">
      <select id="lgAction">
        <option value="all" ${v.action === "all" ? "selected" : ""}>همه اقدامات</option>
        <option value="login" ${v.action === "login" ? "selected" : ""}>ورود مدیران</option>
        <option value="status" ${v.action === "status" ? "selected" : ""}>تغییر وضعیت حساب</option>
        <option value="role" ${v.action === "role" ? "selected" : ""}>تغییر نقش</option>
      </select>
      <span class="muted small">هر اقدام حساس (ورود، تعلیق/فعال‌سازی، تغییر نقش) همراه با مدیر انجام‌دهنده در دیتابیس ثبت می‌شود.</span>
    </div>
    <div id="lgList"><div class="adm-skeleton"><div class="sk"></div></div></div>
    <div id="lgPager"></div>`;
  host.querySelector("#lgAction").addEventListener("change", (e) => { v.action = e.target.value; v.page = 1; rerender(); });

  let res;
  try { res = await auditPage({ action: v.action, page: v.page, size: 25 }); }
  catch (e) { renderError(host, e, rerender); return; }
  const list = host.querySelector("#lgList");
  if (!res.rows.length) {
    list.innerHTML = `<div class="adm-card">${emptyState({ icon: "🧾", title: "فعالیتی ثبت نشده", sub: "پس از اولین ورود یا اقدام مدیریتی، گزارش در اینجا نمایش داده می‌شود." })}</div>`;
    return;
  }
  list.innerHTML = `<div class="adm-card"><div class="adm-table-wrap"><table>
    <thead><tr><th>زمان</th><th>مدیر</th><th>اقدام</th><th>کاربر مورد اقدام</th><th>جزئیات</th></tr></thead>
    <tbody>${res.rows.map((r) => `
      <tr>
        <td>${dt(r.o_created_at)}<div class="muted small">${rel(r.o_created_at)}</div></td>
        <td><div class="user-cell"><span class="av">${avatarLetter(r.o_actor_username)}</span><div><strong>${esc(r.o_actor_username || "—")}</strong></div></div></td>
        <td>${actionLabel(r.o_action)}</td>
        <td>${r.o_target_user ? `<a class="link" href="#/users/${esc(String(r.o_target_user))}">${esc(r.o_target_username || "کاربر حذف‌شده")}</a>` : `<span class="muted">—</span>`}</td>
        <td class="wrap"><span class="logdetails">${esc(labelDetails(r.o_action, r.o_details))}</span></td>
      </tr>`).join("")}
    </tbody></table></div></div>`;
  host.querySelector("#lgPager").innerHTML =
    paginationBar({ page: v.page, size: 25, total: res.total, onGo: (p) => { v.page = p; rerender(); } });
}

/* ============================================================
   8) ADMIN SETTINGS
   ============================================================ */
export async function viewSettings({ host }) {
  const rerender = () => viewSettings({ host });
  setLoading(host);
  let admins;
  try { admins = await usersPage({ status: "admins", size: 50, page: 1 }); }
  catch (e) { renderError(host, e, rerender); return; }
  const p = me || {};

  host.innerHTML = `
    ${crumbs([{ label: "پنل مدیریت", href: "overview" }, { label: "تنظیمات مدیریت" }])}
    <div class="adm-card">
      <div class="adm-card-head"><h3>اطلاعات مدیر فعلی</h3></div>
      <div class="adm-facts">
        <div class="f"><span>نام کاربری</span><strong>${esc(p.username || "—")}</strong></div>
        <div class="f"><span>نقش</span><strong>${p.role === "super_admin" ? "مدیر ارشد" : "مدیر"}</strong></div>
        <div class="f"><span>آخرین ورود به پنل</span><strong>${p.last_login_at ? dt(p.last_login_at) : "—"}</strong></div>
      </div>
      <p class="small muted">مدیران دسترسی خواندن به داده‌های کاربران دارند و فقط اقدامات حساس (تعلیق، تغییر نقش) را انجام می‌دهند؛ همه اقدامات در گزارش فعالیت ثبت می‌شود. «مدیر ارشد» به‌علاوه می‌تواند نقش مدیران را تغییر دهد.</p>
    </div>

    <div class="adm-card">
      <div class="adm-card-head"><h3>مدیران فعلی</h3><span class="muted small">تغییر نقش فقط با دسترسی «مدیر ارشد»</span></div>
      ${admins.rows.length ? `<div class="adm-table-wrap"><table>
        <thead><tr><th>کاربر</th><th>ایمیل</th><th>نقش</th><th>وضعیت</th><th>آخرین فعالیت</th><th>اقدام</th></tr></thead>
        <tbody>${admins.rows.map((r) => `
          <tr>
            <td><div class="user-cell"><span class="av">${avatarLetter(r.o_username)}</span><div><strong>${esc(r.o_username)}</strong></div></div></td>
            <td class="muted">${esc(r.o_email || "—")}</td>
            <td>${rolePill(r.o_role)}</td>
            <td>${accountPill(r.o_account_status)}</td>
            <td>${rel(r.o_last_seen)}</td>
            <td>${isSuper() && r.o_id !== me?.id
              ? (r.o_role === "admin"
                ? `<button class="btn btn-ghost small" data-role="user" data-uid="${esc(String(r.o_id))}" data-name="${esc(r.o_username)}" type="button">⬇ تنزیل به کاربر</button>`
                : `<button class="btn btn-ghost small" data-role="admin" data-uid="${esc(String(r.o_id))}" data-name="${esc(r.o_username)}" type="button">⬇ تنزیل به مدیر</button>`)
              : (r.o_id === me?.id ? `<span class="muted small">حساب خودتان</span>` : `<span class="muted small">—</span>`)}</td>
          </tr>`).join("")}
        </tbody></table></div>` : emptyState({ icon: "🛡️", title: "مدیری ثبت نشده", sub: "راهنمای مدیر ارشد در پایین همین صفحه را ببینید." })}
    </div>

    <div class="adm-card">
      <div class="adm-card-head"><h3>ساختار امنیتی پنل</h3></div>
      <div class="check-list">
        <div class="it"><span class="ic">✅</span><span>هر کاربر فقط داده‌های خودش را می‌بیند — سیاست‌های RLS برنامه اصلی دست‌نخورده مانده‌اند.</span></div>
        <div class="it"><span class="ic">✅</span><span>دسترسی خواندن مدیران فقط با سیاست‌های RLS و تابع امن <code>is_admin()</code> در دیتابیس اعمال می‌شود؛ نقش در فرانت‌اند هرگز مبنای امنیتی نیست.</span></div>
        <div class="it"><span class="ic">✅</span><span>ستون‌های نقش / وضعیت / فعالیت با گرنت‌های ستونی و تریگر <code>guard_profile_admin_columns</code> در برابر نوشتن مستقیم قفل‌اند.</span></div>
        <div class="it"><span class="ic">✅</span><span>تعلیق و تغییر نقش فقط با توابع امن (security-definer) انجام و در جدول <code>admin_audit_logs</code> ثبت می‌شود.</span></div>
        <div class="it"><span class="ic">✅</span><span>هر دو فرانت‌اند فقط از کلید عمومی anon استفاده می‌کنند؛ کلید service_role هرگز کد سمت کاربر قرار ندارد.</span></div>
        <div class="it"><span class="ic">✅</span><span>رکورد امتیاز هر روز (daily_scores) در لحظه ثبت توسط برنامه کاربر مهر می‌شود و پنل هیچ مسیری برای ویرایش سوابق گذشته ندارد.</span></div>
      </div>
    </div>

    ${isSuper() ? `
    <div class="adm-card">
      <div class="adm-card-head"><h3>راهنمای مدیر ارشد — افزودن مدیر جدید</h3></div>
      <p class="small muted">۱) در برنامه اصلی (index.html) برای آن شخص یک حساب عادی بسازید یا او ثبت‌نام کند. ۲) از بخش «کاربران»، دکمه <strong>«⬆ ارتقا به مدیر»</strong> را بزنید — همین کافی است و رویداد در گزارش فعالیت ثبت می‌شود. برای «مدیر ارشد» این SQL یک‌بار اجرا کنید:</p>
      <pre>update public.profiles
   set role = 'super_admin'
 where id = (select id from auth.users
             where email = 'ADMIN_EMAIL@example.com' limit 1);</pre>
    </div>` : ""}
  `;

  host.querySelectorAll("[data-role]").forEach((b) => b.addEventListener("click", async () => {
    const ok = await confirmAction({
      title: "تنزیل نقش",
      message: `نقش «${b.dataset.name}» به ${b.dataset.role === "admin" ? "مدیر" : "کاربر عادی"} تنزیل یابد؟`,
      okLabel: "تنزیل", danger: false, okClass: "btn-primary",
    });
    if (!ok) return;
    try { await setUserRole(b.dataset.uid, b.dataset.role); toast("نقش به‌روزرسانی شد.", "success"); rerender(); }
    catch (e) { toast(faError(e, "عملیات ناموفق بود."), "error"); }
  }));
}

export function clearViewCaches(cid) { if (cid) delete V.day[cid]; }
