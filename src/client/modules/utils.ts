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

// Players are only ever pointed at these two addresses, with the pasted link's id appended.
export const YOUTUBE_EMBED = 'https://www.youtube.com/embed/';
export const SPOTIFY_EMBED = 'https://open.spotify.com/embed/';

// True only for a URL that is one of the two official embed players.
export function isEmbedUrl(value: string) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && (url.href.startsWith(YOUTUBE_EMBED) || url.href.startsWith(SPOTIFY_EMBED));
    } catch { return false; }
}

export function youtubeEmbedUrl(value: string) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
        const host = url.hostname.replace(/^www\./, '');
        if (!['youtube.com', 'm.youtube.com', 'youtu.be'].includes(host)) return null;
        const playlist = url.searchParams.get('list');
        if (playlist && /^[A-Za-z0-9_-]{10,100}$/.test(playlist)) return YOUTUBE_EMBED + 'videoseries?list=' + encodeURIComponent(playlist) + '&autoplay=1';
        const id = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})$/)?.[1];
        return id && /^[\w-]{11}$/.test(id) ? YOUTUBE_EMBED + encodeURIComponent(id) + '?autoplay=1' : null;
    } catch { return null; }
}

export function spotifyEmbedUrl(value: string) {
    try {
        const url = new URL(value);
        if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'open.spotify.com') return null;
        const match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?(?:embed\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]{22})\/?$/);
        return match ? SPOTIFY_EMBED + encodeURIComponent(match[1]) + '/' + encodeURIComponent(match[2]) + '?theme=0' : null;
    } catch { return null; }
}
