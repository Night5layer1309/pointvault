import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Use the default supabase storageKey (sb-<ref>-auth-token) so existing
// sessions from before the password-auth change still work. The defaults
// for persistSession, autoRefreshToken and detectSessionInUrl are already
// what we want here.
export const supabase = createClient(supabaseUrl, supabaseAnonKey);