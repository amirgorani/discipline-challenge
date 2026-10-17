// ============================================================
// Admin UI helpers: formatting, pills, confirm dialog, toast,
// loading/empty/error states, pagination bar.
// Reuses existing Persian/date/HTML helpers from scoring.js —
// no duplicated business logic.
// ============================================================
import { faNum, faDate, esc } from "../scoring.js";

export { faNum, faDate, esc };

// ---------- timestamps ----------
export function dt(s) {
  if (!s) return "–";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return `${d.toLocaleDateString("fa-IR", { year: "numeric", month: "long", day: "numeric" })} ، ${d.toLocaleTimeString("fa-IR", { hour: "2-digit", minute: "2-digit" })}`;
}

export function rel(s) {
  if (!s) return "هیچ‌وقت";
  const diff = Date.now() - new Date(s).getTime();
  if (Number.isNaN(diff)) return "–";
  if (diff < 60_000) return "چند لحظه پیش";
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${faNum(min)} دقیقه پیش`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${faNum(hr)} ساعت پیش`;
  const day = Math.floor(hr / 24);
  if (day < 31) return `${faNum(day)} روز پیش`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${faNum(mo)} ماه پیش`;
  return `${faNum(Math.floor(mo / 12))} سال پیش`;
}

// ---------- status pills ----------
export function accountPill(status) {
  if (status === "suspended") return `<span class="pill miss">معلق</span>`;
  return `<span class="pill ok">فعال</span>`;
}
export function rolePill(role) {
  if (role === "super_admin") return `<span class="pill solid">مدیر ارشد</span>`;
  if (role === "admin") return `<span class="pill blue">مدیر</span>`;
  return "";
}
export function lifePill(status) {
  const map = {
    ongoing: ["ok", "در جریان"],
    completed: ["blue", "پایان دوره"],
    upcoming: ["none", "شروع نشده"],
    stalled: ["pending", "رکود"],
  };
  const [cls, txt] = map[status] || ["none", status || "—"];
  return `<span class="pill ${cls}">${txt}</span>`;
}
export function activityPill(lastSeen) {
  if (!lastSeen) return `<span class="pill none">بدون فعالیت</span>`;
  const mins = (Date.now() - new Date(lastSeen).getTime()) / 60_000;
  if (mins < 60 * 24) return `<span class="pill ok">فعال امروز</span>`;
  if (mins < 60 * 24 * 7) return `<span class="pill blue">فعال ۷ روز اخیر</span>`;
  if (mins < 60 * 24 * 14) return `<span class="pill pending">فعال ۱۴ روز اخیر</span>`;
  if (mins < 60 * 24 * 60) return `<span class="pill pending">کم‌فعال</span>`;
  return `<span class="pill miss">غیرفعال</span>`;
}
export function actionLabel(action) {
  const map = {
    admin_login: ["blue", "ورود به پنل"],
    account_suspended: ["miss", "تعلیق حساب"],
    account_reactivated: ["ok", "فعال‌سازی حساب"],
    role_changed: ["pending", "تغییر نقش"],
  };
  const [cls, txt] = map[action] || ["none", action];
  return `<span class="pill ${cls}">${esc(txt)}</span>`;
}

// ---------- stat card ----------
export function statCard({ icon, label, value, sub, numSmall, extraHtml }) {
  return `<div class="adm-card stat">
    <div><span class="ico-wrap">${icon || "•"}</span></div>
    <span class="lbl">${esc(label)}</span>
    <strong class="val ${numSmall ? "num-sm" : ""}">${value ?? "–"}</strong>
    ${sub ? `<span class="sub">${esc(sub)}</span>` : ""}
    ${extraHtml || ""}
  </div>`;
}

// ---------- busy button ----------
export async function busy(btn, fn) {
  const old = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "صبر کنید..."; }
  try { await fn(); }
  finally { if (btn) { btn.disabled = false; btn.textContent = old ?? "…"; } }
}

// ---------- toast ----------
let toastTimer = null;
export function toast(msg, type = "success") {
  const el = document.getElementById("admToast");
  el.textContent = msg;
  el.className = `adm-toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "adm-toast hidden"; }, 3800);
}

// ---------- confirm dialog (required for sensitive actions) ----------
export function confirmAction({ title = "تأیید عملیات", message = "", okLabel = "تأیید", danger = true, okClass = null } = {}) {
  return new Promise((resolve) => {
    const modal = document.getElementById("admConfirm");
    const ok = document.getElementById("admConfirmOk");
    const cancel = document.getElementById("admConfirmCancel");
    document.getElementById("admConfirmTitle").textContent = title;
    document.getElementById("admConfirmMsg").textContent = message;
    ok.textContent = okLabel;
    ok.className = `btn ${okClass || (danger ? "btn-danger" : "btn-primary")}`;
    modal.classList.remove("hidden");
    const close = (val) => {
      modal.classList.add("hidden");
      ok.removeEventListener("click", onOk);
      cancel.removeEventListener("click", onCancel);
      modal.removeEventListener("click", onBack);
      document.removeEventListener("keydown", onEsc);
      resolve(val);
    };
    const onOk = () => close(true);
    const onCancel = () => close(false);
    const onBack = (e) => { if (e.target === modal) close(false); };
    const onEsc = (e) => { if (e.key === "Escape") close(false); };
    ok.addEventListener("click", onOk);
    cancel.addEventListener("click", onCancel);
    modal.addEventListener("click", onBack);
    document.addEventListener("keydown", onEsc);
    ok.focus();
  });
}

// ---------- container states ----------
export function setLoading(el) {
  el.innerHTML = `<div class="adm-skeleton">
    <div class="sk"></div><div class="sk"></div><div class="sk"></div>
  </div>`;
}
export function emptyState({ icon = "📭", title = "موردی یافت نشد", sub = "", actionHtml = "" }) {
  return `<div class="adm-empty">
    <span class="bigico">${icon}</span>
    <strong>${esc(title)}</strong>
    <span>${esc(sub)}</span>
    ${actionHtml}
  </div>`;
}
export function errorState(message = "خطا در دریافت داده. دوباره تلاش کنید.") {
  return `<div class="adm-error">
    <strong>⚠️ ${esc(Array.isArray(message) ? message[0] : message)}</strong>
    <button class="btn btn-ghost small retry" type="button">تلاش دوباره</button>
  </div>`;
}

// ---------- pagination ----------
export function paginationBar({ page, size, total, onGo }) {
  const pages = Math.max(1, Math.ceil(total / size));
  if (total <= size && pages <= 1) {
    return `<div class="adm-pager"><span class="info">مجموع: ${faNum(total)} سطر</span></div>`;
  }
  const btn = (p, label, disabled = false, current = false) =>
    `<button class="pg-btn ${current ? "current" : ""}" data-go="${p}" ${disabled ? "disabled" : ""}>${label}</button>`;
  const window = [];
  const from = Math.max(1, page - 2);
  const to = Math.min(pages, from + 4);
  for (let p = from; p <= to; p++) window.push(p);
  const html = `
    <div class="pg-btns">
      <button class="pg-btn" data-go="${page - 1}" ${page <= 1 ? "disabled" : ""}>›</button>
      ${from > 1 ? btn(1, faNum(1)) + (from > 2 ? `<span class="muted">…</span>` : "") : ""}
      ${window.map((p) => btn(p, faNum(p), false, p === page)).join("")}
      ${to < pages ? (to < pages - 1 ? `<span class="muted">…</span>` : "") + btn(pages, faNum(pages)) : ""}
      <button class="pg-btn" data-go="${page + 1}" ${page >= pages ? "disabled" : ""}>‹</button>
    </div>
    <span class="info">صفحه ${faNum(page)} از ${faNum(pages)} · مجموع ${faNum(total)} سطر</span>`;
  return `<div class="adm-pager">${html}</div>`;
}
export function bindPager(container, onGo) {
  container.querySelectorAll("[data-go]").forEach((b) => {
    b.addEventListener("click", () => onGo(Number(b.dataset.go)));
  });
}

// ---------- misc formatting ----------
export function pct(n) { return n === null || n === undefined ? "–" : `٪${faNum(Math.round(n))}`; }
export function fmtBytesJson(o) {
  try { return JSON.stringify(o, null, 0); } catch { return "—"; }
}
export function labelDetails(action, details) {
  if (!details || typeof details !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(details)) {
    if (k === "at") continue;
    let key = k;
    if (k === "previous_status") key = "وضعیت قبلی";
    else if (k === "previous_role") key = "نقش قبلی";
    else if (k === "new_role") key = "نقش جدید";
    else if (k === "target_role") key = "نقش طرف";
    parts.push(`${key}: ${esc(String(v))}`);
  }
  return parts.join(" · ");
}
export function avatarLetter(name) {
  return esc((String(name || "؟").trim()[0] || "؟"));
}
