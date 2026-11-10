import type { createClient } from '@supabase/supabase-js';
interface VitalEvent { url: string; [key: string]: unknown; }
declare global {
    interface Window {
        supabase?: { createClient: typeof createClient };
        webkitAudioContext?: typeof AudioContext;
        si?: (command: 'beforeSend', callback: (event: VitalEvent) => VitalEvent | null) => void;
        siq?: IArguments[];
    }
    interface ImportMetaEnv {
        readonly PUBLIC_SUPABASE_URL?: string;
        readonly PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
    }
}
export {};
