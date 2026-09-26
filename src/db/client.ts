import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env.js";

export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { headers: { "x-bytestrike-service": "margin-notification-worker" } },
});

export async function assertDatabaseReady(): Promise<void> {
  const { error } = await supabase.from("margin_worker_state").select("key").limit(1);
  if (error) {
    throw new Error(`Margin worker database migration is not available: ${error.message}`);
  }
}

export async function claimLease(owner: string, ttlSeconds: number): Promise<boolean> {
  const { data, error } = await supabase.rpc("claim_margin_worker_lease", {
    p_name: "margin-notification-worker",
    p_owner: owner,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new Error(`Unable to claim worker lease: ${error.message}`);
  return data === true;
}

export async function getState(key: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("margin_worker_state")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw new Error(`Unable to read worker state ${key}: ${error.message}`);
  return data?.value ?? null;
}

export async function setState(key: string, value: string): Promise<void> {
  const { error } = await supabase
    .from("margin_worker_state")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(`Unable to write worker state ${key}: ${error.message}`);
}
