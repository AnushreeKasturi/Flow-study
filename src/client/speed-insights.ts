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
    script.src = '/_vercel/speed-insights/script.js';
    document.head.appendChild(script);
}
