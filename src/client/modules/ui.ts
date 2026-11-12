import { completeTask } from '../motion';
import type { TimerState, Participants, Task, TaskStats, PresenceState } from '../types';
import { byId } from '../dom';
import { escapeHTML } from './utils';

export const ROUNDS = 4;

const els = {
    count: byId<HTMLElement>('count'),
    timeDisplay: byId<HTMLElement>('time-display'),
    timerToggleBtn: byId<HTMLButtonElement>('timer-toggle-btn'),
    timerModes: document.querySelectorAll<HTMLButtonElement>('.mode-btn'),
    myStatusText: byId<HTMLElement>('my-status-text'),
    myUsername: byId<HTMLElement>('my-username'),
    myAvatar: byId<HTMLElement>('my-avatar'),
    myFocusTime: byId<HTMLElement>('my-focus-time')
};
export const UI = els;

export const initial = (name: string) => (name.trim().charAt(0) || '?').toUpperCase();
const statusText = (status: string) => status.replace(/^[🟢🟡]\s*/u, '');

export const updateRoomInfo = (roomCode: string, count: number) => {
    const code = byId<HTMLElement>('header-room-code');
    code.textContent = roomCode;
    code.setAttribute('aria-label', `Copy room code ${roomCode}`);
    els.count.textContent = String(count);
};

export const updateTimerUI = (state: TimerState) => {
    const m = Math.floor(state.timeLeft / 60).toString().padStart(2, '0');
    const s = (state.timeLeft % 60).toString().padStart(2, '0');
    const focus = state.mode === 'focus';
    els.timeDisplay.textContent = `${m}:${s}`;
    els.timerToggleBtn.setAttribute('aria-label', state.isRunning ? 'Pause timer' : 'Start timer');
    els.timerToggleBtn.setAttribute('aria-pressed', String(state.isRunning));
    els.timerToggleBtn.classList.toggle('active', state.isRunning);
    byId<HTMLElement>('timer-state-label').textContent = state.isRunning ? (focus ? 'Focus in progress' : 'Break in progress') : (focus ? 'Ready to focus' : 'Ready for a break');
    document.title = state.isRunning ? `${m}:${s} | Flow` : 'Study room | Flow';
    // The sun is the progress bar: it sinks through a focus block and rises through a break.
    const elapsed = state.duration ? 1 - state.timeLeft / state.duration : 0;
    document.body.style.setProperty('--sun-y', String(focus ? elapsed : 1 - elapsed));

    // CSS reads these to pulse the clock and turn the sun into a breathing pacer on breaks.
    document.body.dataset.mode = focus ? 'focus' : 'break';
    document.body.dataset.timer = state.isRunning ? document.body.dataset.mode : 'idle';

    // Four focus blocks make a set; the fourth earns the long break.
    const inSet = state.sessionCount % ROUNDS;
    const done = state.mode === 'longBreak' && state.sessionCount > 0 && inSet === 0 ? ROUNDS : inSet;
    const rounds = byId<HTMLElement>('rounds');
    rounds.querySelectorAll('i').forEach((dot, index) => dot.classList.toggle('done', index < done));
    rounds.setAttribute('aria-label', focus ? `Round ${done + 1} of ${ROUNDS}` : `${done} of ${ROUNDS} rounds done`);

    els.timerModes.forEach(btn => {
        const active = btn.dataset.mode === state.mode;
        btn.setAttribute('aria-pressed', String(active));
        btn.classList.toggle('active', active);
    });
};

const buildAssigneeOptions = (participants: Participants, selectedId: string) => {
    const options = [`<option value=""${!selectedId ? ' selected' : ''}>Unassigned</option>`];
    Object.entries(participants || {}).forEach(([id, p]) => {
        options.push(`<option value="${escapeHTML(id)}"${id === selectedId ? ' selected' : ''}>${escapeHTML(p.username || 'Partner')}</option>`);
    });
    return options.join('');
};

const CHECK_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
const TASK_ROW = `
    <button type="button" class="task-checkbox"></button>
    <div class="task-content"><div class="task-title"></div></div>
    <select class="task-assignee-select" title="Assign to"></select>
    <button class="icon-btn task-delete" aria-label="Delete Task"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>`;

// Reconciles task rows in place. addTask alone renders three times in a row
// (optimistic add, insert response, realtime echo); rebuilding the list each
// time flashed it blank and replayed every row's entrance animation.
export const renderTaskList = (container: HTMLElement, tasks: Task[], onToggle: (id: string) => void, onDelete: (id: string) => void, participants: Participants, onAssign: (id: string, userId: string | null) => void) => {
    const emptyMsg = container.querySelector('.task-empty-msg');
    if (tasks.length === 0) {
        if (!emptyMsg) container.innerHTML = '<li class="task-empty-msg"><strong>Set a goal for this session.</strong>Add a task above to track progress together.</li>';
        return;
    }
    emptyMsg?.remove();

    const existing = new Map<string, HTMLLIElement>();
    container.querySelectorAll<HTMLLIElement>(':scope > .task-item').forEach(li => existing.set(li.dataset.taskId!, li));

    let prevEl: HTMLLIElement | null = null;
    tasks.forEach(task => {
        const key = String(task.id);
        let li = existing.get(key);
        if (li) {
            existing.delete(key);
        } else {
            li = document.createElement('li');
            li.className = 'task-item scale-in';
            li.dataset.taskId = key;
            li.innerHTML = TASK_ROW;
            li.querySelector<HTMLButtonElement>('.task-checkbox')!.addEventListener('click', () => onToggle(task.id));
            li.querySelector<HTMLButtonElement>('.task-delete')!.addEventListener('click', () => onDelete(task.id));
        }

        const justCompleted = !li.classList.contains('completed') && !!task.completed && li.isConnected;
        li.classList.toggle('completed', !!task.completed);
        li.classList.toggle('saving', !!task.pending);
        li.setAttribute('aria-busy', String(!!task.pending));
        li.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select').forEach(control => { control.disabled = !!task.pending; });

        const checkbox = li.querySelector<HTMLButtonElement>('.task-checkbox')!;
        checkbox.setAttribute('aria-label', `${task.completed ? 'Mark incomplete' : 'Complete task'}: ${task.title}`);
        checkbox.setAttribute('aria-pressed', String(!!task.completed));
        if (justCompleted) completeTask(checkbox);
        checkbox.innerHTML = task.completed ? CHECK_ICON : '';

        const titleEl = li.querySelector<HTMLElement>('.task-title')!;
        if (titleEl.textContent !== task.title) titleEl.textContent = task.title;

        const select = li.querySelector<HTMLSelectElement>('.task-assignee-select')!;
        select.innerHTML = buildAssigneeOptions(participants, task.assigned_to || '');
        // Assigning .onchange (not addEventListener) keeps one listener across re-renders.
        select.onchange = () => onAssign(task.id, select.value || null);

        const wantsPosition: ChildNode | null = prevEl ? prevEl.nextSibling : container.firstChild;
        if (li !== wantsPosition) container.insertBefore(li, wantsPosition);
        prevEl = li;
    });
    existing.forEach(li => li.remove());
};

export const updateTaskStatsUI = (stats: TaskStats) => {
    const percentage = stats.total === 0 ? 0 : Math.round((stats.completed / stats.total) * 100);
    byId<HTMLElement>('room-task-progress-text').textContent = `${percentage}%`;
    byId<HTMLElement>('room-task-progress-fill').style.width = `${percentage}%`;
};

export const updateMyPresenceUI = (state: PresenceState, username: string) => {
    els.myUsername.textContent = username;
    els.myAvatar.textContent = initial(username);
    els.myStatusText.textContent = statusText(state.status);
    els.myStatusText.previousElementSibling!.className = `dot ${state.status.includes('Break') ? 'yellow' : 'green'}`;
    if (state.focusTime !== undefined) els.myFocusTime.textContent = `Today: ${state.focusTime}m focused`;
};
