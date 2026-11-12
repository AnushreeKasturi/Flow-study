import type { AudioProvider } from '../types';
import { byId } from '../dom';
import { youtubeEmbedUrl, spotifyEmbedUrl, isEmbedUrl } from './utils';
import { broadcastAudio } from './socket';
import { notify } from './feedback';

let provider: AudioProvider = 'youtube';
const links = { youtube: '', spotify: '' };
// Players load only when someone asks for one, so joining a room never pulls in a third-party embed.
const sources: Record<AudioProvider, string | null> = { youtube: null, spotify: null };
const LOFI_STREAM = 'https://www.youtube.com/watch?v=rFZHOHl-L8A';
const frame = (name: AudioProvider) => byId<HTMLIFrameElement>(name === 'youtube' ? 'youtube-iframe' : 'spotify-iframe');

function selectProvider(next: AudioProvider) {
    if (!['youtube', 'spotify'].includes(next)) return;
    if (next !== provider) frame(provider).src = 'about:blank';
    provider = next;
    document.querySelectorAll<HTMLButtonElement>('[data-audio-provider]').forEach(button => {
        button.setAttribute('aria-pressed', String(button.dataset.audioProvider === next));
    });
    byId<HTMLIFrameElement>('youtube-iframe').classList.toggle('hidden', next !== 'youtube' || !sources.youtube);
    byId<HTMLElement>('youtube-empty').classList.toggle('hidden', next !== 'youtube' || !!sources.youtube);
    byId<HTMLIFrameElement>('spotify-iframe').classList.toggle('hidden', next !== 'spotify' || !sources.spotify);
    byId<HTMLElement>('spotify-empty').classList.toggle('hidden', next !== 'spotify' || !!sources.spotify);
    const input = byId<HTMLInputElement>('youtube-url-input');
    input.value = links[next];
    input.placeholder = next === 'youtube' ? 'YouTube link' : 'Spotify link';
    input.setAttribute('aria-label', next === 'youtube' ? 'YouTube video or playlist link' : 'Spotify track, album, or playlist link');
    if (sources[next] && frame(next).getAttribute('src') !== sources[next]) point(frame(next), sources[next]!);
}

// The one place a player's address is set, and it only accepts an official embed URL.
function point(player: HTMLIFrameElement, embed: string) {
    if (isEmbedUrl(embed)) player.src = new URL(embed).href;
}

export function loadRoomAudio(next: AudioProvider, url: string) {
    const embed = next === 'youtube' ? youtubeEmbedUrl(url) : next === 'spotify' ? spotifyEmbedUrl(url) : null;
    if (!embed) return false;
    links[next] = url;
    sources[next] = embed;
    selectProvider(next);
    point(frame(next), embed);
    return true;
}

export function initAudio() {
    document.querySelectorAll<HTMLButtonElement>('[data-audio-provider]').forEach(button => button.addEventListener('click', () => selectProvider(button.dataset.audioProvider as AudioProvider)));
    byId<HTMLButtonElement>('sync-youtube-btn').addEventListener('click', async event => {
        const url = byId<HTMLInputElement>('youtube-url-input').value.trim();
        if (!loadRoomAudio(provider, url)) {
            notify('Paste a valid ' + (provider === 'youtube' ? 'YouTube video or playlist' : 'Spotify content') + ' link.', 'error');
            return;
        }
        const button = event.currentTarget as HTMLButtonElement;
        button.disabled = true;
        try {
            const status = await broadcastAudio(provider, url);
            if (status !== 'ok') throw new Error('Sharing failed');
            notify('Audio link shared. Each person controls their own playback.');
        } catch { notify('The link could not be shared. Check your connection and try again.', 'error'); }
        finally { button.disabled = false; }
    });
    byId<HTMLButtonElement>('load-lofi-btn').addEventListener('click', () => loadRoomAudio('youtube', LOFI_STREAM));
    selectProvider(provider);
}
