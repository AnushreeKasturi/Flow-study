import { completeTask } from '../motion';
import type { TimerState, Participants, Task, TaskStats, PresenceState, Participant } from '../types';
import { byId } from '../dom';
import { escapeHTML } from './utils';

// DOM Elements
const els = {
    roomName: byId<HTMLElement>('room-name'),
    count: byId<HTMLElement>('count'),
    timeDisplay: byId<HTMLElement>('time-display'),
    timerToggleBtn: byId<HTMLButtonElement>('timer-toggle-btn'),
    timerModes: document.querySelectorAll<HTMLButtonElement>('.mode-btn'),

    partnerPresenceContainer: byId<HTMLElement>('partner-presence-container'),

    myStatusText: byId<HTMLElement>('my-status-text'),
    myUsername: byId<HTMLElement>('my-username'),
    myAvatar: byId<HTMLElement>('my-avatar'),
    myFocusTime: byId<HTMLElement>('my-focus-time')
};

export const updateRoomInfo = (roomId: string, count: number) => {
    // Keep the id="header-room-code" span alive across rewrites — other
    // code (Copy Link) looks it up by id, and a plain replacement span
    // silently breaks that after the first presence sync.
    els.roomName.innerHTML = 'Room: <span class="highlight" id="header-room-code"></span>';
    byId<HTMLElement>('header-room-code').textContent = roomId;
    els.count.innerText = String(count);
    byId<HTMLElement>('room-guidance').classList.toggle('hidden', count > 1);
};

export const updateTimerUI = (state: TimerState) => {
    els.timerToggleBtn.setAttribute('aria-label', state.isRunning ? 'Pause timer' : 'Start timer');
    els.timerToggleBtn.setAttribute('aria-pressed', String(state.isRunning));
    // Update text
    const m = Math.floor(state.timeLeft / 60).toString().padStart(2, '0');
    const s = (state.timeLeft % 60).toString().padStart(2, '0');
    els.timeDisplay.innerText = `${m}:${s}`;

    byId<HTMLElement>('timer-state-label').textContent = state.isRunning ? (state.mode === 'focus' ? 'Focus in progress' : 'Break in progress') : (state.mode === 'focus' ? 'Ready to focus' : 'Ready for a break');
    document.title = state.isRunning ? m + ':' + s + ' | Flow' : 'Flow | Study room';

    // Update Button
    els.timerToggleBtn.innerHTML = state.isRunning ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>' : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
    if(state.isRunning) {
        els.timerToggleBtn.classList.add('active');
    } else {
        els.timerToggleBtn.classList.remove('active');
    }

    // Update Modes
    els.timerModes.forEach(btn => {
        btn.setAttribute('aria-pressed', String(btn.dataset.mode === state.mode));
        if (btn.dataset.mode === state.mode) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
};

const buildAssigneeOptions = (participants: Participants, selectedId: string) => {
    const options = [`<option value=""${!selectedId ? ' selected' : ''}>Unassigned</option>`];
    Object.entries(participants || {}).forEach(([id, p]) => {
        options.push(`<option value="${escapeHTML(id)}"${id === selectedId ? ' selected' : ''}>${escapeHTML(p.username || 'Partner')}</option>`);
    });
    return options.join('');
};

// Reconciles the task <li> elements in place instead of clearing and
// rebuilding the whole list on every render. addTask alone triggers this
// three times in a row (optimistic add, insert response, realtime echo);
// wiping container.innerHTML each time flashed the list blank and replayed
// every row's entrance animation, not just the new row's.
export const renderTaskList = (container: HTMLElement, tasks: Task[], isReadOnly: boolean, onToggle: (id: string) => void, onDelete: (id: string) => void, participants: Participants, onAssign: (id: string, userId: string | null) => void) => {
    const emptyMsg = container.querySelector('.task-empty-msg');

    if (tasks.length === 0 && !isReadOnly) {
        if (!emptyMsg) {
            container.innerHTML = '<li class="task-empty-msg"><strong>Set a goal for this session.</strong>Add a task above to track progress together.</li>';
        }
        return;
    }
    if (emptyMsg) emptyMsg.remove();

    const existing = new Map<string, HTMLLIElement>();
    container.querySelectorAll<HTMLLIElement>(':scope > .task-item').forEach((li) => existing.set(li.dataset.taskId!, li));

    let prevEl: HTMLLIElement | null = null;
    tasks.forEach((task) => {
        const key = String(task.id);
        let li = existing.get(key);

        if (li) {
            existing.delete(key);
        } else {
            li = document.createElement('li');
            li.className = 'task-item scale-in';
            li.dataset.taskId = key;

            li.innerHTML = `
                <button type="button" class="task-checkbox" ${isReadOnly ? 'disabled' : ''}></button>
                <div class="task-content" style="flex:1; font-weight:600;">
                    <div class="task-title"></div>
                </div>
                ${!isReadOnly ? '<select class="task-assignee-select" title="Assign to"></select>' : ''}
                ${!isReadOnly ? `<button class="icon-btn" style="width:28px; height:28px; color:var(--danger);" aria-label="Delete Task"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>` : ''}
            `;

            if (!isReadOnly) {
                li.querySelector<HTMLButtonElement>('.task-checkbox')!.addEventListener('click', () => onToggle(task.id));
                li.querySelector<HTMLButtonElement>('.icon-btn')!.addEventListener('click', () => onDelete(task.id));
            }
        }

        const justCompleted = !li.classList.contains('completed') && !!task.completed && li.isConnected;
        li.classList.toggle('completed', !!task.completed);
        li.classList.toggle('saving', !!task.pending);
        li.setAttribute('aria-busy', String(!!task.pending));
        li.querySelectorAll<HTMLButtonElement | HTMLSelectElement>('button, select').forEach(control => { control.disabled = isReadOnly || !!task.pending; });

        const checkbox = li.querySelector<HTMLButtonElement>('.task-checkbox')!;
        checkbox.setAttribute('aria-label', `${task.completed ? 'Mark incomplete' : 'Complete task'}: ${task.title}`);
        checkbox.setAttribute('aria-pressed', String(!!task.completed));
        if (justCompleted) completeTask(checkbox);
        checkbox.innerHTML = task.completed ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg>' : '';

        const titleEl = li.querySelector<HTMLElement>('.task-title')!;
        const safeTitle = escapeHTML(task.title);
        if (titleEl.innerHTML !== safeTitle) titleEl.innerHTML = safeTitle;

        if (!isReadOnly) {
            const select = li.querySelector<HTMLSelectElement>('.task-assignee-select')!;
            select.innerHTML = buildAssigneeOptions(participants, task.assigned_to || '');
            // Reassigning .onchange (rather than addEventListener) avoids
            // piling up duplicate listeners across re-renders of this row.
            select.onchange = () => onAssign(task.id, select.value || null);
        }

        const wantsPosition = prevEl ? prevEl.nextSibling : container.firstChild;
        if (li !== wantsPosition) {
            container.insertBefore(li, wantsPosition);
        }
        prevEl = li;
    });

    existing.forEach((li) => li.remove());
};

export const updateTaskStatsUI = (stats: TaskStats, progressTextEl: HTMLElement, progressFillEl: HTMLElement) => {
    const percentage = stats.total === 0 ? 0 : Math.round((stats.completed / stats.total) * 100);
    if(progressTextEl) progressTextEl.innerText = `${percentage}%`;
    if(progressFillEl) progressFillEl.style.width = `${percentage}%`;
    return percentage;
};

export const updateMyPresenceUI = (state: PresenceState, _stats: TaskStats, username: string) => {
    els.myUsername.innerText = username;
    els.myAvatar.innerText = username.charAt(0).toUpperCase();

    els.myStatusText.innerText = state.status.replace(/^[🟢🟡]\s*/u, '');

    const dot = els.myStatusText.previousElementSibling;
    dot!.className = `dot ${state.status.includes('Break') ? 'yellow' : 'green'}`;

    if (els.myFocusTime && state.focusTime !== undefined) {
        els.myFocusTime.innerText = `Today: ${state.focusTime}m focused`;
    }
};

export const renderPartnerPresenceCard = (userId: string, userData: Participant) => {
    let card = document.getElementById(`presence-${userId}`);

    if (!card) {
        card = document.createElement('div');
        card.id = `presence-${userId}`;
        card.className = 'brutal-card profile-card fade-in';
        els.partnerPresenceContainer.appendChild(card);
    }

    const safeName = userData.username || 'Partner';
    const partnerStatus = userData.presence?.status || userData.status || 'Online';
    const isBreak = String(partnerStatus).includes('Break');

    card.innerHTML = `
        <div class="profile-header">
            <div class="avatar">${escapeHTML(String(safeName).charAt(0).toUpperCase())}</div>
            <div class="profile-info">
                <h3>${escapeHTML(safeName)}</h3>
                <div class="status-indicator">
                    <span class="dot ${isBreak ? 'yellow' : 'green'}"></span>
                    <span>${escapeHTML(String(partnerStatus).replace(/^[🟢🟡]\s*/u, ''))}</span>
                </div>
            </div>
        </div>
    `;
};

export const removePartnerPresenceCard = (userId: string) => {
    const card = document.getElementById(`presence-${userId}`);
    if (card) {
        card.remove();
    }
};

// Utils


// Exports for direct access
export const UI = els;
