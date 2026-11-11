// Study-groups board page.
import { byId } from './dom';
import type { OpenRoom } from './types';
import { fetchOpenRooms, takeSeat } from './modules/board';
import { getStoredUser } from './modules/utils';

const list = byId<HTMLElement>('board-list');
const message = byId<HTMLElement>('board-message');
const user = getStoredUser();
let joining = false;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: Node[]) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
};

function card(room: OpenRoom) {
    const free = Math.max(0, room.seats - room.seats_taken);
    const mine = room.host_id === user?.id;
    const seats = el('div', { className: 'seats' });
    seats.setAttribute('role', 'img');
    seats.setAttribute('aria-label', `${Math.min(room.seats_taken, room.seats)} of ${room.seats} seats taken`);
    for (let i = 0; i < room.seats; i++) seats.append(el('i', { className: i < room.seats_taken ? 'taken' : '' }));
    const button = el('button', { className: 'btn btn-primary', type: 'button', textContent: mine ? 'Return to your room' : free ? 'Take a seat' : 'Full', disabled: !mine && !free });
    button.addEventListener('click', async () => {
        if (joining) return;
        joining = button.disabled = true;
        const result = await takeSeat(room.id).catch((): { reason: string } => ({ reason: 'Could not join this group. Check your connection and try again.' }));
        if ('code' in result) { window.location.href = '/room.html?room=' + encodeURIComponent(result.code) + '&join=1'; return; }
        message.textContent = result.reason;
        joining = false;
        load();
    });
    return el('li', { className: 'group' },
        el('div', {},
            el('h3', { textContent: room.topic }),
            el('p', { textContent: `Hosted by ${room.host_name}` + (mine ? ' (you)' : '') })),
        el('div', { className: 'group-seats' }, seats, el('span', { textContent: free ? `${free} seat${free === 1 ? '' : 's'} free` : 'No seats free' })),
        button);
}

async function load() {
    try {
        const rooms = await fetchOpenRooms();
        list.replaceChildren(...rooms.map(card));
        if (!rooms.length) list.append(el('li', { className: 'group-empty' },
            el('strong', { textContent: 'No groups are open right now.' }),
            el('span', { textContent: 'Be the first: host one, and it shows up here for everyone signed in.' })));
        if (!joining) message.textContent = '';
    } catch (error) {
        // PostgREST reports a missing table this way when the migration has not been run.
        const missing = ['42P01', 'PGRST205'].includes((error as { code?: string })?.code ?? '');
        list.replaceChildren();
        message.textContent = missing ? 'The board is not set up on this server yet. Whoever runs it needs to apply sql/005_open_rooms_and_limits.sql.' : 'Groups could not be loaded. Check your connection, then refresh.';
    }
}

byId<HTMLButtonElement>('board-refresh').addEventListener('click', load);
// Hosting: remember what to list, then let the room page create the room and list it.
byId<HTMLFormElement>('host-form').addEventListener('submit', event => {
    event.preventDefault();
    const topic = byId<HTMLInputElement>('host-topic').value.trim();
    if (topic.length < 3) { byId<HTMLInputElement>('host-topic').focus(); return; }
    sessionStorage.setItem('flow_host', JSON.stringify({ topic, seats: Number(byId<HTMLSelectElement>('host-seats').value) }));
    window.location.href = '/room.html';
});

load();
// Seats change by the minute; keep the board current while it is on screen.
setInterval(() => { if (!document.hidden && !joining) load(); }, 20000);
