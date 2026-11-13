// The saved atmosphere is applied before first paint by the inline script in Head.astro.
export const SKIES = [
    ['forest', 'Forest'], ['midnight', 'Midnight'], ['warm', 'Warm'], ['aqua', 'Aqua'], ['amethyst', 'Amethyst'],
    ['desert', 'Desert'], ['aurora', 'Aurora'], ['storm', 'Storm'], ['dawn', 'Dawn'], ['daylight', 'Daylight']
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

export function bindThemePicker(picker: HTMLSelectElement) {
    picker.value = currentTheme();
    picker.addEventListener('change', () => setTheme(picker.value as Theme));
    document.addEventListener('flow-theme', () => { picker.value = currentTheme(); });
}
