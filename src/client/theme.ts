// The saved atmosphere is applied before first paint by the inline script in Head.astro.
export const SKIES = [
    ['forest', 'Forest'], ['midnight', 'Midnight'], ['warm', 'Warm'], ['aqua', 'Aqua'], ['amethyst', 'Amethyst'],
    ['desert', 'Desert'], ['aurora', 'Aurora'], ['storm', 'Storm'], ['sakura', 'Sakura'], ['ember', 'Ember'],
    ['dawn', 'Dawn'], ['daylight', 'Daylight'], ['glacier', 'Glacier'], ['mist', 'Mist'], ['meadow', 'Meadow']
] as const;
export type Theme = typeof SKIES[number][0];
const THEMES: readonly string[] = SKIES.map(([id]) => id);

export function currentTheme(): Theme {
    const saved = document.documentElement.dataset.theme as Theme;
    return THEMES.includes(saved) ? saved : 'forest';
}

export function setTheme(theme: Theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('flow_theme', theme); } catch { /* Private mode: applies for this page only. */ }
    document.dispatchEvent(new CustomEvent('flow-theme', { detail: theme }));
    syncThemeColor();
}

// The browser's bars and the installed app's title bar take the top of the sky.
// Read from a probe element: the page itself eases between skies, so its own
// value is still mid-transition right after a change.
export function syncThemeColor() {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) return;
    const probe = Object.assign(document.createElement('i'), { hidden: true });
    probe.dataset.theme = currentTheme();
    document.body.append(probe);
    const color = getComputedStyle(probe).getPropertyValue('--sky-top').trim();
    probe.remove();
    if (color) meta.content = color;
}

// The sky picker (src/components/SkyPicker.astro). Pointing at a sky, or arrowing to it, previews it on the
// page; choosing one saves it; Escape or clicking away puts the saved sky back.
export function bindThemePicker(button: HTMLButtonElement) {
    const list = button.nextElementSibling as HTMLElement;
    const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
    const name = button.querySelector('.sky-picker-name')!;
    const now = list.querySelector('.sky-picker-now')!;
    const COLUMNS = 5;
    let saved = currentTheme();
    const show = () => {
        const theme = currentTheme();
        name.textContent = SKIES.find(([id]) => id === theme)![1];
        options.forEach(option => option.setAttribute('aria-selected', String(option.dataset.value === theme)));
    };
    const preview = (theme: string) => { document.documentElement.dataset.theme = theme; };
    const open = () => {
        saved = currentTheme();
        list.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        // Placed against the window, so a panel that scrolls or clips (Home's card) can't cut it off:
        // below the button, or above it when there's more room there, and never past the window's edges.
        const box = button.getBoundingClientRect();
        const up = innerHeight - box.bottom < list.offsetHeight + 16 && box.top > innerHeight - box.bottom;
        list.classList.toggle('up', up);
        list.style.top = `${Math.max(8, up ? box.top - list.offsetHeight - 8 : box.bottom + 8)}px`;
        list.style.left = `${Math.min(Math.max(8, box.right - list.offsetWidth), innerWidth - list.offsetWidth - 8)}px`;
        (options.find(option => option.dataset.value === saved) ?? options[0]).focus();
    };
    const close = (choice?: string, refocus = true) => {
        if (list.hidden) return;
        list.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        if (choice) setTheme(choice as Theme); else preview(saved);
        if (refocus) button.focus();
    };
    button.addEventListener('click', () => (list.hidden ? open() : close()));
    options.forEach((option, index) => {
        option.addEventListener('pointerenter', () => option.focus());
        option.addEventListener('focus', () => { preview(option.dataset.value!); now.textContent = option.textContent; });
        option.addEventListener('click', () => close(option.dataset.value));
        option.addEventListener('keydown', event => {
            const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: COLUMNS, ArrowUp: -COLUMNS, Home: -index, End: options.length - 1 - index };
            if (event.key in moves) {
                event.preventDefault();
                options[Math.min(options.length - 1, Math.max(0, index + moves[event.key]))].focus();
            } else if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                close(option.dataset.value);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                close();
            } else if (event.key === 'Tab') close(undefined, false);
        });
    });
    document.addEventListener('pointerdown', event => { if (!button.parentElement!.contains(event.target as Node)) close(undefined, false); });
    addEventListener('resize', () => close(undefined, false));
    document.addEventListener('flow-theme', show);
    show();
}
