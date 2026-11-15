import type { createClient } from '@supabase/supabase-js';
interface VitalEvent { url: string; [key: string]: unknown; }
declare global {
    interface Window {
        supabase?: { createClient: typeof createClient };
        webkitAudioContext?: typeof AudioContext;
        si?: (command: 'beforeSend', callback: (event: VitalEvent) => VitalEvent | null) => void;
        siq?: IArguments[];
        // Cloudflare Turnstile, as modules/captcha.ts uses it.
        turnstile?: { render(box: HTMLElement, options: Record<string, unknown>): string; reset(id: string): void };
    }
    interface ImportMetaEnv {
        readonly PUBLIC_SUPABASE_URL?: string;
        readonly PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
        readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
    }
}
export {};
