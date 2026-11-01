import type { createClient } from '@supabase/supabase-js';
interface VitalEvent { url: string; [key: string]: unknown; }
declare global {
    interface Window {
        supabase?: { createClient: typeof createClient };
        webkitAudioContext?: typeof AudioContext;
        si?: (command: 'beforeSend', callback: (event: VitalEvent) => VitalEvent | null) => void;
        siq?: IArguments[];
    }
}
export {};
