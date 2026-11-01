import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../types';
const supabaseUrl = 'https://mrjtkxwenqswbjplmzko.supabase.co';
const supabaseKey = 'sb_publishable_KbaspJKanVVEPMzUxMSmXw_nQyzfNyf';

let supabase: SupabaseClient<Database> | null = null;
if (window.supabase) {
    supabase = window.supabase.createClient<Database>(supabaseUrl, supabaseKey, {
        global: {
            fetch: (input, options = {}) => {
                const signal = options.signal ?? (input instanceof Request ? input.signal : null);
                const timeout = AbortSignal.timeout(15000);
                return fetch(input, { ...options, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
            }
        }
    });
}

export function getSupabase(): SupabaseClient<Database> {
    if (!supabase) throw new Error('Sign-in service is unavailable. Refresh and try again.');
    return supabase;
}
export default supabase;
