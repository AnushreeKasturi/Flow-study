import type { PresenceState } from '../types';
import { updatePresence as socketUpdatePresence, getMyUserId } from './socket';
import { getSupabase } from './supabase';
import { startFocus, pauseFocus, getLiveFocus, confirmFocus } from './focus-progress';

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

export const startFocusTracking = () => {
    if (focusInterval) return;
    startFocus();
    updatePresence({ status: 'Deep Focus' });
    focusInterval = setInterval(renderPresence, 1000);
};

export const stopFocusTracking = (status = 'On Break') => {
    pauseFocus();
    if (focusInterval) clearInterval(focusInterval);
    focusInterval = null;
    updatePresence({ status });
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
