// Study-groups board page. Readable by anyone; joining and hosting need an account.
import { byId } from './dom';
import type { GroupDetails, OpenRoom, PlannedGroup } from './types';
import { fetchOpenRooms, fetchPlanned, fetchMyPlans, takeSeat, planGroup, cancelPlan, setGoing, report, statusOf, hostedBy, watchBoard, labelOf, SUBJECTS, CAMERAS, VIBES } from './modules/board';
import { getMyProfile } from './modules/profile';
import { loadUser } from './modules/session';
import { showLoader, hideLoader, leaveWithLoader } from './loader';

// Signed-out visitors can read the board; the session decides what they can do on it.
const user = await loadUser();
const message = byId<HTMLElement>('board-message');
const search = byId<HTMLInputElement>('board-search');
let rooms: OpenRoom[] = [];
let plans: PlannedGroup[] = [];
let mine = new Set<string>();
let subject = '';
let busy = false;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
};
const say = (text: string) => { message.textContent = text; };
const matches = (group: GroupDetails) => (!subject || group.subject === subject) && group.topic.toLowerCase().includes(search.value.trim().toLowerCase());
const freeSeats = (room: OpenRoom) => room.closed ? 0 : Math.max(0, room.seats - room.seats_taken);

// Subject and house rules, shown the same way on both kinds of card.
const tags = (group: GroupDetails) => el('div', { className: 'tags' },
    el('span', { className: 'tag subject', textContent: labelOf(SUBJECTS, group.subject) }),
    el('span', { className: 'tag', textContent: labelOf(CAMERAS, group.camera) }),
    el('span', { className: 'tag', textContent: labelOf(VIBES, group.vibe) }));

// Two clicks, so a slip of the finger never files a report.
function reportButton(kind: 'open' | 'planned', group: { id: string; topic: string }) {
    const button = el('button', { className: 'report', type: 'button', textContent: 'Report' });
    button.addEventListener('click', async () => {
        if (button.textContent === 'Report') { button.textContent = 'Report this listing?'; return; }
        button.disabled = true;
        button.textContent = await report(kind, group.id, group.topic) ? 'Reported. Thank you.' : 'Already reported.';
    });
    return button;
}

async function sit(room: OpenRoom) {
    if (busy) return;
    busy = true;
    showLoader('Finding your seat…');
    const result = await takeSeat(room.id).catch((): { reason: string } => ({ reason: 'Could not join this group. Check your connection and try again.' }));
    if ('code' in result) {
        // Handed over in sessionStorage, not the URL: a link must never be able to walk someone into a room with their camera on.
        sessionStorage.setItem('flow_join', result.code);
        leaveWithLoader('/room.html', 'Opening your room…');
        return;
    }
    hideLoader();
    busy = false;
    say(result.reason);
    load();
}

function roomCard(room: OpenRoom) {
    const free = freeSeats(room);
    const own = room.host_id === user?.id;
    const seats = el('div', { className: 'seats' });
    seats.setAttribute('role', 'img');
    seats.setAttribute('aria-label', `${Math.min(room.seats_taken, room.seats)} of ${room.seats} seats taken`);
    for (let i = 0; i < room.seats; i++) seats.append(el('i', { className: i < room.seats_taken ? 'taken' : '' }));
    const action = !user ? el('a', { className: 'btn', href: '/login.html', textContent: 'Log in to join' })
        : el('button', { className: 'btn btn-primary', type: 'button', textContent: own ? 'Return to your room' : room.closed ? 'Closed' : free ? 'Take a seat' : 'Full', disabled: !own && !free });
    if (action instanceof HTMLButtonElement) action.addEventListener('click', () => sit(room));
    return el('li', { className: 'group' },
        el('div', { className: 'group-main' },
            el('h3', { textContent: room.topic }),
            el('p', { className: 'group-status' }, el('i', { className: 'live' }), statusOf(room)),
            tags(room),
            el('p', { className: 'group-host' }, `${hostedBy(room)}${own ? ' (you)' : ''}`, user && !own ? reportButton('open', room) : '')),
        el('div', { className: 'group-seats' }, seats, el('span', { textContent: room.closed ? 'Not taking new people' : free ? `${free} seat${free === 1 ? '' : 's'} free` : 'No seats free' })),
        action);
}

const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
function when(startsAt: string) {
    const start = new Date(startsAt);
    const minutes = Math.round((start.getTime() - Date.now()) / 60000);
    const soon = minutes <= 0 ? 'Starting now' : minutes < 60 ? `In ${minutes} min` : minutes < 24 * 60 ? `In ${Math.round(minutes / 60)} h` : '';
    return (soon ? soon + ', ' : '') + day.format(start);
}

function planCard(plan: PlannedGroup) {
    const own = plan.host_id === user?.id;
    const going = mine.has(plan.id);
    const minutesAway = (new Date(plan.starts_at).getTime() - Date.now()) / 60000;
    const actions = el('div', { className: 'group-actions' });
    if (!user) actions.append(el('a', { className: 'btn', href: '/login.html', textContent: 'Log in to join' }));
    else if (own) {
        // The host opens the room themselves; from fifteen minutes before, the board offers to.
        const start = el('button', { className: 'btn btn-primary', type: 'button', textContent: 'Start now', disabled: minutesAway > 15 });
        start.title = minutesAway > 15 ? 'You can start this up to fifteen minutes early.' : '';
        start.addEventListener('click', () => hostNow({ ...plan, planId: plan.id }));
        const cancel = el('button', { className: 'btn', type: 'button', textContent: 'Cancel' });
        cancel.addEventListener('click', async () => { await cancelPlan(plan.id); load(); });
        actions.append(start, cancel);
    } else {
        const toggle = el('button', { className: 'btn' + (going ? '' : ' btn-primary'), type: 'button', textContent: going ? 'You’re in' : 'I’m in' });
        toggle.setAttribute('aria-pressed', String(going));
        toggle.addEventListener('click', async () => { toggle.disabled = true; await setGoing(plan.id, user.id, !going); load(); });
        actions.append(toggle);
    }
    return el('li', { className: 'group' },
        el('div', { className: 'group-main' },
            el('h3', { textContent: plan.topic }),
            el('p', { className: 'group-status', textContent: when(plan.starts_at) }),
            tags(plan),
            el('p', { className: 'group-host' }, `Hosted by ${plan.host_name}${own ? ' (you)' : ''}`, user && !own ? reportButton('planned', plan) : '')),
        el('div', { className: 'group-seats' }, el('strong', { textContent: String(plan.going) }), el('span', { textContent: `of ${plan.seats} going` })),
        actions);
}

const empty = (title: string, text: string) => el('li', { className: 'group-empty' }, el('strong', { textContent: title }), el('span', { textContent: text }));

function render() {
    const open = rooms.filter(matches), upcoming = plans.filter(matches);
    const filtered = !!subject || !!search.value.trim();
    byId('open-count').textContent = String(open.length);
    byId('planned-count').textContent = String(upcoming.length);
    byId('board-list').replaceChildren(...open.map(roomCard));
    byId('planned-list').replaceChildren(...upcoming.map(planCard));
    if (!open.length) byId('board-list').append(filtered
        ? empty('Nothing open matches that.', 'Clear the search, or host one yourself.')
        : empty('No groups are open right now.', 'Host one and it shows up here, or see what’s coming up below.'));
    if (!upcoming.length) byId('planned-list').append(empty(filtered ? 'Nothing planned matches that.' : 'Nothing is planned yet.', 'Pick “Later” when you host to put a time on the board.'));
}

async function load() {
    try {
        [rooms, plans, mine] = await Promise.all([fetchOpenRooms(), fetchPlanned(), user ? fetchMyPlans() : new Set<string>()]);
        render();
    } catch (error) {
        // PostgREST reports a missing table or column this way when the migrations have not been run.
        const missing = ['42P01', '42703', 'PGRST204', 'PGRST205'].includes((error as { code?: string })?.code ?? '');
        say(missing ? 'The board is not fully set up on this server yet. Whoever runs it needs to apply sql/005 and sql/006.' : 'Groups could not be loaded. Check your connection, then reload.');
    }
}

// Hosting now: remember what to list, then let the room page create the room and list it.
function hostNow(details: GroupDetails & { planId?: string }) {
    sessionStorage.setItem('flow_host', JSON.stringify(details));
    leaveWithLoader('/room.html', 'Opening your study group…');
}

// ── Controls ──
search.addEventListener('input', render);
const chips = document.querySelectorAll<HTMLButtonElement>('[data-subject]');
chips.forEach(chip => chip.addEventListener('click', () => {
    subject = chip.dataset.subject!;
    chips.forEach(other => other.setAttribute('aria-pressed', String(other === chip)));
    render();
}));
byId('find-seat').addEventListener('click', () => {
    if (!user) { window.location.href = '/login.html'; return; }
    // The emptiest matching room that isn't mine: the most room to settle in.
    const best = rooms.filter(room => matches(room) && freeSeats(room) > 0 && room.host_id !== user.id).sort((a, b) => freeSeats(b) - freeSeats(a))[0];
    if (best) return sit(best);
    say('No open group has a free seat for that right now. Host one below and others can find you.');
    byId<HTMLInputElement>('host-topic').focus();
});

const form = byId<HTMLFormElement>('host-form');
const startInput = byId<HTMLInputElement>('host-start');
const later = () => (form.elements.namedItem('when') as RadioNodeList).value === 'later';
form.addEventListener('change', () => {
    startInput.classList.toggle('hidden', !later());
    byId('host-submit').textContent = later() ? 'Put it on the board' : 'Open a room';
    byId('host-note').textContent = later() ? 'It appears under “Coming up”. Come back at start time and press Start now to open the room.' : 'You’ll land in a new room that’s already listed here. It leaves the board when you leave the room.';
    if (later() && !startInput.value) {
        // Default to a full hour at least half an hour away, in local time, as datetime-local expects.
        const next = new Date(Date.now() + 90 * 60000);
        next.setMinutes(0, 0, 0);
        startInput.value = new Date(next.getTime() - next.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
});
form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!user || busy) return;
    const value = (id: string) => byId<HTMLInputElement | HTMLSelectElement>(id).value;
    const topic = value('host-topic').trim();
    if (topic.length < 3) { byId<HTMLInputElement>('host-topic').focus(); return; }
    const details = { topic, subject: value('host-subject'), camera: value('host-camera'), vibe: value('host-vibe'), seats: Number(value('host-seats')), host_name: '' };
    if (!later()) return hostNow(details);

    const start = new Date(startInput.value);
    if (!(start.getTime() > Date.now()) || start.getTime() > Date.now() + 14 * 86400000) { say('Pick a start time between now and two weeks from now.'); startInput.focus(); return; }
    busy = true;
    const name = (await getMyProfile(user.id))?.display_name || user.email.split('@')[0];
    const planned = await planGroup({ ...details, host_name: name.slice(0, 40), host_id: user.id, starts_at: start.toISOString() });
    busy = false;
    say(planned ? 'Your group is on the board under “Coming up”.' : 'That could not be planned. You can have three groups planned at a time.');
    if (planned) { byId<HTMLInputElement>('host-topic').value = ''; load(); }
});

if (!user) {
    form.classList.add('hidden');
    byId('host-signed-out').classList.remove('hidden');
}

load();
watchBoard(() => { if (!busy) load(); });
// Countdowns move even when nothing changes, and this also covers a dropped realtime connection.
setInterval(() => { if (!document.hidden && !busy) load(); }, 30000);
