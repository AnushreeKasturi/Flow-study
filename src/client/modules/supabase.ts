import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import defaults from '../../../supabase.config.json';
import type { Database } from '../types';

// Public values only. Self-hosters override them in .env; see README.
const url = import.meta.env.PUBLIC_SUPABASE_URL || defaults.url;
const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || defaults.publishableKey;

// Seam for the browser tests and `npm run dev:demo`: scripts/supabase-fixture.js
// defines window.supabase before this module loads. Production never does.
const create = window.supabase?.createClient ?? createClient;

const supabase: SupabaseClient<Database> = create<Database>(url, key, {
    global: {
        fetch: (input, options = {}) => {
            const signal = options.signal ?? (input instanceof Request ? input.signal : null);
            const timeout = AbortSignal.timeout(15000);
            // While the page is being closed, let the request outlive it (the goodbye message is sent then).
            const keepalive = options.keepalive ?? (typeof document !== 'undefined' && document.visibilityState === 'hidden');
            return fetch(input, { ...options, keepalive, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
        }
    }
});

export const getSupabase = () => supabase;
export default supabase;
