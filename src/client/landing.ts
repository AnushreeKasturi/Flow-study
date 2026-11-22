import { byId } from './dom';
import { currentTheme, setTheme, type Theme } from './theme';

// Signed-in visitors' links point at Home; see src/client/nav.ts.

// Hero demo: a whole 25-minute focus block, played in ten seconds, so a
// visitor sees the one idea (the sun is the timer) before reading anything.
const time = byId<HTMLElement>('preview-time');
const label = byId<HTMLElement>('preview-label');
const toggle = byId<HTMLButtonElement>('preview-toggle');
const root = document.body;
const DEMO_MS = 10000, BLOCK_SECONDS = 25 * 60;
let playing = false;

function playSunset() {
    if (playing) return;
    playing = true;
    toggle.disabled = true;
    label.textContent = 'The sun sinks as the block runs…';
    root.classList.add('sun-driven'); // frame-by-frame position; the usual easing would fight it
    const started = performance.now();
    const frame = (now: number) => {
        const progress = Math.min(1, (now - started) / DEMO_MS);
        const left = Math.round(BLOCK_SECONDS * (1 - progress));
        time.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');
        root.style.setProperty('--sun-y', String(progress));
        if (progress < 1) return requestAnimationFrame(frame);
        label.textContent = 'Sunset. Everyone in the room takes a break together.';
        setTimeout(() => {
            root.classList.remove('sun-driven');
            root.style.removeProperty('--sun-y');
            time.textContent = '25:00';
            label.textContent = 'Watch a 25-minute focus block in ten seconds.';
            playing = toggle.disabled = false;
        }, 2600);
    };
    requestAnimationFrame(frame);
}
toggle.addEventListener('click', playSunset);
// The sun sets once on its own, right after the intro bows out. Reduced motion keeps the sun where it is.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) setTimeout(playSunset, document.documentElement.classList.contains('intro-seen') ? 900 : 3400);

// Atmosphere swatches retheme the page, and the choice carries into the room.
const swatches = document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]');
const markTheme = () => swatches.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === currentTheme())));
swatches.forEach(button => button.addEventListener('click', () => { setTheme(button.dataset.themeChoice as Theme); markTheme(); }));
markTheme();

// The tour: the room still is a camera that visits each feature in turn, then hands you the remote.
const shot = byId<HTMLImageElement>('room-shot');
const stops = [...document.querySelectorAll<HTMLButtonElement>('.features button')];
const tour = byId<HTMLElement>('room');
const TOUR_MS = 4500;
let stop = 0, ticking = 0;
function visit(index: number) {
    stop = index;
    const button = stops[index], still = button.dataset.still;
    stops.forEach(other => other.setAttribute('aria-pressed', String(other === button)));
    shot.src = `/rooms/${currentTheme()}${still ? '-' + still : ''}.webp`;
    const [x, y, w, h] = (button.dataset.spot ?? '0 0 100 100').split(' ').map(Number);
    const zoom = Math.min(2.4, 100 / w, 100 / h);
    const pan = (start: number, size: number) => Math.min(0, Math.max(100 / zoom - 100, 50 / zoom - start - size / 2)); // centre it, never past the edge
    shot.style.transform = `scale(${zoom}) translate(${pan(x, w)}%, ${pan(y, h)}%)`;
}
const handOver = () => { clearInterval(ticking); ticking = 0; tour.classList.remove('touring'); };
stops.forEach((button, index) => {
    const take = () => { handOver(); visit(index); };
    button.addEventListener('pointerenter', take);
    button.addEventListener('click', take);
    button.addEventListener('focus', take);
});
// Plays only while you can see it, and never for people who asked the web to sit still.
if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    let handedOver = false;
    tour.addEventListener('pointerdown', () => { handedOver = true; }, { once: true });
    new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting || handedOver) return handOver();
        if (ticking) return;
        tour.classList.add('touring');
        visit(stop);
        ticking = window.setInterval(() => visit((stop + 1) % stops.length), TOUR_MS);
    }, { threshold: .3 }).observe(shot.parentElement!); // the frame, not the zooming photo inside it
    stops.forEach(button => button.addEventListener('pointerenter', () => { handedOver = true; }));
}
// A new sky re-dresses whatever the camera is looking at; the other stills wait in the wings.
const dressRoom = () => {
    visit(stop);
    for (const still of ['chat', 'sound']) new Image().src = `/rooms/${currentTheme()}-${still}.webp`;
};
document.addEventListener('flow-theme', dressRoom);
dressRoom();

// Live star count. Purely decorative, so any failure leaves the plain link.
(async () => {
    try {
        let stars = sessionStorage.getItem('flow_stars');
        if (stars === null) {
            const response = await fetch('https://api.github.com/repos/ManasDasri/Flow-study', { signal: AbortSignal.timeout(4000) });
            if (!response.ok) return;
            stars = String((await response.json()).stargazers_count);
            sessionStorage.setItem('flow_stars', stars);
        }
        if (/^\d+$/.test(stars)) document.querySelectorAll('[data-stars]').forEach(el => { el.textContent = Number(stars).toLocaleString(); });
    } catch { /* Offline or rate limited. */ }
})();

// How many groups are studying right now. The board code (and Supabase with it)
// loads only after the page is idle, so it never delays the landing page itself.
const whenIdle = window.requestIdleCallback ?? ((run: () => void) => setTimeout(run, 1500));
whenIdle(async () => {
    try {
        const { fetchOpenRooms, fetchPlanned } = await import('./modules/board');
        const [open, planned] = await Promise.all([fetchOpenRooms(), fetchPlanned()]);
        const link = byId<HTMLAnchorElement>('live-groups');
        if (open.length) { link.textContent = `${open.length} study group${open.length === 1 ? '' : 's'} open right now`; link.classList.add('live'); }
        else if (planned.length) link.textContent = `${planned.length} study group${planned.length === 1 ? '' : 's'} planned`;
    } catch { /* The plain link stays. */ }
});
