// Vercel Web Analytics (page views) and Speed Insights (load times), loaded natively:
// no package, and no cookies. Local development and self-hosted copies send nothing.
// Page addresses are reported without their query or fragment, so room codes never leave.
if (location.hostname === 'flow-study.me' || location.hostname.endsWith('.vercel.app')) {
    type Queue = ((...args: unknown[]) => void) & { q?: unknown[] };
    const scrub = <T extends { url: string }>(event: T) => {
        const url = new URL(event.url, location.origin);
        url.search = '';
        url.hash = '';
        return { ...event, url: url.href };
    };
    const w = window as unknown as Record<string, Queue | unknown[] | undefined>;
    w.va = w.va || function (...args: unknown[]) { ((w.vaq = (w.vaq as unknown[]) || []) as unknown[]).push(args); };
    w.si = w.si || function (...args: unknown[]) { ((w.siq = (w.siq as unknown[]) || []) as unknown[]).push(args); };
    (w.va as Queue)('beforeSend', scrub);
    (w.si as Queue)('beforeSend', scrub);

    // Trusted Types (vercel.json) blocks script URLs given as plain strings; this policy allows exactly these two.
    const SCRIPTS = ['/_vercel/insights/script.js', '/_vercel/speed-insights/script.js'];
    const policy = (window as unknown as { trustedTypes?: { createPolicy(name: string, rules: { createScriptURL(url: string): string }): { createScriptURL(url: string): string } } })
        .trustedTypes?.createPolicy('flow-script', { createScriptURL: url => { if (!SCRIPTS.includes(url)) throw new TypeError('Unexpected script'); return url; } });
    for (const src of SCRIPTS) {
        const script = document.createElement('script');
        script.defer = true;
        script.src = policy ? policy.createScriptURL(src) : src;
        document.head.appendChild(script);
    }
}
