// Cloudflare Turnstile: the captcha Supabase checks on sign-up, log-in and auth
// emails (Authentication → Attack Protection). Off until a site key is set, and
// then nothing loads. Most people never see it; it shows only if Cloudflare asks.
import defaults from '../../../supabase.config.json';
type Turnstile = NonNullable<Window['turnstile']>;

const KEY = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY || (defaults as { captchaSiteKey?: string }).captchaSiteKey || '';
const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

// Seam for the browser tests and `npm run dev:demo`: scripts/supabase-fixture.js
// defines window.turnstile before this module loads. Production never does.
export const captchaOn = !!KEY || !!window.turnstile;

export const CAPTCHA_MSG = 'The security check didn’t go through. Check your connection, then try again.';
export const isCaptchaError = (error?: { code?: string; message?: string } | null) =>
    error?.code === 'captcha_failed' || /captcha/i.test(error?.message ?? '');

// Trusted Types (vercel.json) only takes script URLs through a named policy; this one allows Turnstile alone.
type Policy = { createScriptURL(url: string): string };
let policy: Policy | null | undefined;
function scriptURL() {
    policy ??= (window as unknown as { trustedTypes?: { createPolicy(name: string, rules: Policy): Policy } })
        .trustedTypes?.createPolicy('flow-captcha', { createScriptURL: url => { if (url !== SRC) throw new TypeError('Unexpected script'); return url; } }) ?? null;
    return policy ? policy.createScriptURL(SRC) : SRC;
}

function load(): Promise<Turnstile | null> {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    return new Promise(resolve => {
        const script = document.createElement('script');
        script.src = scriptURL();
        script.onload = () => resolve(window.turnstile ?? null);
        script.onerror = () => { script.remove(); resolve(null); };
        document.head.append(script);
    });
}

// The latest check: null while it runs; a token, or null in `token` when it failed.
let widget: Promise<string | null> | null = null;
let result: { token: string | null } | null = null;
const waiting: ((value: { token: string | null }) => void)[] = [];
const settle = (token: string | null) => { result = { token }; waiting.splice(0).forEach(resolve => resolve(result!)); };

// Starts the check early, so a token is usually ready by the time the form is sent.
export function prepCaptcha(): Promise<string | null> {
    if (!captchaOn) return Promise.resolve(null);
    widget ??= load().then(turnstile => {
        const box = document.querySelector<HTMLElement>('[data-captcha]');
        // Blocked or offline: try loading again on the next send.
        if (!turnstile || !box) { widget = null; return null; }
        return turnstile.render(box, {
            sitekey: KEY || 'fixture',
            appearance: 'interaction-only',
            size: box.clientWidth >= 300 ? 'flexible' : 'compact',
            theme: getComputedStyle(document.documentElement).colorScheme.includes('light') ? 'light' : 'dark',
            // Room is made for it only while Cloudflare is asking for a tap.
            'before-interactive-callback': () => box.classList.add('shown'),
            'after-interactive-callback': () => box.classList.remove('shown'),
            'refresh-expired': 'auto',
            callback: (value: string) => settle(value),
            'error-callback': () => settle(null),
            'expired-callback': () => { result = null; }
        });
    });
    return widget;
}

// A token for one auth request. Tokens work once, so the next check starts straight away.
// Undefined when the captcha is off or couldn't run; Supabase then says no, if it's on.
export async function captchaToken(): Promise<string | undefined> {
    const id = await prepCaptcha();
    if (id === null) return undefined;
    // Still running (or waiting for a tap, when Cloudflare asks for one): wait for it, up to a minute.
    const { token } = result ?? await new Promise<{ token: string | null }>(resolve => {
        waiting.push(resolve);
        setTimeout(() => resolve({ token: null }), 60000);
    });
    result = null;
    window.turnstile?.reset(id);
    return token ?? undefined;
}
