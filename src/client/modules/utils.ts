export function escapeHTML(str: unknown) {
    const text = String(str ?? '');
    return text.replace(/[&<>'"]/g,
        (tag: string) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        } as Record<string, string>)[tag] || tag
    );
}

export function getStoredUser(): { id: string; email: string } | null {
    try {
        const user = JSON.parse(localStorage.getItem('flow_user') || 'null');
        return typeof user?.id === 'string' && typeof user.email === 'string' && user.email.includes('@') ? user : null;
    } catch { return null; }
}

export function youtubeEmbedUrl(value: string) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        const host = url.hostname.replace(/^www\./, '');
        if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return null;
        const playlist = url.searchParams.get('list');
        if (playlist && /^[A-Za-z0-9_-]{10,100}$/.test(playlist)) return `https://www.youtube.com/embed/videoseries?list=${playlist}&autoplay=1`;
        const id = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})$/)?.[1];
        return /^[\w-]{11}$/.test(id || '') ? `https://www.youtube.com/embed/${id}?autoplay=1` : null;
    } catch { return null; }
}

export function spotifyEmbedUrl(value: string) {
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'open.spotify.com') return null;
        const match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?(?:embed\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{22})\/?$/);
        return match ? 'https://open.spotify.com/embed/' + match[1] + '/' + match[2] + '?theme=0' : null;
    } catch { return null; }
}
