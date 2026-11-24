// Home, before you join a room: your name, your week, groups with a free seat,
// and the "Start a room" card.
import type { GroupDetails } from '../types';
import { byId, on } from '../dom';
import { setMarkup } from '../modules/markup';
import { fetchOpenRooms, hostedBy, statusOf, takeSeat, watchBoard } from '../modules/board';
import { formatFocusTime } from '../modules/presence';
import { getMyProfile, getStats as getProfileStats, saveDisplayName } from '../modules/profile';
import * as UI from '../modules/ui';
import { setFromBoard } from './hide-ip';
import { weekChart, heatmap } from './profile';
import { here } from './state';
import { read, write } from '../modules/storage';

export interface HomeActions {
    join: (code: string) => Promise<void>;
    create: (open?: Omit<GroupDetails, 'host_name'> & { planId?: string }) => Promise<void>;
    showError: (message: string) => void;
}

// Home: who you are and how your week went on the left; groups open right now on the right.
export async function showHome(user: { id: string; email: string }, actions: HomeActions) {
    const { join, create: createRoom, showError: showLobbyError } = actions;
    const hostBtn = byId<HTMLButtonElement>('host-btn');
    const appContainer = byId<HTMLElement>('app');
    const recap = read('flow_recap', 'session');
    write('flow_recap', null, 'session');
    if (recap) byId<HTMLElement>('lobby-recap').textContent = recap;
    const notice = read('flow_notice', 'session');
    write('flow_notice', null, 'session');
    if (notice) showLobbyError(notice);

    const setName = (name: string) => {
        byId<HTMLElement>('join-title').textContent = `Hi, ${name}.`;
        byId<HTMLElement>('home-avatar').textContent = UI.initial(name);
        byId<HTMLInputElement>('home-name-input').value = name;
    };
    setName(user.email.split('@')[0]);
    // A new account names itself on the welcome step, after Home is already drawn.
    document.addEventListener('flow-name', event => setName((event as CustomEvent<string>).detail));
    getMyProfile(user.id).then(profile => { if (profile?.display_name) setName(profile.display_name); });
    const nameForm = byId<HTMLFormElement>('home-name-form');
    on('home-edit-name', () => { nameForm.classList.toggle('hidden'); byId<HTMLInputElement>('home-name-input').select(); });
    nameForm.addEventListener('submit', async event => {
        event.preventDefault();
        const name = byId<HTMLInputElement>('home-name-input').value.trim();
        if (!name) return;
        if (!await saveDisplayName(user.id, name)) { showLobbyError('Your name could not be saved. Check your connection and try again.'); return; }
        setName(name);
        nameForm.classList.add('hidden');
    });

    getProfileStats(user.id).then(stats => {
        // A brand-new account gets one inviting line instead of a museum of zeros.
        if (!stats.totalMinutes && !stats.sessionsCompleted) return setMarkup(byId<HTMLElement>('home-stats'), '<p class="home-fresh">Nothing on the clock yet. Your first focus block starts the streak.</p><div class="week-suns" aria-hidden="true">' + '<i></i>'.repeat(6) + '<i class="today"></i></div>');
        // Numbers and locale weekday names only; nothing here comes from another user.
        setMarkup(byId<HTMLElement>('home-stats'),
            `<div class="home-today"><div><span>Focused today</span><strong>${formatFocusTime(stats.todayMinutes)}</strong><button type="button" class="home-year-btn" aria-expanded="false" aria-controls="home-year">Last 6 months</button></div>${weekChart(stats)}</div>` +
            `<dl class="home-figures"><div><dt>Streak</dt><dd>${stats.streak} day${stats.streak === 1 ? '' : 's'}</dd></div><div><dt>All time</dt><dd>${formatFocusTime(stats.totalMinutes)}</dd></div><div><dt>Sessions</dt><dd>${stats.sessionsCompleted}</dd></div></dl>` + heatmap(stats).replace('<figure class="heatmap"', '<figure id="home-year" class="heatmap"'));
    }).catch(() => {});

    // Where the heatmap can't fit inline, it waits behind a button and opens as a panel inside the block,
    // because Home doesn't scroll, not even for a very good streak.
    const stats = byId<HTMLElement>('home-stats');
    const yearButton = () => stats.querySelector<HTMLButtonElement>('.home-year-btn');
    const showYear = (open: boolean) => { stats.classList.toggle('year-open', open); yearButton()?.setAttribute('aria-expanded', String(open)); };
    stats.addEventListener('click', event => { if ((event.target as Element).closest('.home-year-btn')) showYear(!stats.classList.contains('year-open')); });
    document.addEventListener('click', event => { if (stats.classList.contains('year-open') && !stats.contains(event.target as Node)) showYear(false); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && stats.classList.contains('year-open')) { showYear(false); yearButton()?.focus(); } });

    // Open groups on Home stay current: the board's ping refreshes them within a second.
    const homeGroups = () => fetchOpenRooms().then(rooms => {
        const free = rooms.filter(room => !room.closed && room.seats_taken < room.seats && (room.host_id !== user.id || !!room.away_until));
        byId<HTMLElement>('lobby-board').replaceChildren(Object.assign(document.createElement('a'), {
            href: '/groups.html', textContent: free.length ? `${free.length} group${free.length === 1 ? ' has' : 's have'} a free seat right now` : 'No group is open this minute. See what’s planned'
        }), '.');
        byId<HTMLElement>('home-groups').replaceChildren(...free.slice(0, 3).map(room => {
            const item = document.createElement('li');
            const text = document.createElement('div');
            text.append(Object.assign(document.createElement('strong'), { textContent: room.topic }), Object.assign(document.createElement('span'), { textContent: `${room.host_id === user.id ? 'Your room' : hostedBy(room)}, ${statusOf(room).toLowerCase()}` }));
            const sit = Object.assign(document.createElement('button'), { className: 'btn btn-primary', type: 'button', textContent: room.host_id === user.id ? 'Return' : 'Join' });
            sit.setAttribute('aria-label', `Take a seat in ${room.topic}`);
            sit.addEventListener('click', async () => {
                if (here.busy) return;
                sit.disabled = true;
                setFromBoard(true);
                const seat = await takeSeat(room.id);
                if ('code' in seat) await join(seat.code);
                else { showLobbyError(seat.reason); sit.disabled = false; }
            });
            item.append(text, sit);
            return item;
        }));
    }).catch(() => {});
    homeGroups();
    watchBoard(() => { if (!appContainer.classList.contains('hidden')) return; homeGroups(); });

    // An open group's details, summed up on one line; the panel that edits them sits over the card.
    const details = byId<HTMLDetailsElement>('create-details');
    const optionText = (id: string) => byId<HTMLSelectElement>(id).selectedOptions[0]?.textContent ?? '';
    const summarise = () => { const line = byId<HTMLElement>('create-summary'); line.title = line.textContent = `${optionText('create-subject')} · ${optionText('create-seats')} seats · Cameras ${optionText('create-camera').toLowerCase()} · ${optionText('create-vibe')}`; };
    ['create-subject', 'create-seats', 'create-camera', 'create-vibe'].forEach(id => byId(id).addEventListener('change', summarise));
    summarise();
    on('create-details-done', () => { details.open = false; details.querySelector('summary')!.focus(); });
    details.addEventListener('keydown', event => { if (event.key === 'Escape' && details.open) { event.stopPropagation(); details.open = false; details.querySelector('summary')!.focus(); } });
    // These small menus close on a click anywhere else, or Escape, like the bell does.
    const menus = () => document.querySelectorAll<HTMLDetailsElement>('.reactions-menu[open], #create-details[open]');
    document.addEventListener('click', event => {
        const target = event.target as Node;
        if (target.isConnected) menus().forEach(menu => { if (!menu.contains(target)) menu.open = false; });
    });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') menus().forEach(menu => { menu.open = false; }); });
    // "Start a room": the audience choice swaps between a PIN and a board topic.
    const audience = () => (document.querySelector<HTMLInputElement>('input[name="audience"]:checked')!).value;
    document.querySelectorAll('input[name="audience"]').forEach(radio => radio.addEventListener('change', () => {
        byId('create-private').classList.toggle('hidden', audience() === 'open');
        byId('create-open').classList.toggle('hidden', audience() !== 'open');
        hostBtn.textContent = audience() === 'open' ? 'Open a study group' : 'Create a room';
    }));
    on('host-btn', () => {
        if (audience() !== 'open') return createRoom();
        const topic = byId<HTMLInputElement>('create-topic').value.trim();
        if (topic.length < 3) { showLobbyError('Say what you’re studying, so people know what the group is for.'); byId('create-topic').focus(); return; }
        createRoom({ topic, subject: byId<HTMLSelectElement>('create-subject').value, seats: Number(byId<HTMLSelectElement>('create-seats').value), camera: byId<HTMLSelectElement>('create-camera').value, vibe: byId<HTMLSelectElement>('create-vibe').value });
    });
}
