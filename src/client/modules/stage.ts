// Video tiles on the stage: one per participant, plus reactions and raised hands.
import type { Participant } from '../types';
import { byId } from '../dom';
import { getMyUserId } from './socket';
import { initial } from './ui';

const videoGrid = byId<HTMLElement>('video-grid');
const wrapperFor = (userId: string) =>
    document.getElementById(userId === getMyUserId() ? 'video-wrapper-local' : `video-wrapper-${userId}`);

// Creates the tile on first sight and keeps its name current afterwards.
// Built with DOM calls, so a hostile display name is only ever text.
export function ensureTile(userId: string, partner?: Participant) {
    const name = partner?.username || 'Partner';
    let video = document.getElementById(`video-${userId}`) as HTMLVideoElement | null;
    if (video) {
        if (partner) labelTile(userId, partner);
        return video;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'video-wrapper fade-in';
    wrapper.id = `video-wrapper-${userId}`;
    // A stable hue per person, within 45° of the sky so it stays in the same family.
    wrapper.style.setProperty('--shift', String([...userId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 90 - 45));
    video = Object.assign(document.createElement('video'), { id: `video-${userId}`, autoplay: true, playsInline: true });
    const tag = Object.assign(document.createElement('span'), { className: 'name-tag', id: `name-tag-${userId}` });
    tag.append(Object.assign(document.createElement('i'), { className: 'dot green' }), document.createElement('b'), document.createElement('small'));
    const placeholder = Object.assign(document.createElement('div'), { className: 'dummy-placeholder hidden', id: `dummy-${userId}` });
    placeholder.append(
        Object.assign(document.createElement('div'), { className: 'avatar', textContent: initial(name) }),
        Object.assign(document.createElement('div'), { className: 'text', textContent: 'Camera off' })
    );
    wrapper.append(video, tag, placeholder);
    videoGrid.appendChild(wrapper);
    if (partner) labelTile(userId, partner);
    return video;
}

// Name and live status ("Deep Focus", "On Break") sit on the tile itself.
function labelTile(userId: string, partner: Participant) {
    const tag = document.getElementById(`name-tag-${userId}`)!;
    const status = String(partner.presence?.status || partner.status || 'Online').replace(/^[🟢🟡]\s*/u, '');
    tag.querySelector('b')!.textContent = partner.username || 'Partner';
    tag.querySelector('small')!.textContent = status === 'Online' ? '' : status;
    tag.querySelector('i')!.className = `dot ${status.includes('Break') ? 'yellow' : 'green'}`;
}

export function attachStream(userId: string, stream: MediaStream, partner?: Participant) {
    const video = ensureTile(userId, partner);
    if (video.srcObject !== stream) video.srcObject = stream;
    video.play().catch(() => {
        // Autoplay with sound can be refused once the join gesture has expired; muted playback is always allowed.
        video.muted = true;
        video.play().catch(error => console.error('Remote video could not play:', error));
    });
}

export const removeTile = (userId: string) => document.getElementById(`video-wrapper-${userId}`)?.remove();
export const setCameraOff = (userId: string, off: boolean) => document.getElementById(`dummy-${userId}`)?.classList.toggle('hidden', !off);

export function showReaction(userId: string, emoji: string) {
    const wrapper = wrapperFor(userId);
    if (!wrapper) return;
    const el = Object.assign(document.createElement('div'), { className: 'floating-reaction', textContent: emoji });
    wrapper.appendChild(el);
    setTimeout(() => el.remove(), 1800);
}

export function setHandRaised(userId: string, raised: boolean) {
    const wrapper = wrapperFor(userId);
    if (!wrapper) return;
    const badge = wrapper.querySelector('.hand-raised-badge');
    if (raised && !badge) wrapper.appendChild(Object.assign(document.createElement('span'), { className: 'hand-raised-badge', textContent: '✋' }));
    else if (!raised) badge?.remove();
}
