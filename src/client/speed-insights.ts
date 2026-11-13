// Native HTML integration; local development does not send performance events.
if (location.hostname === 'flow-study.me' || location.hostname.endsWith('.vercel.app')) {
    window.si = window.si || function () { (window.siq = window.siq || []).push(arguments); };
    window.si('beforeSend', event => {
        const url = new URL(event.url, location.origin);
        url.search = '';
        url.hash = '';
        return { ...event, url: url.href };
    });
    const script = document.createElement('script');
    script.defer = true;
    // Trusted Types (vercel.json) blocks script URLs given as plain strings; this policy allows exactly one.
    const SCRIPT = '/_vercel/speed-insights/script.js';
    const policy = (window as unknown as { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(url: string): string }): { createScriptURL(url: string): string } } })
        .trustedTypes?.createPolicy('flow-script', { createScriptURL: url => { if (url !== SCRIPT) throw new TypeError('Unexpected script'); return url; } });
    script.src = policy ? policy.createScriptURL(SCRIPT) : SCRIPT;
    document.head.appendChild(script);
}
