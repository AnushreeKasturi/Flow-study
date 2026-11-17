// Your profile: name, and focus stats with a seven-day chart (also used on Home).
import type { ProfileStats } from '../types';
import { byId, on } from '../dom';
import { setMarkup } from '../modules/markup';
import { notify, openModal, closeModal } from '../modules/feedback';
import { formatFocusTime, updatePresence } from '../modules/presence';
import { getStats as getProfileStats, saveDisplayName, withLiveFocus, dayKey } from '../modules/profile';
import { getMyUserId, updateMyUsername } from '../modules/socket';
import * as UI from '../modules/ui';
import { refreshBoard } from './hosting';
import { here } from './state';

// Seven days of focus as small bars, oldest first; today includes time still in progress.
// Six months of focus, one square per day, like GitHub's contribution graph: weeks run left to
// right (Sunday on top), and the shade says how long you focused that day. Today includes time
// still running. Only numbers and dates go into the markup.
const LEVELS = [0, 1, 30, 60, 120]; // minutes: none, a little, half an hour, an hour, two hours+
const WEEKS = 26;
// Phones have no hover: a tap shows a square's tip, and a tap anywhere else hides it.
document.addEventListener('click', event => {
    const cell = event.target instanceof Element ? event.target.closest('.heatmap-grid i') : null;
    document.querySelectorAll('.heatmap-grid i.tip-open').forEach(open => { if (open !== cell) open.classList.remove('tip-open'); });
    cell?.classList.toggle('tip-open');
});
export function heatmap(stats: ProfileStats) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - (WEEKS - 1) * 7 - today.getDay());
    const month = new Intl.DateTimeFormat(undefined, { month: 'short' });
    const label = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
    let cells = '', months = '', lastMonth = -1, focusedDays = 0, totalMinutes = 0, longest = 0, run = 0;
    for (let day = new Date(start), index = 0; day <= today; day.setDate(day.getDate() + 1), index++) {
        const column = Math.floor(index / 7) + 1;
        const minutes = day.getTime() === today.getTime() ? stats.todayMinutes : Math.floor((stats.daySeconds[dayKey(day)] || 0) / 60);
        const level = LEVELS.filter(threshold => minutes >= threshold).length - 1;
        if (day.getDay() === 0 && day.getMonth() !== lastMonth) {
            lastMonth = day.getMonth();
            // A month with only its last week or two on the left edge would collide with the next one's name.
            if (column > 1 || day.getDate() <= 14) months += `<span style="grid-column:${column}">${month.format(day)}</span>`;
        }
        if (minutes > 0) { focusedDays++; totalMinutes += minutes; run++; longest = Math.max(longest, run); } else run = 0;
        // The tip opens to the right near the left edge and to the left near the right, so it stays on screen.
        const edge = column <= 5 ? ' tip-start' : column > WEEKS - 5 ? ' tip-end' : '';
        cells += `<i class="l${level}${edge}" style="grid-column:${column};grid-row:${day.getDay() + 2}" data-tip="${label.format(day)} · ${minutes ? formatFocusTime(minutes) + ' focused' : 'No focus'}"></i>`;
    }
    const summary = `${formatFocusTime(totalMinutes)} over ${focusedDays} day${focusedDays === 1 ? '' : 's'} in the last 6 months. Longest streak: ${longest} day${longest === 1 ? '' : 's'}.`;
    return `<figure class="heatmap"><div class="heatmap-grid" role="img" aria-label="Focus each day for the last 6 months. ${summary}">${months}${cells}</div>` +
        `<figcaption><span>${summary}</span><span class="heatmap-key" aria-hidden="true">Less <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> More</span></figcaption></figure>`;
}

export function weekChart(stats: ProfileStats) {
    const minutes = stats.weekSeconds.map((seconds, index) => index === 6 ? stats.todayMinutes : Math.floor(seconds / 60));
    const peak = Math.max(...minutes, 1);
    const days = minutes.map((value, index) => {
        const date = new Date();
        date.setDate(date.getDate() - (6 - index));
        const day = date.toLocaleDateString(undefined, { weekday: 'short' });
        return { day, value, tip: `${index === 6 ? 'Today' : day}: ${formatFocusTime(value)}` };
    });
    return `<div class="week" role="img" aria-label="Focus over the last seven days. ${days.map(d => d.tip).join(', ')}.">` +
        days.map((d, index) => `<div class="week-day${index === 6 ? ' today' : ''}" data-tip="${d.tip}"><i style="height:${Math.round(d.value / peak * 58)}px"></i>${d.day.charAt(0)}</div>`).join('') + '</div>';
}

function renderProfileStats(stats: ProfileStats) {
    const week = weekChart(stats);
    const note = stats.liveMinutes ? `Includes ${stats.liveMinutes} live minute${stats.liveMinutes === 1 ? '' : 's'} from this visit.` : 'Your focus time, one session at a time.';
    const rows = [
        ['All-time focus', formatFocusTime(stats.totalMinutes)],
        ['Current streak', `${stats.streak} day${stats.streak === 1 ? '' : 's'}`],
        ['Completed sessions', stats.sessionsCompleted],
        ['Completed tasks', stats.tasksCompleted]
    ];
    const markup = `<div class="focus-summary"><div><span>Focused today</span><strong id="profile-today-value">${formatFocusTime(stats.todayMinutes)}</strong><p>${note}</p></div>${week}</div>` +
        `<dl class="profile-stat-list">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>` + heatmap(stats);
    const container = byId<HTMLElement>('profile-stats');
    if (container.innerHTML !== markup) setMarkup(container, markup);
}
const profileOpen = () => !byId<HTMLElement>('profile-modal').classList.contains('hidden');

async function openProfile() {
    openModal('profile-modal');
    byId<HTMLInputElement>('profile-display-name-input').value = here.username;
    byId<HTMLElement>('profile-avatar').textContent = UI.initial(here.username);
    const statsEl = byId<HTMLElement>('profile-stats');
    cachedProfileStats = null;
    statsEl.replaceChildren(Object.assign(document.createElement('p'), { className: 'panel-description', textContent: 'Loading…' }));
    try {
        cachedProfileStats = await getProfileStats(getMyUserId());
        renderProfileStats(withLiveFocus(cachedProfileStats));
    } catch {
        statsEl.textContent = 'Stats are unavailable right now. Close and reopen your profile to retry.';
    }
}

async function saveProfileName() {
    const input = byId<HTMLInputElement>('profile-display-name-input');
    const button = byId<HTMLButtonElement>('save-profile-name-btn');
    const newName = input.value.trim();
    if (!newName || newName.length > 40) { input.reportValidity(); return; }
    button.textContent = 'Saving…';
    button.disabled = true;
    const saved = await saveDisplayName(getMyUserId(), newName);
    button.textContent = 'Save Name';
    button.disabled = false;
    if (!saved) { notify('Your name could not be saved. Please try again.', 'error'); return; }

    here.username = newName;
    updateMyUsername(newName);
    updatePresence({});
    byId<HTMLElement>('local-dummy-avatar').textContent = byId<HTMLElement>('profile-avatar').textContent = UI.initial(newName);
    notify('Display name saved.');
    refreshBoard(); // a listed room shows the host's new name straight away
}


let cachedProfileStats: ProfileStats | null = null;

// The presence card opens it; live focus time keeps its numbers current while open.
export function bindProfile() {
    const profileCard = byId<HTMLElement>('my-presence-card');
    profileCard.addEventListener('click', openProfile);
    profileCard.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProfile(); }
    });
    on('close-profile-btn', closeModal);
    on('save-profile-name-btn', saveProfileName);
    document.addEventListener('focus-progress', () => {
        if (cachedProfileStats && profileOpen()) renderProfileStats(withLiveFocus(cachedProfileStats));
    });
    document.addEventListener('session-completed', async () => {
        cachedProfileStats = null;
        if (!profileOpen()) return;
        try {
            cachedProfileStats = await getProfileStats(getMyUserId());
            renderProfileStats(withLiveFocus(cachedProfileStats));
        } catch { notify('Your focus summary could not be refreshed. Reopen it to retry.', 'error'); }
    });
}
