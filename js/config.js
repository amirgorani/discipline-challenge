// Supabase connection settings.
// Priority: window.SUPABASE_CONFIG (supabase-config.js, git-ignored)
//        → localStorage override entered in the app setup screen.
const LS_KEY = "ddp-supabase-config";

export function getSupabaseConfig() {
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { stored = null; }
  const fromFile = (typeof window !== "undefined" && window.SUPABASE_CONFIG) || {};
  const url = String(stored?.url || fromFile.url || "").trim();
  const anonKey = String(stored?.anonKey || fromFile.anonKey || "").trim();
  if (!url || !anonKey) return null;
  return { url, anonKey, source: stored?.url ? "local" : "file" };
}

export function saveSupabaseConfig(url, anonKey) {
  localStorage.setItem(LS_KEY, JSON.stringify({ url: url.trim(), anonKey: anonKey.trim() }));
}

export function clearSupabaseConfig() {
  localStorage.removeItem(LS_KEY);
}
