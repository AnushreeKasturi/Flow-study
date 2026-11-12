// Personal reminders, set with /remind or by asking /ai. They belong to this
// browser: nothing is shared with the room or stored on a server. A reminder
// can only fire while Flow is open; any that fell due while it was closed are
// shown as missed when it next opens (within twelve hours).
import { byId } from '../dom';
import { describeWhen, type ReminderRequest, type Trigger } from './reminder-parse';
import { pushNote, systemNotify, refreshEmpty } from './notifications';
import { chime } from './chime';
import { notify } from './feedback';

export interface Reminder { id: string; text: string; at?: number; trigger?: Trigger; }
const KEY = 'flow_reminders';
const MAX = 20;
const MISSED_WITHIN = 12 * 60 * 60 * 1000;
let reminders: Reminder[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();

const valid = (r: Partial<Reminder>): r is Reminder =>
    typeof r?.id === 'string' && typeof r.text === 'string' && r.text.length > 0 && r.text.length <= 120 &&
    ((typeof r.at === 'number' && Number.isFinite(r.at)) || r.trigger === 'break' || r.trigger === 'focus');

function save() {
    try { localStorage.setItem(KEY, JSON.stringify(reminders)); } catch { /* still works for this visit */ }
}

function schedule(reminder: Reminder) {
    if (reminder.at === undefined) return;
    clearTimeout(timers.get(reminder.id));
    timers.set(reminder.id, setTimeout(() => fire(reminder), Math.max(0, reminder.at - Date.now())));
}

function fire(reminder: Reminder, missed = false) {
    if (!reminders.some(r => r.id === reminder.id)) return;
    remove(reminder.id);
    const text = missed ? `Missed while you were away: ${reminder.text}` : `Reminder: ${reminder.text}`;
    chime('reminder');
    notify(text);
    pushNote(text, { label: 'Snooze 5 min', run: () => { addReminder({ text: reminder.text, at: Date.now() + 5 * 60000 }); notify('Snoozed for 5 minutes.'); } });
    systemNotify('Flow reminder', reminder.text);
}

function remove(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    reminders = reminders.filter(r => r.id !== id);
    save();
    render();
}

// Adds a reminder. Returns it, or null when twenty are already waiting.
export function addReminder(request: ReminderRequest): Reminder | null {
    if (reminders.length >= MAX) return null;
    const reminder: Reminder = { id: crypto.randomUUID(), text: request.text.slice(0, 120), ...(request.trigger ? { trigger: request.trigger } : { at: request.at }) };
    if (!valid(reminder)) return null;
    reminders.push(reminder);
    save();
    schedule(reminder);
    render();
    return reminder;
}

export const cancelReminder = (id: string) => remove(id);

// The room's timer reached a break or a focus block.
export function timerReached(trigger: Trigger) {
    reminders.filter(r => r.trigger === trigger).forEach(r => fire(r));
}

function render() {
    const list = byId<HTMLElement>('reminder-list');
    const sorted = [...reminders].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
    list.replaceChildren(...sorted.map(reminder => {
        const item = document.createElement('li');
        const copy = document.createElement('div');
        copy.append(Object.assign(document.createElement('span'), { textContent: reminder.text }), Object.assign(document.createElement('small'), { textContent: describeWhen(reminder) }));
        const cancel = Object.assign(document.createElement('button'), { type: 'button', className: 'reminder-cancel', textContent: '×' });
        cancel.setAttribute('aria-label', `Cancel reminder: ${reminder.text}`);
        cancel.addEventListener('click', event => { event.stopPropagation(); cancelReminder(reminder.id); });
        item.append(copy, cancel);
        return item;
    }));
    byId<HTMLElement>('reminders').classList.toggle('hidden', reminders.length === 0);
    refreshEmpty();
}

export function initReminders() {
    try {
        const stored = JSON.parse(localStorage.getItem(KEY) || '[]');
        reminders = Array.isArray(stored) ? stored.filter(valid).slice(0, MAX) : [];
    } catch { reminders = []; }
    const now = Date.now();
    // Due while Flow was closed: say so if recent, forget if long past.
    for (const reminder of [...reminders]) {
        if (reminder.at !== undefined && reminder.at <= now) {
            if (now - reminder.at < MISSED_WITHIN) fire(reminder, true); else remove(reminder.id);
        }
    }
    reminders.forEach(schedule);
    save();
    render();
}
