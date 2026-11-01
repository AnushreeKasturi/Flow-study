import type { RealtimeChannel } from '@supabase/supabase-js';
import type { SocketHandlers, Participants, Participant, Signal, TimerState, AudioProvider } from '../types';
import { getSupabase } from './supabase';

let channel: RealtimeChannel | null = null;
let currentRoomId: string | null = null;
let myUserId = '';
let myUsername = '';
let currentHandlers: SocketHandlers | null = null;
let currentIsDummyMedia = false;
let currentHandRaised = false;
let connectionGeneration = 0;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_INTERVAL_MS = 20000;

// A flat 3s retry on every CLOSED hammers the server at a fixed rate when
// the connection is actually struggling (rate limiting, server-side churn)
// — observed live going from reconnecting every ~15s to every ~6s over two
// minutes, i.e. the retries themselves were making it worse. Back off
// exponentially instead, and reset once a connection actually holds.
let reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 30000;

export const initSocket = (roomId: string, username: string, isDummyMedia: boolean, handlers: SocketHandlers) => {
    currentRoomId = roomId;
    myUsername = username;
    currentHandlers = handlers;
    currentIsDummyMedia = isDummyMedia;
    currentHandRaised = false;
    reconnectAttempts = 0;
    const user = JSON.parse(localStorage.getItem('flow_user') || 'null');
    myUserId = user?.id || crypto.randomUUID();

    connectChannel();
};

export const disconnectSocket = async () => {
    connectionGeneration++;
    currentRoomId = null;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    const previous = channel;
    channel = null;
    if (previous) {
        try { await previous.untrack(); } catch { /* Teardown continues after a network failure. */ }
        try { await getSupabase().removeChannel(previous); } catch { /* Generation guard already prevents reconnection. */ }
    }
};

// A Supabase Realtime channel can only join() once per instance — calling
// subscribe() again on the same (now closed/errored) instance throws an
// uncaught "tried to join multiple times" error that silently breaks realtime
// message handling for the rest of the page (presence, signaling, broadcasts).
// So reconnecting means tearing down and building a brand-new channel, not
// re-subscribing the dead one.
const connectChannel = () => {
    const roomId = currentRoomId;
    const handlers = currentHandlers;
    if (!roomId || !handlers) return;

    // Guards against the subscribe() status callback firing more than once
    // for a single underlying failure (e.g. CHANNEL_ERROR immediately
    // followed by CLOSED) — without this, each firing independently
    // scheduled its own reconnect, and the resulting duplicate reconnect
    // chains compounded every generation until failures were happening
    // many times a second instead of once every few seconds.
    const myGeneration = ++connectionGeneration;
    handlers.onConnectionStatus?.('CONNECTING');

    if (heartbeatInterval) {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }

    if (channel) {
        getSupabase().removeChannel(channel);
        channel = null;
    }

    const activeChannel = channel = getSupabase().channel(`room:${roomId}`, {
        config: {
            presence: { key: myUserId },
            broadcast: { ack: true, self: false }
        }
    });

    const emitRoomState = () => {
        const state = activeChannel.presenceState<Participant>();
        const participants: Participants = {};
        for (const [key, presences] of Object.entries(state)) {
            participants[key] = presences[0];
        }
        handlers.onRoomState({ participants });
    };

    activeChannel.on('presence', { event: 'sync' }, emitRoomState);

    activeChannel.on('presence', { event: 'join' }, ({ key, newPresences }) => {
        if (key !== myUserId) {
            handlers.onUserJoined({ userId: key, ...newPresences[0] });
        }
    });

    activeChannel.on('presence', { event: 'leave' }, ({ key }) => {
        if (key !== myUserId) {
            handlers.onUserLeft(key);
        }
    });

    activeChannel.on('broadcast', { event: 'signal' }, ({ payload }) => {
        if (payload?.to === myUserId) {
            handlers.onSignal({ from: payload.from, signal: payload.signal });
        }
    });

    activeChannel.on('broadcast', { event: 'youtube-sync' }, ({ payload }) => {
        if (typeof payload?.url === 'string') handlers.onYouTubeSync?.(payload.url);
    });
    activeChannel.on('broadcast', { event: 'audio-sync' }, ({ payload }) => {
        if (payload?.provider === 'spotify' && typeof payload.url === 'string') handlers.onAudioSync?.(payload.provider, payload.url);
    });

    activeChannel.on('broadcast', { event: 'timer-updated' }, ({ payload }) => {
        handlers.onTimerUpdated(payload);
    });

    activeChannel.on('broadcast', { event: 'chat-message' }, ({ payload }) => {
        handlers.onChatMessage?.(payload);
    });

    activeChannel.on('broadcast', { event: 'reaction' }, ({ payload }) => {
        handlers.onReaction?.(payload);
    });

    // Cheap fallback for the rare case where a presence 'join' diff is
    // silently dropped (channel stays healthy on both ends, so nothing ever
    // errors or reconnects, but one client's presenceState<Participant>() permanently
    // never learns about a participant who is genuinely there). Every
    // client periodically broadcasts its own identity; anyone who doesn't
    // already know about the sender treats it as a missed join and self-
    // heals from the payload. Pure broadcast — never touches the presence
    // channel's join/leave lifecycle, so unlike rebuilding the whole
    // channel, it's invisible to everyone else (no phantom leave+rejoin).
    activeChannel.on('broadcast', { event: 'presence-heartbeat' }, ({ payload }) => {
        if (payload?.userId && payload.userId !== myUserId) {
            handlers.onPresenceHeartbeat?.(payload);
        }
    });

    activeChannel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `room_id=eq.${roomId}` },
        () => fetchTasks(roomId, handlers.onRoomTasksUpdate, handlers.onTasksError)
    );

    activeChannel.subscribe(async function onStatus(status: string, err?: Error) {
        // Ignore callbacks from a channel instance that's already been
        // superseded by a newer connectChannel() call.
        if (myGeneration !== connectionGeneration) return;
        handlers.onConnectionStatus?.(status);

        if (err) console.error(`[socket] channel error on status ${status}:`, err);
        if (status === 'SUBSCRIBED') {
            try {
                reconnectAttempts = 0;
                await activeChannel.track({
                    username: myUsername,
                    status: 'Online',
                    nowPlaying: null,
                    isDummyMedia: currentIsDummyMedia,
                    handRaised: currentHandRaised
                });
                if (myGeneration !== connectionGeneration) return;
                fetchTasks(roomId, handlers.onRoomTasksUpdate, handlers.onTasksError);
                emitRoomState();

                const sendHeartbeat = () => {
                    if (myGeneration !== connectionGeneration) return;
                    activeChannel.send({
                        type: 'broadcast',
                        event: 'presence-heartbeat',
                        payload: { userId: myUserId, username: myUsername, isDummyMedia: currentIsDummyMedia }
                    });
                };
                sendHeartbeat();
                heartbeatInterval = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
            } catch { return onStatus('CHANNEL_ERROR'); }
        } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            const delay = Math.min(1000 * 2 ** reconnectAttempts, MAX_RECONNECT_DELAY_MS);
            reconnectAttempts++;
            console.warn(`Channel status: ${status}, reconnecting in ${delay}ms...`);
            setTimeout(() => {
                if (myGeneration === connectionGeneration && currentRoomId === roomId) connectChannel();
            }, delay);
        }
    });
};

const fetchTasks = async (roomId: string, callback: SocketHandlers['onRoomTasksUpdate'], onError?: () => void) => {
    try {
        const { data, error } = await getSupabase().from('tasks').select('*').eq('room_id', roomId).order('created_at', { ascending: true });
        if (error) throw error;
        if (currentRoomId === roomId && Array.isArray(data)) callback({ tasks: data });
    } catch {
        if (currentRoomId === roomId) onError?.();
    }
};
export const reloadTasks = () => {
    if (currentRoomId && currentHandlers) return fetchTasks(currentRoomId, currentHandlers.onRoomTasksUpdate, currentHandlers.onTasksError);
};

export const getSocket = () => channel;
export const getMyUserId = () => myUserId;

// Changes the name broadcast in this client's own presence going forward.
// Doesn't re-track by itself — callers should follow up with a presence
// update (e.g. presence.js's updatePresence) to actually push it out.
export const updateMyUsername = (username: string) => {
    myUsername = username;
};

export const sendSignal = (to: string, signal: Signal) => {
    if (!channel) return;
    channel.send({
        type: 'broadcast',
        event: 'signal',
        payload: { to, from: myUserId, signal }
    });
};

export const updateTimer = (_roomId: string | null, action: string, payload: Partial<TimerState>) => {
    if (!channel) return;
    channel.send({
        type: 'broadcast',
        event: 'timer-updated',
        payload: { action, ...payload }
    });
};

export const updatePresence = async (_roomId: string | null, status: string, nowPlaying?: string | null) => {
    if (!channel) return;
    const state = channel.presenceState<Participant>();
    const myState: Participant = state[myUserId] ? state[myUserId][0] : {};

    await trackPresence({
        ...myState,
        username: myUsername,
        status,
        nowPlaying: nowPlaying !== undefined ? nowPlaying : myState.nowPlaying
    });
};

export const updateCameraState = async (isVideoActive: boolean) => {
    if (!channel) return;
    const state = channel.presenceState<Participant>();
    const myState = state[myUserId] ? state[myUserId][0] : {};

    await trackPresence({
        ...myState,
        isDummyMedia: !isVideoActive
    });
};

export const sendReaction = (emoji: string) => {
    if (!channel) return;
    channel.send({
        type: 'broadcast',
        event: 'reaction',
        payload: { userId: myUserId, emoji }
    });
};

// Tracked via presence rather than a one-shot broadcast — a raised hand is
// meant to be a sticky "I want attention" signal, and unlike a reaction it
// needs to survive a channel reconnect (presence re-syncs fully on every
// reconnect; a plain broadcast sent during a reconnect gap would just be
// lost, silently dropping the request).
export const sendHandRaise = async (raised: boolean) => {
    currentHandRaised = raised;
    if (!channel) return;
    const state = channel.presenceState<Participant>();
    const myState = state[myUserId] ? state[myUserId][0] : {};
    await trackPresence({
        ...myState,
        handRaised: raised
    });
};

export const broadcastYouTube = (url: string) => {
    if (!channel) return;
    return channel.send({
        type: 'broadcast',
        event: 'youtube-sync',
        payload: { url }
    });
};

export const broadcastAudio = (provider: AudioProvider, url: string) => {
    if (provider === 'youtube') return broadcastYouTube(url);
    if (channel && provider === 'spotify') return channel.send({ type: 'broadcast', event: 'audio-sync', payload: { provider, url } });
};

async function trackPresence(payload: Participant) {
    const current = channel;
    if (!current) return;
    try {
        const status = await current.track(payload);
        if (status && status !== 'ok') currentHandlers?.onConnectionStatus?.('CHANNEL_ERROR');
    } catch { currentHandlers?.onConnectionStatus?.('CHANNEL_ERROR'); }
}
