// Video tiles on the stage: one per participant, plus reactions and raised hands.
import type { Participant } from '../types';
import { byId } from '../dom';
import { getMyUserId } from './socket';
import { currentUser } from './session';
import { initial } from './ui';
import { AWAY_STATUSES } from './presence';

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
    // Shown to the room's host only (CSS keys off body.is-host).
    const remove = Object.assign(document.createElement('button'), { className: 'tile-remove', type: 'button', textContent: 'Remove' });
    remove.setAttribute('aria-label', `Remove ${name} from the room`);
    remove.addEventListener('click', () => document.dispatchEvent(new CustomEvent('flow-remove', { detail: userId })));
    wrapper.append(video, tag, placeholder, remove);
    videoGrid.appendChild(wrapper);
    if (partner) labelTile(userId, partner);
    markHost(wrapper);
    return video;
}

// Name and live status ("Deep Focus", "On Break") sit on the tile itself.
function labelTile(userId: string, partner: Participant) {
    const tag = document.getElementById(`name-tag-${userId}`)!;
    const status = String(partner.presence?.status || partner.status || 'Online').replace(/^[🟢🟡]\s*/u, '');
    tag.querySelector('b')!.textContent = partner.username || 'Partner';
    tag.querySelector('small')!.textContent = status === 'Online' ? '' : status;
    const away = AWAY_STATUSES.includes(status);
    tag.querySelector('i')!.className = `dot ${away ? 'away' : status.includes('Break') ? 'yellow' : 'green'}`;
    setAwayTile(userId, away);
}

export const setAwayTile = (userId: string, away: boolean) => wrapperFor(userId)?.classList.toggle('is-away', away);

// Shows "Host" on the host's tile, and nowhere else. Called whenever the host changes.
let hostId = '';
export function setHost(newHostId: string) {
    hostId = newHostId;
    document.querySelectorAll<HTMLElement>('.video-wrapper').forEach(markHost);
}
function markHost(wrapper: HTMLElement) {
    const userId = wrapper.id === 'video-wrapper-local' ? currentUser()?.id : wrapper.id.replace('video-wrapper-', '');
    const tag = wrapper.querySelector('.name-tag');
    if (!tag) return;
    const badge = tag.querySelector('.host-badge');
    if (userId === hostId && !badge) tag.append(Object.assign(document.createElement('span'), { className: 'host-badge', textContent: 'Host' }));
    else if (userId !== hostId) badge?.remove();
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

// Shown the moment someone's presence drops. If they are back within the grace
// period the note is removed and the tile carries on as if nothing happened.
export function markLeft(userId: string, left: boolean, name = 'Your partner') {
    const wrapper = document.getElementById(`video-wrapper-${userId}`);
    if (!wrapper) return;
    wrapper.classList.toggle('left', left);
    wrapper.querySelector('.left-note')?.remove();
    if (!left) return;
    const note = Object.assign(document.createElement('div'), { className: 'left-note' });
    note.append(
        Object.assign(document.createElement('span'), { textContent: '👋' }),
        Object.assign(document.createElement('strong'), { textContent: `${name} left the room` }),
        Object.assign(document.createElement('small'), { textContent: 'Their tile will clear in a moment.' })
    );
    wrapper.appendChild(note);
}

export const removeTile = (userId: string) => document.getElementById(`video-wrapper-${userId}`)?.remove();
export const setCameraOff = (userId: string, off: boolean) => document.getElementById(`dummy-${userId}`)?.classList.toggle('hidden', !off);

// Reactions are thrown into the tile from a side, bounce off its edges and each
// other, and settle on the floor: a few seconds of play, then they fade away.
// Each tile runs one small simulation for all of its reactions.
type Body = { el: HTMLElement; x: number; y: number; vx: number; vy: number; spin: number; born: number };
const LIFE = 4500, FADE_IN = 300, FADE_OUT = 800, R = 22, GRAVITY = 1700, BOUNCE = .6, MAX_PER_TILE = 14;
const tiles = new WeakMap<HTMLElement, Body[]>();

export function showReaction(userId: string, emoji: string) {
    const wrapper = wrapperFor(userId);
    // The reaction bar's own icon, so the thrown one always matches the button.
    const icon = document.querySelector(`.reaction-btn[data-emoji="${CSS.escape(emoji)}"]`) as HTMLElement | null;
    if (!wrapper || !icon) return;
    const el = Object.assign(document.createElement('div'), { className: 'floating-reaction' });
    el.dataset.kind = icon.dataset.kind;
    el.append(icon.querySelector('svg')!.cloneNode(true));
    wrapper.appendChild(el);
    const width = wrapper.clientWidth, height = wrapper.clientHeight;

    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        // No throwing: it appears somewhere along the bottom, then fades.
        el.style.transform = `translate(${R + Math.random() * Math.max(0, width - 4 * R)}px, ${height - 2 * R - 12}px)`;
        el.animate([{ opacity: 0 }, { opacity: 1, offset: .1 }, { opacity: 1, offset: .8 }, { opacity: 0 }], { duration: LIFE }).onfinish = () => el.remove();
        return;
    }
    const fromLeft = Math.random() < .5;
    const body: Body = {
        el, x: fromLeft ? R : width - R, y: height * (.2 + Math.random() * .3),
        vx: (fromLeft ? 1 : -1) * (380 + Math.random() * 420), vy: -(250 + Math.random() * 350),
        spin: 0, born: performance.now()
    };
    const bodies = tiles.get(wrapper) ?? [];
    bodies.push(body);
    while (bodies.length > MAX_PER_TILE) bodies.shift()!.el.remove();
    if (!tiles.has(wrapper)) { tiles.set(wrapper, bodies); requestAnimationFrame(now => simulate(wrapper, bodies, now)); }
}

function simulate(wrapper: HTMLElement, bodies: Body[], last: number) {
    const step = (now: number) => {
        const dt = Math.min((now - last) / 1000, 1 / 30);
        last = now;
        const width = wrapper.clientWidth, height = wrapper.clientHeight;
        for (const b of bodies) {
            b.vy += GRAVITY * dt;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx) * BOUNCE; }
            if (b.x > width - R) { b.x = width - R; b.vx = -Math.abs(b.vx) * BOUNCE; }
            if (b.y < R) { b.y = R; b.vy = Math.abs(b.vy) * BOUNCE; }
            if (b.y > height - R) {
                b.y = height - R;
                b.vy = Math.abs(b.vy) < 60 ? 0 : -Math.abs(b.vy) * BOUNCE;
                b.vx *= Math.pow(.15, dt); // rolling friction on the floor
            }
            b.spin += (b.vx * dt) / R; // rolls as it moves
        }
        // Reactions knock into each other like balls in a box.
        for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
            const a = bodies[i], b = bodies[j];
            const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
            if (!distance || distance >= 2 * R) continue;
            const nx = dx / distance, ny = dy / distance, push = (2 * R - distance) / 2;
            a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
            const closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
            if (closing < 0) {
                const impulse = -(1 + BOUNCE) * closing / 2;
                a.vx -= impulse * nx; a.vy -= impulse * ny; b.vx += impulse * nx; b.vy += impulse * ny;
            }
        }
        for (let i = bodies.length - 1; i >= 0; i--) {
            const b = bodies[i], age = now - b.born;
            if (age >= LIFE || !b.el.isConnected) { b.el.remove(); bodies.splice(i, 1); continue; }
            const appear = Math.min(1, age / FADE_IN);
            b.el.style.opacity = String(Math.min(appear, (LIFE - age) / FADE_OUT, 1));
            b.el.style.transform = `translate(${b.x - R}px, ${b.y - R}px) rotate(${b.spin}rad) scale(${.6 + .4 * appear})`;
        }
        if (bodies.length && wrapper.isConnected) requestAnimationFrame(step);
        else tiles.delete(wrapper);
    };
    requestAnimationFrame(step);
}

export function setHandRaised(userId: string, raised: boolean) {
    const wrapper = wrapperFor(userId);
    if (!wrapper) return;
    const badge = wrapper.querySelector('.hand-raised-badge');
    if (raised && !badge) {
        const hand = Object.assign(document.createElement('span'), { className: 'hand-raised-badge' });
        hand.setAttribute('aria-label', 'Hand raised');
        hand.append(byId('toggle-hand').querySelector('svg')!.cloneNode(true));
        wrapper.appendChild(hand);
    }
    else if (!raised) badge?.remove();
}
