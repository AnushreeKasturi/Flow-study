// The transition loader: a small sun peeking over a horizon, shown only while
// something genuinely takes time (entering or leaving a room, signing in or out).
//
// - It appears only if the wait outlasts SHOW_AFTER, so fast transitions never flash it.
// - Once visible it stays at least MIN_VISIBLE, so it never blinks on and off.
// - Before a page change it leaves a note, and public/js/boot.js shows it on the next
//   page straight away, so the two pages hand over without a gap.
// - Whatever happens, it gives up after GIVE_UP, so nobody is left behind it.
// A room usually opens in about a third of a second; only a wait well past that shows it.
const SHOW_AFTER = 650, MIN_VISIBLE = 500, GIVE_UP = 12000;
const root = document.documentElement;
let shownAt = 0;
let pending: ReturnType<typeof setTimeout> | undefined;
let safety: ReturnType<typeof setTimeout> | undefined;

const text = (message?: string) => {
    const el = document.getElementById('loader-text');
    if (el && message) el.textContent = message;
};

function reveal() {
    root.classList.add('is-loading');
    shownAt = Date.now();
    clearTimeout(safety);
    safety = setTimeout(hideLoader, GIVE_UP);
}

// Changes what the loader says without changing whether or when it shows.
export const loaderText = (message: string) => text(message);

// Shows the loader if the wait lasts; returns the function that ends it.
export function showLoader(message: string, delay = SHOW_AFTER) {
    text(message);
    clearTimeout(pending);
    if (delay <= 0) reveal(); else pending = setTimeout(reveal, delay);
    return hideLoader;
}

export function hideLoader() {
    clearTimeout(pending);
    // A page that held the loader through its own start-up lets it go here too.
    root.classList.remove('is-booting');
    delete root.dataset.hold;
    if (!root.classList.contains('is-loading')) return;
    const wait = Math.max(0, MIN_VISIBLE - (Date.now() - shownAt));
    setTimeout(() => { root.classList.remove('is-loading'); clearTimeout(safety); }, wait);
}

// For a page change that will take a moment on the other side: show the loader
// now and ask the next page to keep it up until it is ready.
export function leaveWithLoader(url: string, message: string, replace = false) {
    showLoader(message, 0);
    try { sessionStorage.setItem('flow_loader', message); } catch { /* the next page simply starts without it */ }
    if (replace) location.replace(url); else location.href = url;
}

// Every page: a loader carried over from the previous page, or shown during
// start-up, ends once this page has loaded, unless the page holds it (the room
// page does, and ends it itself when its home screen or room is ready).
export function releaseWhenLoaded() {
    if (root.classList.contains('is-loading')) { shownAt = Date.now(); safety = setTimeout(hideLoader, GIVE_UP); }
    if (root.dataset.hold) { safety = setTimeout(hideLoader, GIVE_UP); return; }
    if (document.readyState === 'complete') hideLoader();
    else addEventListener('load', hideLoader, { once: true });
}
