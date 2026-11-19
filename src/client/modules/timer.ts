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
    durations: { focus: 25 * 60, shortBreak: 5 * 60, longBreak: 15 * 60 },
    // In a group nobody owns the click that starts the break, so by default nobody has to.
    autoAdvance: true,
    version: 0,
    by: ''
};

// Only whoever hosts right now (the host, or the stand-in while they're away) changes the
// timer; the database refuses anyone else (sql/018). Everyone else follows it.
let runs = false;
export const setRunsTimer = (yes: boolean) => { runs = yes; };
export const runsTimer = () => runs;

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

export const syncState = (newState: Partial<TimerState> & { from?: unknown }) => {
    if (!newState || typeof newState !== 'object') return;
    if (newState.mode !== undefined && !Object.hasOwn(MODES, newState.mode)) return;
    if (newState.timeLeft !== undefined && (!Number.isInteger(newState.timeLeft) || newState.timeLeft < 0 || newState.timeLeft > 7200)) return;
    if (newState.duration !== undefined && (!Number.isInteger(newState.duration) || newState.duration < 60 || newState.duration > 7200)) return;
    if (newState.durations && !validDurations(newState.durations)) return;
    if (newState.isRunning !== undefined && typeof newState.isRunning !== 'boolean') return;
    if (newState.sessionCount !== undefined && (!Number.isInteger(newState.sessionCount) || newState.sessionCount < 0 || newState.sessionCount > 10000)) return;
    if (newState.autoAdvance !== undefined && typeof newState.autoAdvance !== 'boolean') return;
    if (newState.version !== undefined && (!Number.isInteger(newState.version) || newState.version < 0 || newState.version > Number.MAX_SAFE_INTEGER)) return;
    // A page already in step only moves forward a little at a time, so nobody can send a huge
    // version that later honest changes could never beat. A page that has just arrived (version 0)
    // takes the room's version as it is.
    if (newState.version !== undefined && (state.version ?? 0) > 0 && newState.version > (state.version ?? 0) + 1000) return;
    // Who made it is who sent it: the database stamps `from` with the signed-in account
    // (room_send); a `by` written into the message is never trusted.
    newState.by = typeof newState.from === 'string' ? newState.from.slice(0, 64) : '';
    // Messages can arrive out of order, and everyone in a room sends the state they have to
    // someone who arrives. Only a newer version is taken; at the same version the same author's
    // clock may correct a drift. (A state with no version comes from an older page: as before.)
    if (newState.version !== undefined) {
        const full = newState.mode !== undefined && newState.isRunning !== undefined;
        const newer = newState.version > (state.version ?? 0) || (newState.version === state.version && (newState.by ?? '') > (state.by ?? ''));
        if (!newer || !full) {
            const same = newState.version === state.version && newState.by === state.by;
            if (same && state.isRunning && newState.timeLeft !== undefined && Math.abs(newState.timeLeft - state.timeLeft) >= 2) {
                state.timeLeft = newState.timeLeft;
                deadline = Date.now() + state.timeLeft * 1000;
                renderTimer();
            }
            return;
        }
        state.version = newState.version;
        state.by = newState.by ?? '';
    }
    if (newState.autoAdvance !== undefined) state.autoAdvance = newState.autoAdvance;
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

// Back in a room after a reload or a sleeping laptop: put its saved timer (sql/017) back,
// less the time that has passed since it was saved. Someone already in the room will
// send the live state straight after, which wins. A block that ran out while everyone
// was away is finished on the next tick, like any other.
// ponytail: catches up one block at most, and trusts this device's clock against the server's.
export function restoreTimer(saved: unknown) {
    if (!saved || typeof saved !== 'object') return;
    const timer = saved as Partial<TimerState> & { at?: string };
    const savedAt = typeof timer.at === 'string' ? Date.parse(timer.at) : NaN;
    if (!Number.isFinite(savedAt) || !Number.isInteger(timer.timeLeft)) return;
    const elapsed = timer.isRunning ? Math.max(0, Math.round((Date.now() - savedAt) / 1000)) : 0;
    const { mode, isRunning, duration, sessionCount, durations, autoAdvance: advance } = timer;
    syncState({ mode, isRunning, duration, sessionCount, durations, autoAdvance: advance, timeLeft: Math.max(0, timer.timeLeft! - elapsed) });
}

const broadcastState = () => {
    socketUpdateTimer(roomId, 'sync', state);
};
// A change made here: the next version, by us.
const changed = () => {
    state.version = (state.version ?? 0) + 1;
    state.by = getMyUserId() || '';
};

// For the study-groups board: which mode the room is in and, if the clock is running, when it ends.
export const timerSnapshot = () => ({ timer_mode: state.mode as string, timer_ends_at: state.isRunning ? new Date(deadline).toISOString() : null });

// Brings someone who just arrived in step. Only the person running the timer answers, so a
// stale copy from anyone else can't reach them.
export const broadcastCurrentState = () => {
    if (runs) broadcastState();
};

export const toggleTimer = (broadcast = true) => {
    if (broadcast && !runs) return;
    if (broadcast) changed();
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
    if (broadcast && !runs) return;
    if (broadcast) changed();
    state.isRunning = false;
    state.duration = MODES[state.mode]();
    state.timeLeft = state.duration;
    stopLocalTick();
    renderTimer();
    if (broadcast) broadcastState();
};

export const setMode = (mode: TimerMode, broadcast = true) => {
    if (broadcast && !runs) return;
    if (Object.hasOwn(MODES, mode)) {
        if (broadcast) changed();
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

export const autoAdvance = () => state.autoAdvance !== false;
export const timerDurations = () => state.durations;
export const setTimerSettings = (durations: Durations, broadcast = true, advance = autoAdvance()) => {
    if (!validDurations(durations) || (broadcast && !runs)) return;
    if (broadcast) changed();
    state.durations = durations;
    state.autoAdvance = advance;
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

            // Every 30 s whoever made the current state says where it is, so a drifted
            // clock (a sleeping laptop) catches up. One sender per room, not everyone.
            if (state.timeLeft % 30 === 0 && state.by && state.by === getMyUserId()) {
                socketUpdateTimer(roomId, 'sync', { timeLeft: state.timeLeft, version: state.version, by: state.by });
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
        if (autoAdvance()) msg += ' The break has started.';
        setMode(longBreak ? 'longBreak' : 'shortBreak', false);
        document.body.classList.remove('focus-active');
        const focusBtn = byId<HTMLElement>('focus-mode-toggle');
        focusBtn.classList.remove('active');
        focusBtn.setAttribute('aria-pressed', 'false');
    } else {
        title = 'Break complete';
        msg = autoAdvance() ? 'The next focus block has started.' : 'Ready for your next focus session?';
        setMode('focus', false);
    }
    // Every browser in the room reaches the end at the same moment. Nothing is sent in between,
    // so no "paused" can stop anyone.
    // Everyone's clock moves on by itself; whoever runs the timer makes it the room's next version.
    if (runs) changed();
    if (autoAdvance()) {
        state.isRunning = true;
        startLocalTick();
        renderTimer();
        if (runs) broadcastState();
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
