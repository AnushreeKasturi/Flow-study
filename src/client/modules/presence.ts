import type { PresenceState } from '../types';
import { updatePresence as socketUpdatePresence, getMyUserId } from './socket';
import { getSupabase } from './supabase';
import { startFocus, pauseFocus, getLiveFocus, confirmFocus, setFocusAway } from './focus-progress';

let currentState: PresenceState = { status: 'Online', nowPlaying: null, currentTask: 'Planning…', focusTime: 0 };
let roomId: string | null = null;
let updateUI: ((state: PresenceState) => void) | null = null;
let focusInterval: ReturnType<typeof setInterval> | null = null;
let savedSeconds = 0;
let savedIds: string[] = [];

export const fetchDailyFocusTime = async () => {
    const userId = getMyUserId();
    if (!userId) return;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    try {
        const { data, error } = await getSupabase().from('sessions').select('id, duration_seconds').eq('user_id', userId).gte('completed_at', today.toISOString());
        if (!error && data) {
            savedSeconds = data.reduce((sum, row) => sum + row.duration_seconds, 0);
            savedIds = data.map(row => row.id);
            savedIds.forEach(confirmFocus);
            renderPresence();
            return true;
        }
    } catch { /* Retain the last known saved total when offline. */ }
    return false;
};

export const initPresence = (id: string, callback: (state: PresenceState) => void) => {
    roomId = id;
    updateUI = callback;
    broadcastPresence();
    renderPresence();
    fetchDailyFocusTime();
    document.addEventListener('session-completed', fetchDailyFocusTime);
};

export const updatePresence = (updates: Partial<PresenceState>) => {
    currentState = { ...currentState, ...updates };
    broadcastPresence();
    renderPresence();
};

// Stepped away: shown on your tile instead of what the room is doing.
export const AWAY_STATUSES = ['Stepped away', 'Back for the next block'];
let baseStatus = 'Online';
let away: string | null = null;
const showStatus = () => { if (currentState.status !== (away ?? baseStatus)) updatePresence({ status: away ?? baseStatus }); };

export const startFocusTracking = () => {
    if (focusInterval) return;
    startFocus();
    baseStatus = 'Deep Focus';
    showStatus();
    focusInterval = setInterval(renderPresence, 1000);
};

export const stopFocusTracking = (status = 'On Break') => {
    pauseFocus();
    if (focusInterval) clearInterval(focusInterval);
    focusInterval = null;
    baseStatus = status;
    showStatus();
};

// null when you're back. Your focus time pauses while you're away; the room's clock doesn't.
export const setAway = (status: string | null) => {
    away = status;
    setFocusAway(!!status);
    if (!status && focusInterval) startFocus();
    showStatus();
};

function broadcastPresence() {
    socketUpdatePresence(roomId, currentState.status, currentState.nowPlaying);
}

function renderPresence() {
    currentState.focusTime = Math.floor((savedSeconds + getLiveFocus({ persistedIds: savedIds }).todaySeconds) / 60);
    updateUI?.(currentState);
    document.dispatchEvent(new Event('focus-progress'));
}

export const formatFocusTime = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return hours ? hours + 'h ' + rest + 'm' : rest + 'm';
};
