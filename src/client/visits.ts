import defaults from '../../supabase.config.json';

// Flow's own visit count (sql/020), read on /stats. A random id kept in this browser, not a
// cookie; no IP address, and only the page's name, never its address or room code.
// Only the hosted site counts, like analytics.ts. Blocked storage counts nothing.
export function visitorId(): string | null {
    try {
        let id = localStorage.getItem('flow_visitor');
        if (!id) localStorage.setItem('flow_visitor', id = crypto.randomUUID());
        return id;
    } catch { return null; }
}

export function recordVisit() {
    if (location.hostname !== 'flow-study.me' && !location.hostname.endsWith('.vercel.app')) return;
    const visitor = visitorId();
    if (!visitor) return;
    let signedIn = false;
    try { signedIn = !!(localStorage.getItem('flow_signed_in') || localStorage.getItem('flow_user')); } catch { /* signed out */ }
    let source: string | null = null;
    try { const from = new URL(document.referrer).hostname; if (from !== location.hostname) source = from.replace(/^www\./, ''); } catch { /* typed in, or no referrer */ }
    const url = import.meta.env.PUBLIC_SUPABASE_URL || defaults.url;
    const key = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || defaults.publishableKey;
    fetch(url + '/rest/v1/rpc/record_visit', {
        method: 'POST',
        keepalive: true,
        headers: { apikey: key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            p_visitor: visitor,
            p_page: location.pathname.replace(/^\/|\.html$/g, '') || 'index',
            p_source: source,
            p_device: matchMedia('(pointer: coarse)').matches ? 'touch' : 'desktop',
            p_signed_in: signedIn
        })
    }).catch(() => { /* a missed visit is fine */ });
}
