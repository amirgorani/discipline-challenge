// Supabase client singleton (official @supabase/supabase-js).
// Uses ONLY the public anon key — RLS policies enforce data isolation.
// The service_role key must NEVER appear in frontend code.
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { getSupabaseConfig } from "./config.js";

let client = null;
let clientKey = "";

export function getClient() {
  const cfg = getSupabaseConfig();
  if (!cfg) return null;
  const key = cfg.url + "|" + cfg.anonKey;
  if (!client || clientKey !== key) {
    client = createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    clientKey = key;
  }
  return client;
}

export function resetClient() {
  client = null;
  clientKey = "";
}
