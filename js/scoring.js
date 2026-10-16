// ============================================================
// Pure scoring & date logic — no DOM, no network (testable).
// مدل امتیازدهی شفاف:
//  - هر قانون اجباری در روز: ۰ تا ۱۰ امتیاز مثبت (جمعاً ۶۰)
//  - انجام ناقص مطالعه/ورزش/هدف: امتیاز نسبی
//  - امتیاز از دست رفته (منفی) = ۶۰ − امتیاز کسب‌شده
//  - درصد اجباری روز = امتیاز / ۶۰ × ۱۰۰
//  - هر وظیفه اختیاری انجام‌شده = ‎+۲ امتیاز تشویقی جدا (سقف روزانه ‎+۱۰)
// ============================================================

export const RULES = [
  { key: "reading", ico: "📖", title: "مطالعه روزانه", desc: "خواندن حداقل ۱۰ صفحه کتاب در روز" },
  { key: "exercise", ico: "🏃", title: "ورزش روزانه", desc: "حداقل ۶۰ دقیقه ورزش در روز" },
  { key: "goal", ico: "🎯", title: "پیشرفت هدف", desc: "حداقل ۶۰ دقیقه کار روی هدف شخصی" },
  { key: "wake", ico: "⏰", title: "بیداری زودهنگام", desc: "بیدار شدن قبل از ساعت ۹:۰۰ صبح" },
  { key: "noAlcohol", ico: "🍺", title: "عدم مصرف الکل", desc: "عدم مصرف نوشیدنی‌های الکلی" },
  { key: "noSmoke", ico: "🚭", title: "دوری از دود", desc: "دوری از دود و محیط‌های سیگاری" },
];

export const TARGETS = { reading: 10, exercise: 60, goal: 60, wake: "09:00" };
export const MAX_MANDATORY = 60;      // ۶ قانون × ۱۰ امتیاز
export const BONUS_PER_TASK = 2;      // هر وظیفه اختیاری انجام‌شده
export const BONUS_CAP = 10;          // سقف تشویقی روزانه

// ---------- date helpers (Gregorian ISO, storage format) ----------
export const pad = (n) => String(n).padStart(2, "0");
export function fmt(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function parseDay(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}
export function todayStr() { return fmt(new Date()); }
export function addDays(dateStr, n) {
  const d = parseDay(dateStr);
  d.setDate(d.getDate() + n);
  return fmt(d);
}
export function daysBetween(a, b) {
  return Math.round((parseDay(b) - parseDay(a)) / 86400000);
}
export function enumerateDays(from, to) {
  const out = [];
  if (!from || !to || from > to) return out;
  for (let d = from; ; d = addDays(d, 1)) {
    out.push(d);
    if (d === to) break;
  }
  return out;
}

// ---------- Persian formatting ----------
export const faNum = (n) => Number(n).toLocaleString("fa-IR");
export function faDate(s) {
  try {
    return parseDay(s).toLocaleDateString("fa-IR", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
  } catch { return s; }
}
export function faShort(s) {
  try {
    return parseDay(s).toLocaleDateString("fa-IR", { month: "long", day: "numeric" });
  } catch { return s; }
}
export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

// ---------- mandatory rule scoring (0..10 each) ----------
function clamp10(x) { return Math.max(0, Math.min(10, x)); }
export function rulePoints10(entry, key) {
  if (!entry) return 0;
  if (key === "reading") return clamp10(((Number(entry.reading_pages) || 0) / TARGETS.reading) * 10);
  if (key === "exercise") return clamp10(((Number(entry.exercise_minutes) || 0) / TARGETS.exercise) * 10);
  if (key === "goal") return clamp10(((Number(entry.goal_minutes) || 0) / TARGETS.goal) * 10);
  if (key === "wake") return entry.wake_time && entry.wake_time < TARGETS.wake ? 10 : 0;
  if (key === "noAlcohol") return entry.no_alcohol ? 10 : 0;
  if (key === "noSmoke") return entry.no_smoke ? 10 : 0;
  return 0;
}
export function ruleMet(entry, key) {
  return rulePoints10(entry, key) >= 10;
}

// ---------- optional tasks ----------
// Only tasks created on/before that day count, so adding a task
// never rewrites the history of previous days.
export function effectiveTasks(tasks, dateStr) {
  return (tasks || []).filter((t) => {
    if (!t.created_at) return true;
    return String(t.created_at).slice(0, 10) <= dateStr;
  });
}

// ---------- daily result ----------
// entry: submission row or null. Returns full transparent breakdown.
export function dailyResult(entry, tasksEffective) {
  const tasks = tasksEffective || [];
  const perRule = RULES.map((r) => ({
    key: r.key,
    points: Math.round(rulePoints10(entry, r.key) * 10) / 10,
    met: ruleMet(entry, r.key),
  }));
  const points = Math.round(perRule.reduce((a, r) => a + r.points, 0) * 10) / 10;
  const lost = Math.round((MAX_MANDATORY - points) * 10) / 10;
  const pct = Math.round((points / MAX_MANDATORY) * 100);
  const states = (entry && entry.custom_states) || {};
  const optDone = tasks.filter((t) => !!states[t.id]).length;
  const optTotal = tasks.length;
  const optRate = optTotal ? Math.round((optDone / optTotal) * 100) : null;
  const bonus = Math.min(optDone * BONUS_PER_TASK, BONUS_CAP);
  const met = perRule.filter((r) => r.met).length;
  return {
    perRule, points, lost, pct, bonus,
    optDone, optTotal, optRate, met, of: RULES.length,
  };
}

export function grade(pct) {
  if (pct >= 100) return "کامل ⭐";
  if (pct >= 90) return "عالی";
  if (pct >= 75) return "خوب";
  if (pct >= 50) return "متوسط";
  if (pct >= 1) return "نیاز به تلاش";
  return "از دست رفته";
}

// Day states (start date is the single source of truth):
//  pre       → before challenge start (never counted)
//  future    → hasn't happened yet
//  pending   → today, not submitted yet
//  submitted → has a submission row
//  missed    → day passed with no submission (recorded as missed)
export function dayStatus(dateStr, startDate, today, hasEntry) {
  if (dateStr < startDate) return "pre";
  if (dateStr > today) return "future";
  if (hasEntry) return "submitted";
  if (dateStr === today) return "pending";
  return "missed";
}

// ---------- challenge-wide statistics (start date → today only) ----------
export function computeStats({ startDate, today, submissions, tasks }) {
  const subs = submissions || {};
  const elapsed = startDate > today ? [] : enumerateDays(startDate, today);
  const submitted = elapsed.filter((d) => !!subs[d]);
  const missed = elapsed.filter((d) => d !== today && !subs[d]);
  const pendingToday = !subs[today] && today >= startDate;

  let sumPoints = 0, sumPct = 0, sumBonus = 0;
  let ruleDone = 0, perfect = 0, optDone = 0, optTotal = 0;
  for (const d of submitted) {
    const r = dailyResult(subs[d], effectiveTasks(tasks, d));
    sumPoints += r.points;
    sumPct += r.pct;
    sumBonus += r.bonus;
    ruleDone += r.met;
    if (r.met === r.of) perfect++;
    optDone += r.optDone;
    optTotal += r.optTotal;
  }
  const ruleFailed = submitted.length * RULES.length - ruleDone;
  const denom = elapsed.length;
  return {
    elapsedDays: denom,
    submitted,
    missed,
    pendingToday,
    // امتیاز کلی چالش: روزهای از دست رفته صفر می‌گیرند و در مخرج هستند
    overallScore: denom ? Math.round((sumPoints / (MAX_MANDATORY * denom)) * 100) : 0,
    avgSubmitted: submitted.length ? Math.round(sumPct / submitted.length) : null,
    completionPct: denom ? Math.round((submitted.length / denom) * 100) : 0,
    totalBonus: sumBonus,
    ruleDone,
    ruleFailed,
    optDone,
    optTotal,
    optRate: optTotal ? Math.round((optDone / optTotal) * 100) : null,
    perfectDays: perfect,
    streaks: calcStreaks(subs),
  };
}

export function calcStreaks(subs) {
  const t = todayStr();
  let cur = 0, cursor = subs[t] ? t : addDays(t, -1);
  while (subs[cursor]) { cur++; cursor = addDays(cursor, -1); }
  const sorted = Object.keys(subs).sort();
  let best = 0, run = 0, prev = null;
  for (const d of sorted) {
    run = prev && daysBetween(prev, d) === 1 ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { cur, best };
}

// Per-rule completed/failed counters across submitted days.
export function ruleCounters(submittedDays, submissions) {
  return RULES.map((r) => {
    let done = 0;
    for (const d of submittedDays) {
      if (ruleMet(submissions[d], r.key)) done++;
    }
    return { key: r.key, title: r.title, ico: r.ico, done, failed: submittedDays.length - done };
  });
}
