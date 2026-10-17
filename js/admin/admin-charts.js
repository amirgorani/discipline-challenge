// ============================================================
// Admin chart builders (Chart.js) — consistent Persian RTL look
// shared by dashboard, analytics and challenge detail views.
// ============================================================
const FONT = "Vazirmatn, Tahoma, sans-serif";
const BLUE = "#2f7cff", BLUE2 = "#5aa0ff", GRID = "rgba(157,177,216,.15)";
const GREEN = "#22c55e", AMBER = "#f59e0b", RED = "#ef4444", MUTED = "#9db1d8";

const registry = new Map();

function configDefaults() {
  if (typeof Chart === "undefined") return false;
  Chart.defaults.font.family = FONT;
  Chart.defaults.font.size = 12;
  Chart.defaults.color = MUTED;
  Chart.defaults.borderColor = GRID;
  return true;
}
export function chartsAvailable() {
  return typeof Chart !== "undefined";
}

function destroy(id) {
  const prev = registry.get(id);
  if (prev) { try { prev.destroy(); } catch { /* ignore */ } registry.delete(id); }
}
function base(id) {
  destroy(id);
  const el = document.getElementById(id);
  if (!el || !configDefaults()) return null;
  return el;
}
function rtlOpts(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 350 },
    plugins: {
      legend: { rtl: true, textDirection: "rtl", labels: { boxWidth: 12, boxHeight: 12, padding: 12 } },
      tooltip: { rtl: true, textDirection: "rtl" },
    },
    ...extra,
  };
}

export function lineChart(id, labels, datasets, { fill = true, yMax = null } = {}) {
  const el = base(id);
  if (!el) return null;
  registry.set(id, new Chart(el, {
    type: "line",
    data: {
      labels,
      datasets: datasets.map((d, i) => ({
        borderColor: d.color || [BLUE, RED, AMBER][i % 3],
        backgroundColor: d.color || [BLUE, RED, AMBER][i % 3],
        data: d.data,
        label: d.label,
        tension: 0.32,
        borderWidth: 2,
        pointRadius: 0,
        pointHoverRadius: 4,
        fill: fill && i === 0,
      })),
    },
    options: { ...rtlOpts(), interaction: { mode: "index", intersect: false },
      scales: { x: { grid: { display: false } },
        y: { beginAtZero: true, grid: { color: GRID }, max: yMax ?? undefined } } },
  }));
  return registry.get(id);
}

export function barChart(id, labels, datasets, { stacked = false, yMax = null } = {}) {
  const el = base(id);
  if (!el) return null;
  const colors = [BLUE, AMBER, RED, GREEN];
  registry.set(id, new Chart(el, {
    type: "bar",
    data: {
      labels,
      datasets: datasets.map((d, i) => ({
        label: d.label,
        data: d.data,
        backgroundColor: d.color || (typeof d.data?.[0] === "object" ? d.data : colors[i % colors.length]),
        borderRadius: 5,
        maxBarThickness: 34,
        stack: d.stack,
      })),
    },
    options: { ...rtlOpts(), interaction: { mode: "index", intersect: false },
      scales: {
        x: { stacked, grid: { display: false } },
        y: { stacked, beginAtZero: true, grid: { color: GRID }, max: yMax ?? undefined, ticks: { precision: 0 } },
      } },
  }));
  return registry.get(id);
}

export function doughnutChart(id, labels, values, colors) {
  const el = base(id);
  if (!el) return null;
  registry.set(id, new Chart(el, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderWidth: 2,
        borderColor: "#0a1128",
        hoverOffset: 6,
      }],
    },
    options: { ...rtlOpts(), cutout: "64%" },
  }));
  return registry.get(id);
}

export function colors() { return { blue: BLUE, blue2: BLUE2, green: GREEN, amber: AMBER, red: RED, muted: MUTED }; }
export function isAvailable() { return typeof Chart !== "undefined"; }
export function emptyUnmount(id) { destroy(id); }
