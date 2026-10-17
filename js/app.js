// ============================================================
// Main app: Supabase Auth + challenge tracking UI (Persian, RTL).
// فرانت‌اند ایستا — همه داده‌ها در Supabase، دسترسی با RLS.
// ============================================================
import { getSupabaseConfig, saveSupabaseConfig, clearSupabaseConfig } from "./config.js";
import { getClient, resetClient } from "./sb.js";
import {
  RULES, TARGETS, MAX_MANDATORY, BONUS_PER_TASK, BONUS_CAP,
  todayStr, addDays, daysBetween, enumerateDays, parseDay,
  faNum, faDate, faShort, esc,
  rulePoints10, ruleMet, effectiveTasks, dailyResult, grade,
  dayStatus, computeStats, calcStreaks, ruleCounters,
} from "./scoring.js";
import {
  faError, signUp, signIn, signOut, getSessionUser, onAuthChange, ensureProfile, touchActivity,
  listChallenges, createChallenge, updateChallenge, deleteChallenge,
  listTasks, addTask, updateTask, renameTask, deleteTask, taskDescriptionSupported,
  listSubmissions, upsertSubmission, deleteSubmission,
  scoreRow, saveScoreRow, listScores, ensureMissedRecords,
  listSchedule, addSchedule, toggleSchedule, deleteSchedule,
  testConnection,
} from "./db.js";

const $ = (id) => document.getElementById(id);
let charts = {};
let S = { user: null, profile: null, challenges: [], activeId: null, subs: {}, tasks: [], scores: [], draft: null, draftDay: null, draftCh: null };
let calCursor = (() => { const n = new Date(); return { y: n.getFullYear(), m: n.getMonth() }; })();
let authSub = null;
function pad2(n) { return String(n).padStart(2, "0"); }

/* ---------------- helpers ---------------- */
function show(view) {
  ["view-setup", "view-auth"].forEach((v) => $(v).classList.add("hidden"));
  $("app").classList.add("hidden");
  if (view === "app") $("app").classList.remove("hidden");
  else if (view) $(view).classList.remove("hidden");
}
function loading(on, msg) {
  $("loadingMsg").textContent = msg || "در حال بارگذاری...";
  $("loading").classList.toggle("hidden", !on);
}
let toastTimer = null;
function toast(msg, type = "success") {
  const el = $("toast");
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast hidden"; }, 3500);
}
async function busy(btn, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = "صبر کنید...";
  try { await fn(); }
  finally { btn.disabled = false; btn.textContent = old; }
}
function drawChart(id, config) {
  if (typeof Chart === "undefined") return;
  if (charts[id]) charts[id].destroy();
  const el = $(id);
  if (!el) return;
  charts[id] = new Chart(el, config);
}
const chartBlue = "#2f7cff", chartGrid = "rgba(157,177,216,.15)";
function switchTab(name) {
  document.querySelectorAll(".tab[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
}
function activeChallenge() { return S.challenges.find((c) => c.id === S.activeId) || null; }
function activeKey() { return S.user ? `ddp-active-${S.user.id}` : null; }
// Shortcut for administrators only — real access is decided by the
// database; this button is pure convenience.
function showAdminLink(role) {
  if (role !== "admin" && role !== "super_admin") return;
  if ($("adminPanelBtn")) return;
  const btn = document.createElement("a");
  btn.id = "adminPanelBtn";
  btn.className = "btn btn-ghost";
  btn.href = "admin.html";
  btn.textContent = "🛡 پنل مدیریت";
  $("topActions").appendChild(btn);
}

/* ---------------- boot & routing ---------------- */
async function boot() {
  if (!getSupabaseConfig()) { show("view-setup"); return; }
  if (!getClient()) { show("view-setup"); return; }
  loading(true, "در حال بررسی نشست...");
  try {
    const user = await getSessionUser();
    if (!user) { loading(false); show("view-auth"); return; }
    await enterApp(user);
  } catch (e) {
    loading(false);
    $("setupMsg").textContent = faError(e, "اتصال به Supabase برقرار نشد.");
    $("setupBackBtn").classList.toggle("hidden", !getSupabaseConfig());
    show("view-setup");
  }
}

async function enterApp(user) {
  S.user = user;
  loading(true, "در حال دریافت اطلاعات...");
  try {
    S.profile = await ensureProfile(user);
    // Admin panel integration: suspended accounts cannot use the app
    // (admins can re-activate from the admin panel at any time).
    if (S.profile.account_status === "suspended") {
      loading(false);
      await signOut().catch(() => {});
      S.user = null; S.profile = null;
      $("loginMsg").textContent = "حساب شما توسط پنل مدیریت معلق شده است. جهت پیگیری، به پشتیبانی مراجعه کنید.";
      show("view-auth");
      return;
    }
    showAdminLink(S.profile.role);
    touchActivity(!S._touchedOnce);          // meaningful activity ping (login → true)
    S._touchedOnce = true;                   // avoid double login marking
    S.challenges = await listChallenges();
  } catch (e) {
    loading(false);
    S.user = null;
    $("setupMsg").textContent = faError(e, "دریافت اطلاعات ناموفق بود.");
    $("setupBackBtn").classList.toggle("hidden", !getSupabaseConfig());
    show("view-setup");
    return;
  }
  if (authSub) { try { authSub.unsubscribe(); } catch { /* ignore */ } }
  try {
    const sub = onAuthChange((u) => {
      if (!u && S.user) {
  S = { user: null, profile: null, challenges: [], activeId: null, subs: {}, tasks: [], scores: [], draft: null, draftDay: null, draftCh: null };
        show("view-auth");
      }
    });
    authSub = sub?.data?.subscription || null;
  } catch { /* ignore */ }
  $("currentUserLabel").textContent = `👤 ${S.profile.username}`;
  S.activeId = localStorage.getItem(activeKey()) || S.challenges[0]?.id || null;
  if (!S.challenges.find((c) => c.id === S.activeId)) S.activeId = S.challenges[0]?.id || null;
  loading(false);
  show("app");
  if (!S.challenges.length) { openGate(); return; }
  closeGate();
  await loadChallengeData();
  renderAll();
}

async function loadChallengeData() {
  const ch = activeChallenge();
  if (!ch) return;
  loading(true, "در حال دریافت داده‌های چالش...");
  try {
    const [subs, tasks] = await Promise.all([listSubmissions(ch.id), listTasks(ch.id)]);
    S.subs = subs;
    S.tasks = tasks;
    S.draft = null; S.draftDay = null; S.draftCh = null;
    try { await ensureMissedRecords(ch, subs, tasks); } catch { /* non-fatal */ }
    S.scores = await listScores(ch.id);
  } finally { loading(false); }
}

/* ---------------- setup screen ---------------- */
$("setupTestBtn").addEventListener("click", () => busy($("setupTestBtn"), async () => {
  const url = $("setupUrl").value.trim(), key = $("setupKey").value.trim();
  if (!url || !key) { $("setupMsg").textContent = "هر دو فیلد را وارد کنید."; return; }
  saveSupabaseConfig(url, key);
  resetClient();
  try {
    await testConnection();
    $("setupMsg").textContent = "اتصال موفق بود ✓";
    await boot();
  } catch (e) {
    $("setupMsg").textContent = faError(e, "اتصال ناموفق بود.");
  }
}));

/* ---------------- auth screen ---------------- */
$("authTabLogin").addEventListener("click", () => {
  $("authTabLogin").classList.add("active"); $("authTabRegister").classList.remove("active");
  $("loginPane").classList.remove("hidden"); $("registerPane").classList.add("hidden");
});
$("authTabRegister").addEventListener("click", () => {
  $("authTabRegister").classList.add("active"); $("authTabLogin").classList.remove("active");
  $("registerPane").classList.remove("hidden"); $("loginPane").classList.add("hidden");
});
$("loginBtn").addEventListener("click", () => busy($("loginBtn"), async () => {
  $("loginMsg").textContent = "";
  const email = $("loginEmail").value.trim(), pass = $("loginPass").value;
  if (!email || !pass) { $("loginMsg").textContent = "ایمیل و رمز عبور را وارد کنید."; return; }
  try {
    loading(true, "در حال ورود...");
    await signIn(email, pass);
    const user = await getSessionUser();
    await enterApp(user);
  } catch (e) { $("loginMsg").textContent = faError(e); }
  finally { loading(false); }
}));
$("regBtn").addEventListener("click", () => busy($("regBtn"), async () => {
  $("regMsg").textContent = "";
  const name = $("regName").value.trim(), email = $("regEmail").value.trim();
  const p1 = $("regPass").value, p2 = $("regPass2").value;
  if (name.length < 2) { $("regMsg").textContent = "نام کاربری حداقل ۲ کاراکتر باشد."; return; }
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("regMsg").textContent = "ایمیل معتبر وارد کنید."; return; }
  if (p1.length < 6) { $("regMsg").textContent = "رمز عبور باید حداقل ۶ کاراکتر باشد."; return; }
  if (p1 !== p2) { $("regMsg").textContent = "تکرار رمز عبور مطابقت ندارد."; return; }
  try {
    loading(true, "در حال ساخت حساب...");
    const r = await signUp(email, p1, name);
    if (r.needsConfirmation) {
      $("regMsg").textContent = "حساب ساخته شد. ایمیل تأیید را بررسی کنید، سپس وارد شوید.";
      return;
    }
    const user = await getSessionUser();
    await enterApp(user);
  } catch (e) { $("regMsg").textContent = faError(e); }
  finally { loading(false); }
}));
$("logoutBtn").addEventListener("click", async () => {
  await signOut().catch(() => {});
  S = { user: null, profile: null, challenges: [], activeId: null, subs: {}, tasks: [], scores: [] };
  show("view-auth");
});
$("settingsBtn").addEventListener("click", () => {
  const cfg = getSupabaseConfig();
  if (cfg) { $("setupUrl").value = cfg.url; $("setupKey").value = cfg.anonKey; }
  $("setupMsg").textContent = "";
  $("setupBackBtn").classList.remove("hidden");
  show("view-setup");
});
$("setupBackBtn").addEventListener("click", () => { boot(); });
$("authSetupBtn").addEventListener("click", () => {
  const cfg = getSupabaseConfig();
  if (cfg) { $("setupUrl").value = cfg.url; $("setupKey").value = cfg.anonKey; }
  $("setupMsg").textContent = "";
  $("setupBackBtn").classList.remove("hidden");
  show("view-setup");
});

/* ---------------- challenge gate ---------------- */
function openGate() {
  $("view-gate").classList.remove("hidden");
  if (!$("gStart").value) $("gStart").value = todayStr();
}
function closeGate() { $("view-gate").classList.add("hidden"); }
$("gateCreateBtn").addEventListener("click", () => busy($("gateCreateBtn"), async () => {
  const r = await tryCreateChallenge($("gName").value, $("gStart").value, $("gGoal").value);
  if (r.error) { $("gMsg").textContent = r.error; return; }
  $("gName").value = ""; $("gGoal").value = "";
  closeGate();
  switchTab("dashboard");
}));
async function tryCreateChallenge(name, startDate, goalName) {
  name = (name || "").trim();
  if (!name) return { error: "لطفاً نام چالش را وارد کنید." };
  if (!startDate) return { error: "لطفاً تاریخ شروع چالش را انتخاب کنید." };
  if (startDate > todayStr()) return { error: "تاریخ شروع نمی‌تواند در آینده باشد؛ پیگیری از تاریخ شروع آغاز می‌شود." };
  const ch = await createChallenge(name, startDate, (goalName || "").trim());
  S.challenges.push(ch);
  S.activeId = ch.id;
  localStorage.setItem(activeKey(), ch.id);
  renderChallengeBar();
  await loadChallengeData();
  renderAll();
  return { challenge: ch };
}

/* ---------------- challenge bar & tab ---------------- */
function renderChallengeBar() {
  const sel = $("challengeSelect");
  sel.innerHTML = S.challenges.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("") || `<option value="">— بدون چالش —</option>`;
  sel.value = S.activeId || "";
}
$("challengeSelect").addEventListener("change", async (e) => {
  S.activeId = e.target.value;
  localStorage.setItem(activeKey(), S.activeId);
  await loadChallengeData();
  renderAll();
});
$("newChallengeBtn").addEventListener("click", () => switchTab("challenges"));
$("createChallengeBtn").addEventListener("click", () => busy($("createChallengeBtn"), async () => {
  try {
    const r = await tryCreateChallenge($("cName").value, $("cStart").value || todayStr(), $("cGoal").value);
    if (r.error) { $("cMsg").textContent = r.error; return; }
    $("cName").value = ""; $("cGoal").value = "";
    $("cMsg").textContent = `چالش «${r.challenge.name}» ساخته شد؛ پیگیری از ${faShort(r.challenge.start_date)} آغاز شد.`;
    setTimeout(() => ($("cMsg").textContent = ""), 4000);
  } catch (e) { $("cMsg").textContent = faError(e); }
}));
$("saveChallengeBtn").addEventListener("click", () => busy($("saveChallengeBtn"), async () => {
  const ch = activeChallenge(); if (!ch) return;
  const name = $("eName").value.trim();
  if (!name) { $("eMsg").textContent = "نام چالش نمی‌تواند خالی باشد."; return; }
  if (!$("eStart").value || $("eStart").value > todayStr()) { $("eMsg").textContent = "تاریخ شروع معتبر نیست."; return; }
  try {
    const upd = await updateChallenge(ch.id, { name, start_date: $("eStart").value, goal_name: $("eGoal").value.trim() });
    Object.assign(ch, upd);
    await loadChallengeData();
    renderAll();
    $("eMsg").textContent = "تغییرات ذخیره شد.";
  } catch (e) { $("eMsg").textContent = faError(e); }
}));
$("deleteChallengeBtn").addEventListener("click", () => busy($("deleteChallengeBtn"), async () => {
  const ch = activeChallenge(); if (!ch) return;
  if (S.challenges.length <= 1) { alert("نمی‌توانید تنها چالش خود را حذف کنید؛ ابتدا یک چالش جدید بسازید."); return; }
  if (!confirm(`چالش «${ch.name}» و همه سوابق آن حذف شود؟`)) return;
  try {
    await deleteChallenge(ch.id);
    S.challenges = S.challenges.filter((c) => c.id !== ch.id);
    S.activeId = S.challenges[0].id;
    localStorage.setItem(activeKey(), S.activeId);
    await loadChallengeData();
    renderAll();
  } catch (e) { $("eMsg").textContent = faError(e); }
}));
$("addCustomTaskBtn").addEventListener("click", () => busy($("addCustomTaskBtn"), async () => {
  const ch = activeChallenge(); if (!ch) return;
  const title = $("customTaskTitle").value.trim();
  if (!title) { alert("عنوان وظیفه را وارد کنید."); return; }
  try {
    await addTask(ch.id, title);
    $("customTaskTitle").value = "";
    S.tasks = await listTasks(ch.id);
    renderAll();
  } catch (e) { alert(faError(e)); }
}));

async function renderChallenges() {
  const ch = activeChallenge();
  if ($("cStart") && !$("cStart").value) $("cStart").value = todayStr();
  if (ch) { $("eName").value = ch.name; $("eStart").value = ch.start_date; $("eGoal").value = ch.goal_name || ""; }
  // per-challenge mini stats (parallel, small N)
  const cards = await Promise.all(S.challenges.map(async (c) => {
    try {
      const [subs, tasks] = await Promise.all([listSubmissions(c.id), listTasks(c.id)]);
      const st = computeStats({ startDate: c.start_date, today: todayStr(), submissions: subs, tasks });
      return { c, st, err: null };
    } catch (e) { return { c, st: null, err: e }; }
  }));
  $("challengeList").innerHTML = cards.map(({ c, st, err }) => {
    const meta = err ? faError(err, "خطا در دریافت آمار")
      : `شروع: ${faShort(c.start_date)} · ثبت‌شده: ${faNum(st.submitted.length)} · از دست رفته: ${faNum(st.missed.length)} · امتیاز کلی: ${faNum(st.overallScore)}${c.goal_name ? " · هدف: " + esc(c.goal_name) : ""}`;
    return `<div class="chal-item ${c.id === S.activeId ? "active" : ""}">
      <div><strong>${esc(c.name)}</strong>${c.id === S.activeId ? ' <span class="pill done">فعال</span>' : ""}
      <div class="meta">${meta}</div></div>
      <div class="row"><button class="btn btn-ghost small" data-use="${c.id}" type="button">فعال‌سازی</button></div>
    </div>`;
  }).join("") || `<p class="muted">چالشی وجود ندارد.</p>`;
  document.querySelectorAll("[data-use]").forEach((b) => b.onclick = async () => {
    S.activeId = b.dataset.use;
    localStorage.setItem(activeKey(), S.activeId);
    await loadChallengeData();
    renderAll();
  });
  $("customTaskList").innerHTML = (S.tasks || []).map((t) =>
    `<li data-ct="${t.id}"><span class="title">📌 ${esc(t.title)}${t.description ? ` <span class="muted small">— ${esc(t.description)}</span>` : ""}</span><span class="spacer"></span><button class="btn btn-ghost small" data-editct="${t.id}" type="button">ویرایش</button><button class="btn btn-danger-ghost small" data-delct="${t.id}" type="button">✕</button></li>`
  ).join("") || `<li class="muted">وظیفه اختیاری‌ای تعریف نشده است.</li>`;
  document.querySelectorAll("[data-delct]").forEach((b) => b.onclick = async () => {
    if (!confirm("این وظیفه اختیاری حذف شود؟ (سوابق روزهای گذشته حفظ می‌شود)")) return;
    try { await deleteTask(b.dataset.delct); S.tasks = await listTasks(activeChallenge().id); renderAll(); }
    catch (e) { alert(faError(e)); }
  });
  document.querySelectorAll("[data-editct]").forEach((b) => b.onclick = () => {
    const t = S.tasks.find((x) => x.id === b.dataset.editct);
    const li = document.querySelector(`li[data-ct="${t.id}"]`);
    const descOn = taskDescriptionSupported();
    li.innerHTML = `<input type="text" id="editCtInput" maxlength="120" value="${esc(t.title)}" />${descOn ? `<input type="text" id="editCtDesc" maxlength="200" value="${esc(t.description || "")}" placeholder="توضیح..." />` : ""}<span class="spacer"></span><button class="btn btn-primary small" id="saveCtEdit" type="button">ذخیره</button>`;
    $("saveCtEdit").onclick = async () => {
      const v = $("editCtInput").value.trim();
      if (!v) { alert("عنوان وظیفه نمی‌تواند خالی باشد."); return; }
      const patch = { title: v };
      if (descOn) patch.description = $("editCtDesc").value.trim();
      try { await updateTask(t.id, patch); S.tasks = await listTasks(activeChallenge().id); S.draft = null; renderAll(); toast("وظیفه ذخیره شد.", "success"); }
      catch (e) { toast(faError(e), "error"); }
    };
  });
}

/* ---------------- dashboard ---------------- */
function renderDashboard() {
  const ch = activeChallenge();
  const t = todayStr();
  $("todayPill").textContent = faDate(t);
  $("greetTitle").textContent = `سلام، ${S.profile.username} 👋`;
  $("greetSub").textContent = `چالش «${ch.name}» · شروع از ${faShort(ch.start_date)}` + (ch.goal_name ? ` · هدف: ${ch.goal_name}` : "");

  const stats = computeStats({ startDate: ch.start_date, today: t, submissions: S.subs, tasks: S.tasks });
  const entry = S.subs[t];
  const ring = $("todayRing"), C = 327;
  if (t < ch.start_date) {
    $("todayScore").textContent = "–"; $("todayGrade").textContent = "هنوز شروع نشده";
    $("todayDetail").textContent = `چالش از ${faShort(ch.start_date)} شروع می‌شود.`;
    ring.style.strokeDashoffset = C;
  } else if (entry) {
    const r = dailyResult(entry, effectiveTasks(S.tasks, t));
    $("todayScore").textContent = faNum(r.pct);
    $("todayGrade").textContent = grade(r.pct);
    $("todayDetail").textContent = `${faNum(r.points)} از ${faNum(MAX_MANDATORY)} امتیاز · ${faNum(r.met)} از ${faNum(r.of)} قانون · تشویقی ‎+${faNum(r.bonus)}`;
    ring.style.strokeDashoffset = C - (C * r.pct) / 100;
    ring.style.stroke = r.pct >= 75 ? "#22c55e" : r.pct >= 50 ? "#f59e0b" : "#ef4444";
  } else {
    $("todayScore").textContent = "–"; $("todayGrade").textContent = "هنوز ثبت نشده";
    $("todayDetail").textContent = "نتیجه امروز را ثبت کنید تا امتیاز بگیرید.";
    ring.style.strokeDashoffset = C; ring.style.stroke = "#2f7cff";
  }

  $("overallScore").textContent = faNum(stats.overallScore) + " از ۱۰۰";
  $("streakNow").textContent = faNum(stats.streaks.cur);
  $("streakBest").textContent = faNum(stats.streaks.best);
  $("completionPct").textContent = "٪" + faNum(stats.completionPct);
  $("completionSub").textContent = `${faNum(stats.submitted.length)} از ${faNum(stats.elapsedDays)} روز ثبت شده`;
  $("completionBar").style.width = stats.completionPct + "%";
  $("missedCount").textContent = stats.missed.length
    ? `${faNum(stats.missed.length)} روز از دست رفته: ${stats.missed.slice(-3).map(faShort).join("، ")}`
    : "روز از دست رفته‌ای ندارید. آفرین!";
  $("avgScore").textContent = stats.avgSubmitted === null ? "–" : faNum(stats.avgSubmitted) + " از ۱۰۰";
  $("rulesHitRate").textContent = `${faNum(stats.perfectDays)} کامل · ‎+${faNum(stats.totalBonus)} تشویقی`;

  const banner = $("missedBanner");
  if (stats.missed.length) {
    banner.classList.remove("hidden");
    banner.innerHTML = `⚠️ <strong>${faNum(stats.missed.length)} روز از دست رفته</strong>: ${stats.missed.slice(-5).reverse().map((d) => esc(faShort(d))).join("، ")}. این روزها با امتیاز صفر در امتیاز کلی چالش حساب شده‌اند.`;
  } else banner.classList.add("hidden");

  const eff = effectiveTasks(S.tasks, t);
  let rows = RULES.map((r) => {
    const ok = entry ? ruleMet(entry, r.key) : false;
    const st = entry ? (ok ? "انجام شد ✓" : "ناموفق ✕") : (t < ch.start_date ? "—" : "در انتظار");
    const cls = entry ? (ok ? "done" : "miss") : (t < ch.start_date ? "none" : "pending");
    return `<div class="rule-row"><span>${r.ico} ${r.title}</span><span class="pill ${cls}">${st}</span></div>`;
  }).join("");
  rows += eff.map((ct) => {
    const on = entry && entry.custom_states && entry.custom_states[ct.id];
    const st = entry ? (on ? "انجام شد ✓" : "ناموفق") : (t < ch.start_date ? "—" : "در انتظار");
    const cls = entry ? (on ? "done" : "miss") : (t < ch.start_date ? "none" : "pending");
    return `<div class="rule-row"><span>📌 ${esc(ct.title)}</span><span class="pill ${cls}">${st}</span></div>`;
  }).join("");
  $("todayRules").innerHTML = rows;

  const labels = [], data = [];
  for (let i = 13; i >= 0; i--) {
    const d = addDays(t, -i);
    labels.push(d.slice(5));
    data.push(S.subs[d] ? dailyResult(S.subs[d], effectiveTasks(S.tasks, d)).pct : null);
  }
  drawChart("miniChart", {
    type: "line",
    data: { labels, datasets: [{ data, borderColor: chartBlue, backgroundColor: "rgba(47,124,255,.2)", fill: true, spanGaps: true, tension: .35, pointRadius: 3 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, grid: { color: chartGrid }, ticks: { color: "#9db1d8" } }, x: { reverse: true, grid: { display: false }, ticks: { color: "#9db1d8", maxTicksLimit: 7 } } } },
  });
  const recent = [];
  for (let i = 0; i < 7; i++) {
    const d = addDays(t, -i);
    const en = S.subs[d];
    let right;
    if (en) { const r = dailyResult(en, effectiveTasks(S.tasks, d)); right = `${faNum(r.pct)} · ${grade(r.pct)}`; }
    else if (d < ch.start_date) right = '<span class="muted">قبل از شروع</span>';
    else if (d === t) right = '<span class="muted">در انتظار ثبت</span>';
    else right = '<span class="muted">از دست رفته</span>';
    recent.push(`<div class="recent-item"><span>${faShort(d)}${d === t ? " (امروز)" : ""}</span><strong>${right}</strong></div>`);
  }
  $("recentList").innerHTML = recent.join("");
}

/* ---------------- dashboard quick track & customizer ---------------- */
const RULE_TARGETS_FA = {
  reading: "۱۰ صفحه", exercise: "۶۰ دقیقه", goal: "۶۰ دقیقه",
  wake: "قبل از ۹:۰۰", noAlcohol: "عدم مصرف", noSmoke: "دوری از دود",
};
function blankDraft() {
  return { reading_pages: 0, exercise_minutes: 0, goal_minutes: 0, wake_time: "", no_alcohol: false, no_smoke: false, custom_states: {}, notes: "" };
}
function getDraft() {
  const ch = activeChallenge();
  const t = todayStr();
  if (!ch) return blankDraft();
  if (!S.draft || S.draftDay !== t || S.draftCh !== ch.id) {
    const e = S.subs[t];
    S.draft = e
      ? { reading_pages: e.reading_pages || 0, exercise_minutes: e.exercise_minutes || 0, goal_minutes: e.goal_minutes || 0, wake_time: e.wake_time || "", no_alcohol: !!e.no_alcohol, no_smoke: !!e.no_smoke, custom_states: { ...(e.custom_states || {}) }, notes: e.notes || "" }
      : blankDraft();
    S.draftDay = t; S.draftCh = ch.id;
  }
  return S.draft;
}
function toggleDraftRule(key) {
  const d = getDraft();
  if (key === "reading") d.reading_pages = (Number(d.reading_pages) || 0) >= TARGETS.reading ? 0 : TARGETS.reading;
  else if (key === "exercise") d.exercise_minutes = (Number(d.exercise_minutes) || 0) >= TARGETS.exercise ? 0 : TARGETS.exercise;
  else if (key === "goal") d.goal_minutes = (Number(d.goal_minutes) || 0) >= TARGETS.goal ? 0 : TARGETS.goal;
  else if (key === "wake") d.wake_time = (d.wake_time && d.wake_time < TARGETS.wake) ? "" : "08:00";
  else if (key === "noAlcohol") d.no_alcohol = !d.no_alcohol;
  else if (key === "noSmoke") d.no_smoke = !d.no_smoke;
  renderQuickToday();
}
function toggleDraftTask(taskId) {
  const d = getDraft();
  d.custom_states[taskId] = !d.custom_states[taskId];
  renderQuickToday();
}
function renderQuickToday() {
  const ch = activeChallenge();
  if (!ch || !$("qRules")) return;
  const t = todayStr();
  const notStarted = t < ch.start_date;
  const d = getDraft();
  const eff = notStarted ? [] : effectiveTasks(S.tasks, t);
  const r = dailyResult(d, eff);
  $("qScore").textContent = notStarted ? "" : `پیش‌نمایش: ${faNum(r.pct)} از ۱۰۰ · تشویقی ‎+${faNum(r.bonus)}`;
  $("qRules").innerHTML = RULES.map((rule) => {
    const met = !notStarted && ruleMet(d, rule.key);
    return `<div class="rule-row"><span>${rule.ico} ${rule.title} <em class="muted">(${RULE_TARGETS_FA[rule.key]})</em></span><button class="toggle ${met ? "on" : "off"}" data-qtoggle="${rule.key}" type="button" ${notStarted ? "disabled" : ""}>${met ? "انجام شد ✓" : "انجام نشد"}</button></div>`;
  }).join("");
  $("qCustom").innerHTML = notStarted
    ? `<p class="muted small">چالش هنوز شروع نشده است.</p>`
    : eff.map((ct) => {
      const on = !!d.custom_states[ct.id];
      return `<div class="rule-row"><span>📌 ${esc(ct.title)}${ct.description ? `<br><em class="muted small">${esc(ct.description)}</em>` : ""}</span><button class="toggle ${on ? "on" : "off"}" data-qtask="${ct.id}" type="button">${on ? "انجام شد ✓" : "انجام نشد"}</button></div>`;
    }).join("") || `<p class="muted small">وظیفه اختیاری‌ای برای امروز وجود ندارد — از کادر زیر اضافه کنید.</p>`;
  $("qSaveBtn").disabled = notStarted;
  document.querySelectorAll("[data-qtoggle]").forEach((b) => b.onclick = () => toggleDraftRule(b.dataset.qtoggle));
  document.querySelectorAll("[data-qtask]").forEach((b) => b.onclick = () => toggleDraftTask(b.dataset.qtask));
}
$("qSaveBtn").addEventListener("click", () => busy($("qSaveBtn"), async () => {
  const ch = activeChallenge(); if (!ch) return;
  const t = todayStr();
  if (t < ch.start_date) { toast("چالش هنوز شروع نشده است.", "error"); return; }
  const d = getDraft();
  d.notes = (S.subs[t] && S.subs[t].notes) || "";
  try {
    loading(true, "در حال ذخیره...");
    await upsertSubmission(ch.id, t, d); // سطر یکتا (challenge_id, day) — ثبت تکراری ممکن نیست
    await saveScoreRow(scoreRow(ch.id, t, d, S.tasks));
    const [subs, scores] = await Promise.all([listSubmissions(ch.id), listScores(ch.id)]);
    S.subs = subs; S.scores = scores;
    S.draft = null;
    $("customChecklist").dataset.ch = "";
    renderAll();
    const r = dailyResult(d, effectiveTasks(S.tasks, t));
    toast(`نتیجه امروز ذخیره شد — ${faNum(r.points)} از ${faNum(MAX_MANDATORY)} (${grade(r.pct)}) · تشویقی ‎+${faNum(r.bonus)}`, "success");
  } catch (e) { toast(faError(e, "ذخیره ناموفق بود."), "error"); }
  finally { loading(false); }
}));
$("qAddBtn").addEventListener("click", () => busy($("qAddBtn"), async () => {
  const ch = activeChallenge(); if (!ch) return;
  const title = $("qNewTask").value.trim();
  if (!title) { toast("عنوان وظیفه را وارد کنید.", "error"); return; }
  try {
    await addTask(ch.id, title, "");
    $("qNewTask").value = "";
    S.tasks = await listTasks(ch.id);
    renderAll();
    toast("وظیفه اختیاری اضافه شد.", "success");
  } catch (e) { toast(faError(e), "error"); }
}));
function renderCustomizer() {
  const ch = activeChallenge();
  if (!ch || !$("custList")) return;
  const descOn = taskDescriptionSupported();
  const descField = $("custDesc").closest(".field");
  if (descField) descField.style.display = descOn ? "" : "none";
  $("custList").innerHTML = (S.tasks || []).map((t) => {
    if (t._editing) {
      return `<li data-ct="${t.id}"><div class="cust-edit"><input type="text" id="custEditTitle" maxlength="120" value="${esc(t.title)}" />${descOn ? `<input type="text" id="custEditDesc" maxlength="200" value="${esc(t.description || "")}" placeholder="توضیح..." />` : ""}<span class="spacer"></span><button class="btn btn-primary small" id="custSaveEdit" type="button">ذخیره</button><button class="btn btn-ghost small" id="custCancelEdit" type="button">انصراف</button></div></li>`;
    }
    return `<li data-ct="${t.id}"><div class="cust-view"><span class="title">📌 ${esc(t.title)}</span>${t.description ? `<span class="muted small">${esc(t.description)}</span>` : ""}<span class="spacer"></span><button class="btn btn-ghost small" data-custedit="${t.id}" type="button">ویرایش</button><button class="btn btn-danger-ghost small" data-custdel="${t.id}" type="button">✕</button></div></li>`;
  }).join("") || `<li class="muted">وظیفه‌ای تعریف نشده است.</li>`;
  document.querySelectorAll("[data-custdel]").forEach((b) => b.onclick = async () => {
    if (!confirm("این وظیفه حذف شود؟ سوابق روزهای گذشته حفظ می‌شود.")) return;
    try {
      await deleteTask(b.dataset.custdel);
      S.tasks = await listTasks(ch.id);
      S.draft = null;
      renderAll();
      toast("وظیفه حذف شد.", "success");
    } catch (e) { toast(faError(e), "error"); }
  });
  document.querySelectorAll("[data-custedit]").forEach((b) => b.onclick = () => {
    S.tasks.forEach((x) => { x._editing = x.id === b.dataset.custedit; });
    renderCustomizer();
  });
  const saveBtn = $("custSaveEdit");
  if (saveBtn) saveBtn.onclick = async () => {
    const t = S.tasks.find((x) => x._editing);
    const title = $("custEditTitle").value.trim();
    if (!title) { toast("عنوان وظیفه نمی‌تواند خالی باشد.", "error"); return; }
    const patch = { title };
    if (descOn) patch.description = $("custEditDesc").value.trim();
    try {
      await updateTask(t.id, patch);
      S.tasks = await listTasks(ch.id);
      renderAll();
      toast("وظیفه ذخیره شد.", "success");
    } catch (e) { toast(faError(e), "error"); }
  };
  const cancelBtn = $("custCancelEdit");
  if (cancelBtn) cancelBtn.onclick = () => {
    S.tasks.forEach((x) => { x._editing = false; });
    renderCustomizer();
  };
}
$("custAddBtn").addEventListener("click", () => busy($("custAddBtn"), async () => {
  const ch = activeChallenge(); if (!ch) return;
  const title = $("custTitle").value.trim();
  if (!title) { toast("عنوان وظیفه را وارد کنید.", "error"); return; }
  try {
    await addTask(ch.id, title, taskDescriptionSupported() ? $("custDesc").value.trim() : "");
    $("custTitle").value = ""; $("custDesc").value = "";
    S.tasks = await listTasks(ch.id);
    renderAll();
    toast("وظیفه اختیاری اضافه شد.", "success");
  } catch (e) { toast(faError(e), "error"); }
}));

/* ---------------- check-in ---------------- */
function formEntry() {
  return {
    reading_pages: Math.max(0, Number($("inReading").value) || 0),
    exercise_minutes: Math.max(0, Number($("inExercise").value) || 0),
    goal_minutes: Math.max(0, Number($("inGoal").value) || 0),
    wake_time: $("inWake").value || "",
    no_alcohol: $("inNoAlcohol").checked,
    no_smoke: $("inNoSmoke").checked,
    custom_states: Object.fromEntries([...document.querySelectorAll("[data-custom]")].map((cb) => [cb.dataset.custom, cb.checked])),
    notes: "",
  };
}
function updateLive() {
  const ch = activeChallenge(); if (!ch) return;
  const d = $("entryDate").value || todayStr();
  const v = formEntry();
  const r = dailyResult(v, effectiveTasks(S.tasks, d));
  $("liveScore").textContent = `${faNum(r.pct)} از ۱۰۰`;
  $("liveGrade").textContent = grade(r.pct);
  $("liveRules").textContent = `${faNum(r.met)} از ${faNum(r.of)}`;
  $("liveBonus").textContent = `+${faNum(r.bonus)}`;
  $("hintReading").textContent = v.reading_pages >= 10 ? `✓ ‎+۱۰ (هدف محقق شد)` : `‎+${faNum(Math.floor((v.reading_pages / 10) * 10))} — ${faNum(10 - v.reading_pages)} صفحه تا هدف مانده`;
  $("hintExercise").textContent = v.exercise_minutes >= 60 ? `✓ ‎+۱۰` : `‎+${faNum(Math.floor((v.exercise_minutes / 60) * 10))} — ${faNum(60 - v.exercise_minutes)} دقیقه مانده`;
  $("hintGoal").textContent = v.goal_minutes >= 60 ? `✓ ‎+۱۰` : `‎+${faNum(Math.floor((v.goal_minutes / 60) * 10))} — ${faNum(60 - v.goal_minutes)} دقیقه مانده`;
  $("hintWake").textContent = !v.wake_time ? "ساعت بیدار شدن را وارد کنید" : (v.wake_time < TARGETS.wake ? "✓ ‎+۱۰ — قبل از ۹ صبح" : "‎−۱۰ — بعد از ۹ صبح");
  const names = { reading: "📖 مطالعه", exercise: "🏃 ورزش", goal: "🎯 هدف", wake: "⏰ بیداری", noAlcohol: "🍺 الکل", noSmoke: "🚭 دود" };
  let html = r.perRule.map((p) => {
    const got = p.met;
    return `<div class="rule-row"><span>${names[p.key]}</span><span class="pts ${got ? "pos" : "neg"}">${got ? `‎+${faNum(p.points)}` : (p.points > 0 ? `‎+${faNum(p.points)} (ناقص)` : `‎−${faNum(10)}`)}</span></div>`;
  }).join("");
  if (r.optTotal) html += `<div class="rule-row"><span>📌 وظایف اختیاری (${faNum(r.optDone)} از ${faNum(r.optTotal)})</span><span class="pts pos">‎+${faNum(r.bonus)} تشویقی</span></div>`;
  $("breakdownPreview").innerHTML = html;
}
function renderCustomChecklist(entry) {
  const d = $("entryDate").value || todayStr();
  const tasks = effectiveTasks(S.tasks, d);
  $("customChecklist").innerHTML = tasks.map((t) => {
    const on = entry && entry.custom_states && entry.custom_states[t.id];
    return `<div class="rule-row"><span>📌 ${esc(t.title)}${t.description ? `<br><em class="muted small">${esc(t.description)}</em>` : ""}</span><span class="check-row"><input type="checkbox" data-custom="${t.id}" ${on ? "checked" : ""} /><label>انجام شد</label></span></div>`;
  }).join("") || `<p class="muted small">وظیفه اختیاری‌ای برای این روز تعریف نشده است. از داشبورد یا بخش «چالش‌ها» اضافه کنید.</p>`;
  document.querySelectorAll("[data-custom]").forEach((cb) => cb.addEventListener("change", updateLive));
}
function loadEntryIntoForm() {
  const ch = activeChallenge();
  const d = $("entryDate").value || todayStr();
  const e = S.subs[d];
  $("inReading").value = e?.reading_pages ?? "";
  $("inExercise").value = e?.exercise_minutes ?? "";
  $("inGoal").value = e?.goal_minutes ?? "";
  $("inWake").value = e?.wake_time ?? "";
  $("inNoAlcohol").checked = !!e?.no_alcohol;
  $("inNoSmoke").checked = !!e?.no_smoke;
  $("inNotes").value = e?.notes ?? "";
  renderCustomChecklist(e);
  updateLive();
}
function renderCheckin() {
  const ch = activeChallenge();
  const ed = $("entryDate");
  ed.min = ch.start_date; ed.max = todayStr();
  if (!ed.value || ed.value < ch.start_date) ed.value = todayStr() < ch.start_date ? ch.start_date : todayStr();
  if ($("customChecklist").dataset.ch !== ch.id + ed.value) {
    $("customChecklist").dataset.ch = ch.id + ed.value;
    loadEntryIntoForm();
  }
  updateLive();
  const byDay = {};
  for (const s of S.scores) byDay[s.day] = s;
  const rows = Object.keys(byDay).sort().reverse().slice(0, 60);
  $("historyBody").innerHTML = rows.map((d) => {
    const s = byDay[d];
    const pill = s.status === "submitted"
      ? `<span class="pill ${s.mandatory_pct === 100 ? "done" : "miss"}">${s.mandatory_pct === 100 ? "کامل" : "ناقص"}</span>`
      : `<span class="pill miss">از دست رفته</span>`;
    return `<tr><td>${faShort(d)}</td><td>${s.status === "submitted" ? `${faNum(s.mandatory_points)} از ${faNum(MAX_MANDATORY)}` : "—"}</td><td>${s.status === "submitted" ? faNum(s.mandatory_pct) : "۰"}</td><td>${s.bonus_points ? "+" + faNum(s.bonus_points) : "—"}</td><td>${s.optional_total ? `${faNum(s.optional_done)}/${faNum(s.optional_total)}` : "—"}</td><td>${esc(s.grade)}</td><td>${pill}</td></tr>`;
  }).join("") || `<tr><td colspan="7" class="muted">هنوز رکوردی در این چالش ثبت نشده است.</td></tr>`;
}
["inReading", "inExercise", "inGoal"].forEach((id) => $(id).addEventListener("input", updateLive));
$("inWake").addEventListener("input", updateLive);
$("inNoAlcohol").addEventListener("change", updateLive);
$("inNoSmoke").addEventListener("change", updateLive);
$("entryDate").addEventListener("change", () => { $("customChecklist").dataset.ch = ""; loadEntryIntoForm(); });
$("saveEntryBtn").addEventListener("click", () => busy($("saveEntryBtn"), async () => {
  const ch = activeChallenge(); if (!ch) return;
  const d = $("entryDate").value || todayStr();
  if (d > todayStr()) { $("saveMsg").textContent = "فقط امروز و روزهای گذشته قابل ثبت‌اند."; return; }
  if (d < ch.start_date) { $("saveMsg").textContent = `این روز قبل از شروع چالش (${faShort(ch.start_date)}) است.`; return; }
  try {
    const v = formEntry();
    v.notes = $("inNotes").value.trim();
    loading(true, "در حال ذخیره...");
    await upsertSubmission(ch.id, d, v);
    await saveScoreRow(scoreRow(ch.id, d, v, S.tasks));
    const [subs, scores] = await Promise.all([listSubmissions(ch.id), listScores(ch.id)]);
    S.subs = subs; S.scores = scores;
    renderAll();
    $("entryDate").value = d;
    const r = dailyResult(v, effectiveTasks(S.tasks, d));
    $("saveMsg").textContent = `ثبت ${faShort(d)} ذخیره شد — ${faNum(r.points)} از ${faNum(MAX_MANDATORY)} (${grade(r.pct)}) · تشویقی ‎+${faNum(r.bonus)}.`;
  } catch (e) { $("saveMsg").textContent = faError(e, "ذخیره ناموفق بود."); }
  finally { loading(false); }
}));
$("clearEntryBtn").addEventListener("click", () => busy($("clearEntryBtn"), async () => {
  const ch = activeChallenge(); if (!ch) return;
  const d = $("entryDate").value || todayStr();
  if (!S.subs[d]) { $("saveMsg").textContent = "برای این روز ثبتی وجود ندارد."; return; }
  if (!confirm(`ثبت روز ${faShort(d)} حذف شود؟ این روز «از دست رفته» حساب می‌شود.`)) return;
  try {
    loading(true, "در حال حذف...");
    await deleteSubmission(ch.id, d);
    const rest = { ...S.subs };
    delete rest[d];
    try { await ensureMissedRecords(ch, rest, S.tasks); } catch { /* ignore */ }
    const [subs, scores] = await Promise.all([listSubmissions(ch.id), listScores(ch.id)]);
    S.subs = subs; S.scores = scores;
    $("customChecklist").dataset.ch = "";
    renderAll();
  } catch (e) { $("saveMsg").textContent = faError(e); }
  finally { loading(false); }
}));

/* ---------------- calendar ---------------- */
const DOW = [["شنبه", "ش"], ["یکشنبه", "ی"], ["دوشنبه", "د"], ["سه‌شنبه", "س"], ["چهارشنبه", "چ"], ["پنجشنبه", "پ"], ["جمعه", "ج"]];
function renderCalendar() {
  const ch = activeChallenge();
  const { y, m } = calCursor;
  $("calTitle").textContent = new Date(y, m, 1).toLocaleDateString("fa-IR", { month: "long", year: "numeric" });
  const first = new Date(y, m, 1);
  const startOffset = (first.getDay() + 1) % 7;
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const t = todayStr();
  let html = DOW.map(([full, short]) => `<div class="cal-dow"><span class="full">${full}</span><span class="short">${short}</span></div>`).join("");
  for (let i = 0; i < startOffset; i++) html += `<div class="cal-day other"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const key = `${y}-${pad2(m + 1)}-${pad2(d)}`;
    const st = dayStatus(key, ch.start_date, t, !!S.subs[key]);
    let cls = "future", label = "–";
    if (st === "submitted") {
      const r = dailyResult(S.subs[key], effectiveTasks(S.tasks, key));
      cls = r.met === r.of ? "ok" : "partial";
      label = `${faNum(r.pct)}٪`;
    } else if (st === "missed") { cls = "missed"; label = "از دست رفته"; }
    else if (st === "pending") { cls = "pending"; label = "در انتظار"; }
    html += `<div class="cal-day ${cls} ${key === t ? "today" : ""}" data-day="${key}"><span class="d">${faNum(d)}</span><span class="s">${label}</span></div>`;
  }
  $("calGrid").innerHTML = html;
  document.querySelectorAll(".cal-day[data-day]").forEach((el) => el.addEventListener("click", () => showDayDetail(el.dataset.day)));
}
function showDayDetail(dateStr) {
  const ch = activeChallenge();
  const e = S.subs[dateStr];
  const box = $("dayDetail");
  const st = dayStatus(dateStr, ch.start_date, todayStr(), !!e);
  if (!e) {
    const msg = st === "future" ? "این روز هنوز نیامده است."
      : st === "pre" ? `قبل از شروع چالش (${faShort(ch.start_date)}) است و هرگز در آمار حساب نمی‌شود.`
      : st === "pending" ? "امروز هنوز ثبت نشده است (در انتظار)."
      : "❌ <strong>از دست رفته</strong>: این روز گذشت و نتیجه‌ای ثبت نشد (امتیاز صفر).";
    const canLog = st === "missed" || st === "pending";
    box.innerHTML = `<strong>${faDate(dateStr)}</strong> — ${msg} ${canLog ? '<button class="btn btn-ghost small" id="jumpLog" type="button">ثبت این روز</button>' : ""}`;
    const b = $("jumpLog");
    if (b) b.onclick = () => { $("entryDate").value = dateStr; $("customChecklist").dataset.ch = ""; switchTab("checkin"); loadEntryIntoForm(); };
    return;
  }
  const r = dailyResult(e, effectiveTasks(S.tasks, dateStr));
  const names = { reading: "📖 مطالعه", exercise: "🏃 ورزش", goal: "🎯 هدف", wake: "⏰ بیداری", noAlcohol: "🍺 الکل", noSmoke: "🚭 دود" };
  const lines = r.perRule.map((p) => `${names[p.key]}: ${p.met ? `انجام شد (‎+${faNum(p.points)})` : (p.points > 0 ? `ناقص (‎+${faNum(p.points)})` : `ناموفق (‎−${faNum(10)})`)}`).join("<br>");
  const opt = effectiveTasks(S.tasks, dateStr).map((t) => `${(e.custom_states && e.custom_states[t.id]) ? "✓" : "✕"} ${esc(t.title)}`).join("<br>");
  box.innerHTML = `<strong>${faDate(dateStr)}</strong> — ${faNum(r.points)} از ${faNum(MAX_MANDATORY)} امتیاز (${grade(r.pct)}) · امتیاز منفی/از دست رفته: ‎−${faNum(r.lost)} · تشویقی: ‎+${faNum(r.bonus)}<br>${lines}${opt ? "<br>📌 اختیاری:<br>" + opt : ""}${e.notes ? "<br>📝 " + esc(e.notes) : ""} <button class="btn btn-ghost small" id="editDay" type="button">ویرایش</button>`;
  $("editDay").onclick = () => { $("entryDate").value = dateStr; $("customChecklist").dataset.ch = ""; switchTab("checkin"); loadEntryIntoForm(); };
}
$("calPrev").addEventListener("click", () => { calCursor.m--; if (calCursor.m < 0) { calCursor.m = 11; calCursor.y--; } renderCalendar(); });
$("calNext").addEventListener("click", () => { calCursor.m++; if (calCursor.m > 11) { calCursor.m = 0; calCursor.y++; } renderCalendar(); });
$("calToday").addEventListener("click", () => { const n = new Date(); calCursor = { y: n.getFullYear(), m: n.getMonth() }; renderCalendar(); });

/* ---------------- schedule ---------------- */
async function renderSchedule() {
  if (!$("schedDate").value) $("schedDate").value = todayStr();
  const d = $("schedDate").value;
  try {
    const list = await listSchedule(d);
    $("taskList").innerHTML = list.map((t) => `<li class="${t.done ? "done" : ""}"><input type="checkbox" data-task="${t.id}" ${t.done ? "checked" : ""} /><time>${esc(t.time)}</time><span class="title">${esc(t.title)}</span><span class="spacer"></span><button class="btn btn-danger-ghost small" data-del="${t.id}" type="button">✕</button></li>`).join("")
      || `<li class="muted">برای ${faShort(d)} برنامه‌ای ثبت نشده — از بالا اضافه کنید.</li>`;
    document.querySelectorAll("[data-task]").forEach((cb) => cb.addEventListener("change", async () => {
      try { await toggleSchedule(cb.dataset.task, cb.checked); } catch (e) { alert(faError(e)); }
      renderSchedule();
    }));
    document.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
      try { await deleteSchedule(b.dataset.del); } catch (e) { alert(faError(e)); }
      renderSchedule();
    }));
  } catch (e) {
    $("taskList").innerHTML = `<li class="muted">${faError(e, "خطا در دریافت برنامه.")}</li>`;
  }
}
$("addTaskBtn").addEventListener("click", () => busy($("addTaskBtn"), async () => {
  const d = $("schedDate").value || todayStr();
  const title = $("taskTitle").value.trim();
  if (!title) { alert("عنوان برنامه را وارد کنید."); return; }
  try {
    await addSchedule(d, $("taskTime").value || "08:00", title);
    $("taskTitle").value = "";
    await renderSchedule();
  } catch (e) { alert(faError(e)); }
}));
$("schedDate").addEventListener("change", renderSchedule);

/* ---------------- stats ---------------- */
function renderStats() {
  const ch = activeChallenge();
  const t = todayStr();
  const stats = computeStats({ startDate: ch.start_date, today: t, submissions: S.subs, tasks: S.tasks });
  $("sTotal").textContent = faNum(stats.elapsedDays);
  $("sSubmitted").textContent = faNum(stats.submitted.length);
  $("sMissed").textContent = faNum(stats.missed.length);
  $("sPerfect").textContent = faNum(stats.perfectDays);
  $("sOverall").textContent = faNum(stats.overallScore) + " از ۱۰۰";
  $("sAvgSub").textContent = stats.avgSubmitted === null ? "–" : faNum(stats.avgSubmitted) + " از ۱۰۰";
  $("sRuleDone").textContent = faNum(stats.ruleDone);
  $("sRuleFail").textContent = faNum(stats.ruleFailed);
  $("sOpt").textContent = stats.optTotal ? `${faNum(stats.optDone)} از ${faNum(stats.optTotal)} (٪${faNum(stats.optRate)})` : "—";

  const counters = ruleCounters(stats.submitted, S.subs);
  $("ruleCountsBody").innerHTML = counters.map((c) => {
    const rate = stats.submitted.length ? Math.round((c.done / stats.submitted.length) * 100) : 0;
    return `<tr><td>${c.ico} ${c.title}</td><td class="green">${faNum(c.done)}</td><td class="red">${faNum(c.failed)}</td><td>٪${faNum(rate)}</td></tr>`;
  }).join("");

  const labels = [], data = [];
  for (let i = 29; i >= 0; i--) {
    const d = addDays(t, -i);
    labels.push(d.slice(5));
    if (S.subs[d]) data.push(dailyResult(S.subs[d], effectiveTasks(S.tasks, d)).pct);
    else if (d < ch.start_date || d > t) data.push(null);
    else data.push(0);
  }
  drawChart("trendChart", {
    type: "bar",
    data: { labels, datasets: [{ label: "درصد اجباری", data, backgroundColor: data.map((v) => v === null ? "transparent" : v >= 75 ? "#22c55e" : v >= 50 ? "#2f7cff" : v > 0 ? "#f59e0b" : "rgba(239,68,68,.7)"), borderRadius: 4 }] },
    options: { plugins: { legend: { display: false } }, scales: { y: { min: 0, max: 100, grid: { color: chartGrid }, ticks: { color: "#9db1d8" } }, x: { reverse: true, grid: { display: false }, ticks: { color: "#9db1d8", maxTicksLimit: 10 } } } },
  });
  const metCount = (key) => stats.submitted.filter((d) => ruleMet(S.subs[d], key)).length;
  drawChart("rulesChart", {
    type: "doughnut",
    data: { labels: ["مطالعه", "ورزش", "هدف", "بیداری زود", "بدون الکل", "دوری از دود"], datasets: [{ data: [metCount("reading"), metCount("exercise"), metCount("goal"), metCount("wake"), metCount("noAlcohol"), metCount("noSmoke")], backgroundColor: ["#2f7cff", "#22c55e", "#a78bfa", "#f59e0b", "#ef4444", "#5aa0ff"], borderColor: "#0e1730" }] },
    options: { plugins: { legend: { labels: { color: "#e6edff" } } } },
  });
  const wLabels = [], wSub = [], wMiss = [];
  const today = parseDay(t);
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - ((today.getDay() + 1) % 7) - 11 * 7);
  for (let w = 0; w < 12; w++) {
    const ws = new Date(weekStart); ws.setDate(weekStart.getDate() + w * 7);
    let s = 0, mi = 0;
    for (let i = 0; i < 7; i++) {
      const dd = new Date(ws); dd.setDate(ws.getDate() + i);
      const key = `${dd.getFullYear()}-${String(dd.getMonth() + 1).padStart(2, "0")}-${String(dd.getDate()).padStart(2, "0")}`;
      if (key > t || key < ch.start_date) continue;
      if (S.subs[key]) s++; else mi++;
    }
    wLabels.push(`هفته ${faNum(w + 1)}`);
    wSub.push(s); wMiss.push(mi);
  }
  drawChart("weekChart", {
    type: "bar",
    data: { labels: wLabels, datasets: [{ label: "ثبت‌شده", data: wSub, backgroundColor: "#2f7cff", borderRadius: 4 }, { label: "از دست رفته", data: wMiss, backgroundColor: "rgba(239,68,68,.7)", borderRadius: 4 }] },
    options: { scales: { x: { stacked: true, ticks: { color: "#9db1d8" }, grid: { display: false }, reverse: true }, y: { stacked: true, ticks: { color: "#9db1d8" }, grid: { color: chartGrid } } }, plugins: { legend: { labels: { color: "#e6edff" } } } },
  });
}

/* ---------------- rules cards ---------------- */
function renderRulesCards() {
  const n = effectiveTasks(S.tasks, todayStr()).length;
  $("rulesCards").innerHTML = RULES.map((r, i) =>
    `<div class="card rule"><div class="rule-ico">${r.ico}</div><h3>${faNum(i + 1)} · ${r.title}</h3><p>${r.desc}.</p></div>`
  ).join("") + `<div class="card rule"><div class="rule-ico">📌</div><h3>وظایف اختیاری</h3><p>در این چالش ${faNum(n)} وظیفه اختیاری فعال است. هر انجام = ‎+۲ تشویقی جدا (سقف روزانه ‎+۱۰). از بخش «چالش‌ها» مدیریت کنید.</p></div>`;
}

/* ---------------- tabs ---------------- */
document.querySelectorAll(".tab[data-tab]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.goto)));

/* ---------------- master render ---------------- */
function renderAll() {
  renderChallengeBar();
  renderDashboard();
  renderQuickToday();
  renderCustomizer();
  renderCheckin();
  renderChallenges();
  renderCalendar();
  renderSchedule();
  renderStats();
  renderRulesCards();
}

/* ---------------- init ---------------- */
switchTab("dashboard");
boot();
