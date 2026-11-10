import { byId } from './dom';
import { currentTheme, setTheme, type Theme } from './theme';

// Signed-in visitors skip the login step.
try {
    if (localStorage.getItem('flow_user')) {
        const login = byId<HTMLAnchorElement>('nav-login');
        login.textContent = 'Open your room';
        login.href = '/room.html';
        document.querySelectorAll<HTMLAnchorElement>('[data-start]').forEach(link => { link.href = '/room.html'; link.textContent = 'Open your room'; });
        document.querySelectorAll<HTMLElement>('[data-login]').forEach(link => link.remove());
    }
} catch { /* Storage blocked: the default links still work. */ }

// Hero demo: a whole 25-minute focus block, played in ten seconds, so a
// visitor sees the one idea (the sun is the timer) before reading anything.
const time = byId<HTMLElement>('preview-time');
const label = byId<HTMLElement>('preview-label');
const toggle = byId<HTMLButtonElement>('preview-toggle');
const root = document.body;
const DEMO_MS = 10000, BLOCK_SECONDS = 25 * 60;
let playing = false;

toggle.addEventListener('click', () => {
    if (playing) return;
    playing = true;
    toggle.disabled = true;
    label.textContent = 'The sun sinks as the block runs…';
    const started = performance.now();
    const frame = (now: number) => {
        const progress = Math.min(1, (now - started) / DEMO_MS);
        const left = Math.round(BLOCK_SECONDS * (1 - progress));
        time.textContent = String(Math.floor(left / 60)).padStart(2, '0') + ':' + String(left % 60).padStart(2, '0');
        root.style.setProperty('--sun-y', String(progress));
        if (progress < 1) return requestAnimationFrame(frame);
        label.textContent = 'Sunset. Everyone in the room takes a break together.';
        setTimeout(() => {
            root.style.removeProperty('--sun-y');
            time.textContent = '25:00';
            label.textContent = 'Watch a 25-minute focus block in ten seconds.';
            playing = toggle.disabled = false;
        }, 2600);
    };
    requestAnimationFrame(frame);
});

// Atmosphere swatches retheme the page, and the choice carries into the room.
const swatches = document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]');
const markTheme = () => swatches.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === currentTheme())));
swatches.forEach(button => button.addEventListener('click', () => { setTheme(button.dataset.themeChoice as Theme); markTheme(); }));
markTheme();

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
