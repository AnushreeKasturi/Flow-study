import type { RealtimeChannel } from '@supabase/supabase-js';
import type { SocketHandlers, Participants, Participant, Signal, TimerState, AudioProvider } from '../types';
import { getSupabase } from './supabase';
import settings from '../../../supabase.config.json';

// Off until sql/007 is applied; see SECURITY.md, "Turning on private room channels".
const PRIVATE_CHANNELS = settings.privateRoomChannels === true;

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
            private: PRIVATE_CHANNELS,
            presence: { key: myUserId },
            broadcast: { ack: true, self: false }
        }
    });

    // Every room message arrives through here. Messages sent through the
    // database come back to their sender too, so anything carrying this tab's
    // id is dropped. `from` is stamped by the database (see room_send in
    // sql/008) and, once sql/009 is applied, cannot be forged.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listen = (event: string, handle: (payload: any) => void) =>
        activeChannel.on('broadcast', { event }, ({ payload }) => { if (payload?.sid !== SID) handle(payload); });
    const senderOf = (payload: { from?: unknown; userId?: unknown }) => typeof payload?.from === 'string' ? payload.from : payload?.userId;

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

    listen('signal', payload => {
        if (payload?.to === myUserId) {
            handlers.onSignal({ from: payload.from, signal: payload.signal });
        }
    });

    listen('youtube-sync', payload => {
        if (typeof payload?.url === 'string') handlers.onYouTubeSync?.(payload.url);
    });
    listen('audio-sync', payload => {
        if (payload?.provider === 'spotify' && typeof payload.url === 'string') handlers.onAudioSync?.(payload.provider, payload.url);
    });

    // Flood guard: a client stuck in a loop (or a hostile one) cannot lock up
    // everyone's clock. Past 20 timer messages in five seconds, the rest of that window is dropped.
    let timerWindow = 0, timerCount = 0;
    listen('timer-updated', payload => {
        const now = Date.now();
        if (now - timerWindow > 5000) { timerWindow = now; timerCount = 0; }
        if (++timerCount > 20) return;
        handlers.onTimerUpdated(payload);
    });

    listen('chat-message', payload => {
        handlers.onChatMessage?.(payload);
    });

    // Someone said they are leaving. Presence should report this too, but its
    // "leave" does not always arrive, so the leaver says it themselves as well.
    listen('bye', payload => {
        const who = senderOf(payload);
        if (typeof who === 'string' && who !== myUserId) handlers.onBye?.(who);
    });

    // The database tells the room when something needs its attention (sent from sql/008, never by a browser).
    listen('notice', payload => { if (typeof payload?.kind === 'string' && !payload.from) handlers.onNotice?.(payload.kind); });

    // The host removed someone. The room page confirms with the database before acting on it.
    listen('removed', payload => {
        if (typeof payload?.userId === 'string') handlers.onRemoved?.(payload.userId);
    });

    listen('reaction', payload => {
        const who = senderOf(payload);
        if (typeof who === 'string' && typeof payload?.emoji === 'string') handlers.onReaction?.({ userId: who, emoji: payload.emoji.slice(0, 8) });
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
    listen('presence-heartbeat', payload => {
        const who = senderOf(payload);
        if (typeof who === 'string' && who !== myUserId) handlers.onPresenceHeartbeat?.({ ...payload, userId: who });
    });

    activeChannel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `room_id=eq.${roomId}` },
        () => fetchTasks(roomId, handlers.onRoomTasksUpdate, handlers.onTasksError)
    );

    const onStatus = async (status: string, err?: Error): Promise<void> => {
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
                    sendToRoom('presence-heartbeat', { userId: myUserId, username: myUsername, isDummyMedia: currentIsDummyMedia });
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
    };
    // A private channel is joined with the user's token. Right after page load the
    // realtime socket may not have it yet, and joining without it is refused, which
    // cost a failed attempt and a retry on every entry. Hand it over first.
    const ready = PRIVATE_CHANNELS ? getSupabase().realtime.setAuth().catch(() => {}) : Promise.resolve();
    ready.then(() => { if (myGeneration === connectionGeneration) activeChannel.subscribe(onStatus); });
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

export const getMyUserId = () => myUserId;

// Changes the name broadcast in this client's own presence going forward.
// Doesn't re-track by itself; callers follow up with a presence update.
export const updateMyUsername = (username: string) => {
    myUsername = username;
};

// ── Sending ──
// Messages go through the database (room_send, sql/008), which checks the
// sender is a member and stamps who they are. One at a time, in order: call
// setup breaks if an answer overtakes its offer.
const SID = crypto.randomUUID();
let viaDatabase = true;
let outbox: Promise<unknown> = Promise.resolve();
export function sendToRoom(event: string, payload: Record<string, unknown>): Promise<string> {
    const deliver = async () => {
        const room = currentRoomId, direct = channel;
        if (!room || !direct) return 'closed';
        const message = { ...payload, sid: SID };
        if (viaDatabase) {
            const { error } = await getSupabase().rpc('room_send', { p_room: room, p_event: event, p_payload: message });
            if (!error) return 'ok';
            // PGRST202: this server has not run sql/008 yet. Use the direct path for the rest of this visit.
            if (error.code === 'PGRST202') viaDatabase = false;
        }
        // Direct broadcast: the path before sql/008, and the fallback if the database call fails.
        return String(await direct.send({ type: 'broadcast', event, payload: message }));
    };
    const result = outbox.then(deliver, deliver);
    outbox = result.catch(() => {});
    return result;
}

export const sendSignal = (to: string, signal: Signal) => { sendToRoom('signal', { to, from: myUserId, signal }); };

// Timer changes go out at most every 250 ms. A burst of clicks collapses into
// its first and last state, so the room always ends up where the sender did.
let lastTimerSend = 0;
let trailingTimerSend: ReturnType<typeof setTimeout> | undefined;
export const updateTimer = (_roomId: string | null, action: string, payload: Partial<TimerState>) => {
    const send = () => {
        lastTimerSend = Date.now();
        sendToRoom('timer-updated', { action, ...payload });
    };
    const wait = 250 - (Date.now() - lastTimerSend);
    // The periodic time-only sync never displaces a real state change that is waiting to go out.
    if (wait > 0 && trailingTimerSend && payload.mode === undefined) return;
    clearTimeout(trailingTimerSend);
    trailingTimerSend = undefined;
    if (wait <= 0) send(); else trailingTimerSend = setTimeout(() => { trailingTimerSend = undefined; send(); }, wait);
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

export const sendBye = () => sendToRoom('bye', { userId: myUserId });
export const sendRemoved = (userId: string) => sendToRoom('removed', { userId });
export const sendReaction = (emoji: string) => { sendToRoom('reaction', { userId: myUserId, emoji }); };

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

export const broadcastAudio = (provider: AudioProvider, url: string) =>
    provider === 'youtube' ? sendToRoom('youtube-sync', { url }) : sendToRoom('audio-sync', { provider, url });

async function trackPresence(payload: Participant) {
    const current = channel;
    if (!current) return;
    try {
        const status = await current.track(payload);
        if (status && status !== 'ok') currentHandlers?.onConnectionStatus?.('CHANNEL_ERROR');
    } catch { currentHandlers?.onConnectionStatus?.('CHANNEL_ERROR'); }
}
