import type { TimerState, TimerMode, Durations } from '../types';
import { byId } from '../dom';
import { updateTimer as socketUpdateTimer, getMyUserId } from './socket';
import { getSupabase } from './supabase';
import { finishFocus, confirmFocus, startFocus, resetBlock, blockSeconds } from './focus-progress';
import { fetchDailyFocusTime } from './presence';
import { openModal, closeModal, notify } from './feedback';
import { ROUNDS } from './ui';
import { chime } from './chime';
import { pushNote, systemNotify } from './notifications';

let state: TimerState = {
    mode: 'focus',
    timeLeft: 25 * 60,
    isRunning: false,
    duration: 25 * 60,
    sessionCount: 0,
    durations: { focus: 25 * 60, shortBreak: 5 * 60, longBreak: 15 * 60 }
};

let timerInterval: ReturnType<typeof setInterval> | null = null;
let deadline = 0;
let roomId: string | null = null;
let updateUI: ((state: TimerState) => void) | null = null;

const MODES = {
    focus: () => state.durations.focus,
    shortBreak: () => state.durations.shortBreak,
    longBreak: () => state.durations.longBreak
};

export const initTimer = (rId: string, uiCallback: (state: TimerState) => void) => {
    roomId = rId;
    updateUI = uiCallback;
    renderTimer();
};

export const syncState = (newState: Partial<TimerState>) => {
    if (!newState || typeof newState !== 'object') return;
    if (newState.mode !== undefined && !Object.hasOwn(MODES, newState.mode)) return;
    if (newState.timeLeft !== undefined && (!Number.isInteger(newState.timeLeft) || newState.timeLeft < 0 || newState.timeLeft > 7200)) return;
    if (newState.duration !== undefined && (!Number.isInteger(newState.duration) || newState.duration < 60 || newState.duration > 7200)) return;
    if (newState.durations && !validDurations(newState.durations)) return;
    if (newState.isRunning !== undefined && typeof newState.isRunning !== 'boolean') return;
    if (newState.sessionCount !== undefined && (!Number.isInteger(newState.sessionCount) || newState.sessionCount < 0 || newState.sessionCount > 10000)) return;
    // If we receive a sync with the full state, update our local state
    if (newState.durations) state.durations = newState.durations;
    if (newState.mode) state.mode = newState.mode;
    if (newState.duration) state.duration = newState.duration;
    if (newState.timeLeft !== undefined) state.timeLeft = newState.timeLeft;
    if (newState.isRunning !== undefined) state.isRunning = newState.isRunning;
    if (newState.sessionCount !== undefined) state.sessionCount = newState.sessionCount;

    deadline = Date.now() + state.timeLeft * 1000;
    if (state.isRunning && !timerInterval) {
        startLocalTick();
    } else if (!state.isRunning && timerInterval) {
        stopLocalTick();
    }

    renderTimer();
};

const broadcastState = () => {
    socketUpdateTimer(roomId, 'sync', state);
};

// For the study-groups board: which mode the room is in and, if the clock is running, when it ends.
export const timerSnapshot = () => ({ timer_mode: state.mode as string, timer_ends_at: state.isRunning ? new Date(deadline).toISOString() : null });

export const broadcastCurrentState = () => {
    broadcastState();
};

export const toggleTimer = (broadcast = true) => {
    state.isRunning = !state.isRunning;
    if (state.isRunning) {
        startLocalTick();
    } else {
        stopLocalTick();
    }
    renderTimer();
    if (broadcast) broadcastState();
};

export const resetTimer = (broadcast = true) => {
    state.isRunning = false;
    state.duration = MODES[state.mode]();
    state.timeLeft = state.duration;
    stopLocalTick();
    renderTimer();
    if (broadcast) broadcastState();
};

export const setMode = (mode: TimerMode, broadcast = true) => {
    if (Object.hasOwn(MODES, mode)) {
        state.mode = mode;
        state.duration = MODES[mode]();
        state.timeLeft = state.duration;
        state.isRunning = false;
        stopLocalTick();
        renderTimer();
        if (broadcast) broadcastState();
    }
};

const validDurations = (values: Durations) => (['focus', 'shortBreak', 'longBreak'] as const).every(key => Number.isInteger(values[key]) && values[key] >= 60 && values[key] <= (key === 'focus' ? 7200 : 3600));

export const setTimerSettings = (durations: Durations, broadcast = true) => {
    if (!validDurations(durations)) return;
    state.durations = durations;
    state.duration = MODES[state.mode]();
    if (!state.isRunning) {
        state.timeLeft = state.duration;
    }
    renderTimer();
    if (broadcast) broadcastState();
};

const startLocalTick = () => {
    if (timerInterval) clearInterval(timerInterval);

    deadline = Date.now() + state.timeLeft * 1000;
    timerInterval = setInterval(() => {
        if (state.timeLeft > 0) {
            state.timeLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
            renderTimer();

            // Sync with server every 10 seconds to ensure everyone is exact
            if (state.timeLeft % 10 === 0) {
                socketUpdateTimer(roomId, 'sync', { timeLeft: state.timeLeft });
            }
        } else {
            handleComplete();
        }
    }, 1000);
};

const stopLocalTick = () => {
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
};

// Saves the focus time not yet stored. A block that ran to the end is saved as
// 'focus' and counts as a completed session; time from a block that was paused,
// switched, or left (or a checkpoint of one still running) is saved as
// 'focus-partial', which counts toward minutes and streaks but not sessions.
// With `keepGoing`, the block carries on being timed afterwards.
export function saveFocus(kind: 'focus' | 'focus-partial' = 'focus-partial', keepGoing = false) {
    const userId = getMyUserId();
    const completed = finishFocus();
    if (keepGoing) startFocus();
    // Under fifteen seconds is not worth a row; it still counts while the page is open.
    if (!userId || !roomId || !completed || (kind === 'focus-partial' && completed.seconds < 15)) return Promise.resolve();
    return Promise.resolve(getSupabase().from('sessions').insert([{
        id: completed.id, user_id: userId, room_id: roomId, mode: kind,
        duration_seconds: completed.seconds, completed_at: completed.completedAt
    }])).then(async ({ error }) => {
        if (error) throw error;
        if (await fetchDailyFocusTime()) confirmFocus(completed.id);
        document.dispatchEvent(new Event('session-completed'));
    }).catch(() => notify('Your focus time could not be saved. It is still counted while this page stays open.', 'error'));
}

const handleComplete = () => {
    stopLocalTick();
    let title, msg;

    if (state.mode === 'focus') {
        // A completed session needs you there for at least half of it; a shorter stretch
        // (joined late, or stepped away) still counts toward your minutes.
        saveFocus(blockSeconds() * 2 >= state.duration ? 'focus' : 'focus-partial');

        // Every fourth focus block earns the long break.
        state.sessionCount++;
        const longBreak = state.sessionCount % ROUNDS === 0;
        title = 'Focus session complete';
        msg = longBreak ? `That’s ${ROUNDS} rounds. Take a long break; you’ve earned it.` : 'Nice work. Take a short break before the next one.';
        setMode(longBreak ? 'longBreak' : 'shortBreak');
        document.body.classList.remove('focus-active');
        const focusBtn = byId<HTMLElement>('focus-mode-toggle');
        focusBtn.classList.remove('active');
        focusBtn.setAttribute('aria-pressed', 'false');
    } else {
        title = 'Break complete';
        msg = 'Ready for your next focus session?';
        setMode('focus');
    }

    chime('done');
    systemNotify(title, msg);
    pushNote(`${title}. ${msg}`);
    byId<HTMLElement>('timer-alert-title').textContent = title;
    byId<HTMLElement>('timer-alert-msg').textContent = msg;
    openModal('timer-alert-modal');
    byId<HTMLButtonElement>('close-timer-alert-btn').onclick = closeModal;
};

let blockMode = '';
const renderTimer = () => {
    // A new block starts when the mode changes or the clock is back at the top.
    if (state.mode !== blockMode || (!state.isRunning && state.timeLeft === state.duration)) { blockMode = state.mode; resetBlock(); }
    if (updateUI) {
        updateUI(state);
    }
};
