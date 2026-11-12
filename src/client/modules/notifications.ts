// The room's notification centre: a bell with an unread count and a short list
// of what happened while you were looking elsewhere. Nothing is stored; it
// lives for this visit.
import { byId } from '../dom';

interface Action { label: string; run: () => void; }
interface Note { text: string; at: number; action?: () => void; button?: Action; }
const notes: Note[] = [];
let unread = 0;
const MAX_NOTES = 40;
const panel = () => byId<HTMLDetailsElement>('notify');

function render() {
    const badge = byId<HTMLElement>('notify-count');
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.toggle('hidden', !unread);
    byId<HTMLElement>('notify-summary').setAttribute('aria-label', unread ? `Notifications, ${unread} new` : 'Notifications');
    const list = byId<HTMLElement>('notify-list');
    const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
    list.replaceChildren(...notes.map(note => {
        const item = document.createElement('li');
        const body = note.action ? Object.assign(document.createElement('button'), { type: 'button' }) : document.createElement('div');
        body.append(Object.assign(document.createElement('span'), { textContent: note.text }), Object.assign(document.createElement('time'), { textContent: time.format(note.at) }));
        if (note.action) body.addEventListener('click', () => { panel().open = false; note.action!(); });
        item.append(body);
        if (note.button) {
            const button = Object.assign(document.createElement('button'), { type: 'button', className: 'note-action', textContent: note.button.label });
            button.addEventListener('click', () => { const { run } = note.button!; note.button = undefined; render(); run(); });
            item.append(button);
        }
        return item;
    }));
    refreshEmpty();
}

// The "nothing yet" line shows only when there are no notes and no upcoming reminders.
export function refreshEmpty() {
    const reminders = document.getElementById('reminders');
    byId<HTMLElement>('notify-empty').classList.toggle('hidden', notes.length > 0 || !!(reminders && !reminders.classList.contains('hidden')));
}

// Adds a line to the centre. Text is always inserted as text, never as markup.
// `action` makes the whole line clickable; a `{ label, run }` adds a small button instead.
export function pushNote(text: string, action?: (() => void) | Action) {
    notes.unshift({ text: text.slice(0, 160), at: Date.now(), ...(typeof action === 'function' ? { action } : action ? { button: action } : {}) });
    notes.length = Math.min(notes.length, MAX_NOTES);
    if (!panel().open) unread++;
    render();
}

// A system notification, only when the user opted in (timer settings) and Flow is in a background tab.
export function systemNotify(title: string, body: string) {
    try {
        if (document.hidden && localStorage.getItem('flow_notify') === '1' && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(title, { body: body.slice(0, 140), icon: '/favicon.svg', tag: 'flow' });
        }
    } catch { /* A courtesy; the in-app centre still has it. */ }
}

export function initNotifications() {
    panel().addEventListener('toggle', () => { if (panel().open) { unread = 0; render(); } });
    byId<HTMLButtonElement>('notify-clear').addEventListener('click', () => { notes.length = 0; unread = 0; render(); });
    // Clicking anywhere else closes the list, like any menu.
    // (A click on something the panel has just re-drawn, such as Snooze, still counts as inside.)
    document.addEventListener('click', event => {
        const target = event.target as Node;
        if (panel().open && target.isConnected && !panel().contains(target)) panel().open = false;
    });
    render();
}
