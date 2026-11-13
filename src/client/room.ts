// The room page: lobby (name, join, create) first, then the live room.
import { reveal } from './motion';
import { showLoader, hideLoader, leaveWithLoader, loaderText } from './loader';
import type { Participants, ProfileStats, TimerMode } from './types';
import { byId } from './dom';
import { bindThemePicker } from './theme';
import { initSocket, disconnectSocket, reloadTasks, getMyUserId, updateCameraState, updateMyUsername, sendReaction, sendHandRaise, sendRemoved, sendBye } from './modules/socket';
import { initNotifications, pushNote, systemNotify } from './modules/notifications';
import { initMedia, toggleAudio, toggleVideo, handleSignal, removePeer, callUser, hasPeer, peerNeedsCall, isPeerConnected, cleanupMedia, isVideoActive, hasAudioTrack } from './modules/rtc';
import { initTimer, toggleTimer, resetTimer, setMode, syncState, setTimerSettings, broadcastCurrentState, saveFocus } from './modules/timer';
import { initTasks, addTask, toggleTask, deleteTask, assignTask, rerenderTasks, setSharedTasks } from './modules/tasks';
import { initPresence, updatePresence, startFocusTracking, stopFocusTracking, formatFocusTime } from './modules/presence';
import { initChat, handleIncomingMessage } from './modules/chat';
import { getMyProfile, hasDisplayName, saveDisplayName, getStats as getProfileStats, withLiveFocus } from './modules/profile';
import * as UI from './modules/ui';
import supabase from './modules/supabase';
import { initAudio, loadRoomAudio } from './modules/audio';
import { notify, openModal, closeModal, initDialogs } from './modules/feedback';
import { loadUser, currentUser, markSignedOut } from './modules/session';
import { ensureTile, attachStream, removeTile, markLeft, setCameraOff, showReaction, setHandRaised, setHost } from './modules/stage';
import { playSound, stopSound, setSoundVolume, isSound, type Sound } from './modules/soundscape';
import { chime } from './modules/chime';
import { initReminders, timerReached } from './modules/reminders';
import { listRoom, refreshListing, unlistRoom, setClosed, cancelPlan, fetchOpenRooms, takeSeat, statusOf, hostedBy, watchBoard } from './modules/board';
import { timerSnapshot } from './modules/timer';
import { getStats as getTaskStats } from './modules/tasks';
import type { GroupDetails } from './types';
import { initShortcuts } from './modules/shortcuts';

let currentRoomId = '';
let currentRoomCode = '';
let currentPin = '';
let listed = false; // this room is on the study-groups board, and we are its host
let isHost = false; // we host this room, so we may remove people, hand it over, or end it
let isActing = false; // the host stepped away and we host for now (sql/012): we keep the listing current
let hostAway = false;
let hostId = ''; // whoever hosts right now: the host, someone standing in, or nobody
let enteredAt = 0;
let currentUsername = '';
let partners: Participants = {};
let handRaised = false;
let roomActionBusy = false;
let leaving = false;
let cachedProfileStats: ProfileStats | null = null;

const joinBtn = byId<HTMLButtonElement>('join-btn');
const hostBtn = byId<HTMLButtonElement>('host-btn');
const lobbyError = byId<HTMLElement>('lobby-error');
const roomCodeInput = byId<HTMLInputElement>('room-code-input');
const pinInput = byId<HTMLInputElement>('room-pin-input');
const appContainer = byId<HTMLElement>('app');
const on = <T extends HTMLElement = HTMLElement>(id: string, handler: (event: MouseEvent & { currentTarget: T }) => void) =>
    byId<T>(id).addEventListener('click', handler as EventListener);

// A participant's realtime channel can drop and reconnect on its own (network
// blips, provider-side churn); closed-to-resubscribed takes a few seconds.
// Holding a leave past that window lets a rejoin cancel the teardown instead
// of rebuilding the peer connection and video tile for someone who never left.
const pendingLeaves: Record<string, ReturnType<typeof setTimeout>> = {};
const LEAVE_GRACE_MS = 18000;
// Someone who said goodbye, or has gone silent with a dead connection, is not coming back from a blip.
const CERTAIN_LEAVE_MS = 4000;
// Background tabs may only get to send a heartbeat about once a minute, so allow for that.
const SILENCE_MS = 95000;
const lastHeard: Record<string, number> = {};
const cancelLeave = (userId: string) => {
    if (!(userId in pendingLeaves)) return;
    clearTimeout(pendingLeaves[userId]);
    delete pendingLeaves[userId];
    markLeft(userId, false); // they were only gone for a moment
};

// Excludes look-alike characters (0/O, 1/I/L) so a code read aloud can't be mistyped into another valid one.
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const generateRoomCode = () => Array.from({ length: 6 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');

function signOutLocally(message?: string) {
    markSignedOut();
    localStorage.removeItem('flow_named');
    sessionStorage.removeItem('flow_last_room');
    if (message) leaveWithLoader('/login.html', message, true);
    else window.location.replace('/login.html');
}
function setRoomBusy(busy: boolean, action = 'join') {
    roomActionBusy = busy;
    joinBtn.disabled = hostBtn.disabled = busy;
    joinBtn.textContent = busy && action === 'join' ? 'Joining…' : 'Join room';
    hostBtn.textContent = busy && action === 'host' ? 'Creating…' : document.querySelector<HTMLInputElement>('input[name="audience"]:checked')?.value === 'open' ? 'Open a study group' : 'Create a room';
}
function showLobbyError(message: string) {
    lobbyError.textContent = message;
    lobbyError.classList.remove('hidden');
}
function connectionStatus(status: string) {
    const el = byId<HTMLElement>('connection-status');
    const offline = !navigator.onLine;
    el.textContent = offline ? 'Offline' : status === 'SUBSCRIBED' ? 'Connected' : 'Reconnecting…';
    el.dataset.state = offline ? 'offline' : status === 'SUBSCRIBED' ? 'connected' : 'connecting';
    byId<HTMLElement>('network-banner').classList.toggle('hidden', !offline);
}
function setToggle(button: HTMLButtonElement, pressed: boolean) {
    button.classList.toggle('active', pressed);
    button.setAttribute('aria-pressed', String(pressed));
}
function showLocalCamera(active: boolean) {
    setToggle(byId<HTMLButtonElement>('toggle-cam'), active);
    const placeholder = byId<HTMLElement>('local-dummy-placeholder');
    placeholder.classList.toggle('hidden', active);
    placeholder.querySelector<HTMLElement>('.text')!.textContent = 'Camera off';
    byId<HTMLElement>('local-dummy-avatar').textContent = UI.initial(currentUsername);
}
const inviteUrl = () => {
    const url = new URL('/room.html', location.origin);
    url.searchParams.set('room', currentRoomCode);
    return url.toString();
};

// ── Lobby ──────────────────────────────────────────────────────────────────

// New accounts name themselves once, before choosing a room. The flag saves a
// profile read on every later visit; the room still reads the saved name on join.
async function firstRunName(userId: string) {
    if (localStorage.getItem('flow_named') || await hasDisplayName(userId)) {
        localStorage.setItem('flow_named', '1');
        return;
    }
    const step = byId<HTMLFormElement>('welcome-step');
    const input = byId<HTMLInputElement>('welcome-name-input');
    const error = byId<HTMLElement>('welcome-error');
    byId<HTMLElement>('lobby-step').classList.add('hidden');
    step.classList.remove('hidden');
    input.value = localStorage.getItem('flow_pending_name') || ''; // typed during setup, not yet saved
    input.focus();
    step.addEventListener('submit', async event => {
        event.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        const button = byId<HTMLButtonElement>('welcome-save-btn');
        button.disabled = true;
        error.classList.add('hidden');
        const saved = await saveDisplayName(userId, name);
        button.disabled = false;
        if (!saved) {
            error.textContent = 'Your name could not be saved. Check your connection and try again.';
            error.classList.remove('hidden');
            return;
        }
        localStorage.setItem('flow_named', '1');
        localStorage.removeItem('flow_pending_name');
        step.classList.add('hidden');
        byId<HTMLElement>('lobby-step').classList.remove('hidden');
        roomCodeInput.focus();
    });
}

// Creates a room and walks into it. With `open`, the new room is also listed on
// the study-groups board; such a room never has a PIN.
async function createRoom(open?: Omit<GroupDetails, 'host_name'> & { planId?: string }) {
    if (roomActionBusy) return;
    const pin = open ? '' : byId<HTMLInputElement>('create-pin-input').value.trim();
    if (pin && !/^\d{4}$/.test(pin)) { showLobbyError('A PIN is 4 digits. Fix it, or leave it empty for no PIN.'); return; }
    setRoomBusy(true, 'host');
    lobbyError.classList.add('hidden');
    showLoader(open ? 'Opening your study group…' : 'Creating your room…');
    let createdCode;
    try {
        for (let attempt = 0; attempt < 5 && !createdCode; attempt++) {
            const code = generateRoomCode();
            const { data, error } = await supabase.from('rooms').select('id').eq('room_code', code).limit(1);
            if (error) throw error;
            if (data?.length) continue;
            const result = await supabase.from('rooms').insert([{ room_code: code, is_locked: !!pin, pin: pin || null }]);
            if (result.error?.code === '23505') continue;
            if (result.error) throw result.error;
            createdCode = code;
        }
        if (!createdCode) throw new Error('No available room code');
    } catch {
        showLobbyError('The room could not be created. Check your connection and try again.');
    } finally {
        setRoomBusy(false);
    }
    if (!createdCode) return;
    roomCodeInput.value = createdCode;
    pinInput.value = pin;
    await joinRoom();
    if (open && currentRoomCode === createdCode) {
        // Fill the listing form, so what the board shows is exactly what "Update listing" would send.
        byId<HTMLInputElement>('board-topic').value = open.topic;
        for (const [id, value] of [['board-seats', String(open.seats)], ['board-subject', open.subject], ['board-camera', open.camera], ['board-vibe', open.vibe]]) {
            const select = byId<HTMLSelectElement>(id);
            if ([...select.options].some(option => option.value === String(value))) select.value = String(value);
        }
        // A planned group that has now started is replaced by its live listing.
        if (await listOnBoard(boardForm()) && open.planId) cancelPlan(open.planId).then(undefined, () => {});
    }
    // A new room starts with the focus length its creator chose during setup.
    const minutes = Number(localStorage.getItem('flow_focus_minutes'));
    if (currentRoomCode === createdCode && minutes >= 10 && minutes <= 90 && minutes !== 25) {
        setTimerSettings({ focus: minutes * 60, shortBreak: 5 * 60, longBreak: 15 * 60 });
        byId<HTMLInputElement>('setting-focus-duration').value = String(minutes);
    }
}

async function joinRoom() {
    if (roomActionBusy) return;
    const roomCode = roomCodeInput.value.trim().toUpperCase();
    const pin = pinInput.value.trim();
    if (!/^[A-Z0-9]{6}$/.test(roomCode)) { showLobbyError('Enter the 6-character code shared by your study group.'); roomCodeInput.focus(); return; }
    if (pin && !/^\d{4}$/.test(pin)) { showLobbyError('Use a 4-digit PIN, or leave it empty.'); return; }
    const user = currentUser();
    if (!user) return signOutLocally();
    setRoomBusy(true);
    lobbyError.classList.add('hidden');
    showLoader('Opening your room…');
    try {
        const { data: roomUuid, error } = await supabase.rpc('join_room', { p_room_code: roomCode, p_pin: pin });
        if (error || !roomUuid) {
            showLobbyError(!error ? 'No room matches that code and PIN. Check both and try again.'
                : error.message?.includes('Too many attempts') ? 'Too many wrong codes. Wait ten minutes, then try again.'
                : error.message?.includes('Incorrect PIN') ? 'This room needs a different PIN. Enter it above and try again.'
                : error?.message?.includes('Room not found') ? 'Room not found. Check the code and try again.'
                : error?.message?.includes('Authentication required') ? 'Your sign-in has expired. Log out and log in again.'
                : error?.message?.includes('Room is full') ? 'This group is full or not taking new people right now.'
                : error?.message?.includes('Removed') ? 'The host removed you from this room, so you can’t rejoin it.'
                : 'Could not join this room. Check your connection and try again.');
            return;
        }
        currentRoomId = roomUuid;
        currentRoomCode = roomCode;
        currentPin = pin;
        enteredAt = Date.now();
        await syncHost('', false);
        if (isHost) adoptListing(); // back after stepping away: the listing is still ours
        // A saved display name overrides the email-derived default.
        currentUsername = (await getMyProfile(user.id))?.display_name || user.email.split('@')[0];
        await enterRoom(roomUuid, roomCode);
    } catch {
        cleanupMedia();
        disconnectSocket();
        appContainer.classList.add('hidden');
        openModal('join-modal');
        showLobbyError('Could not open the room. Check your connection and try again.');
    } finally {
        setRoomBusy(false);
        hideLoader();
    }
}

// ── Entering the room ──────────────────────────────────────────────────────

async function enterRoom(roomId: string, roomCode: string) {
    closeModal();
    appContainer.classList.remove('hidden');
    reveal(appContainer, 'room');
    const roomUrl = new URL(window.location.href);
    roomUrl.searchParams.set('room', roomCode);
    history.replaceState(null, '', roomUrl);
    sessionStorage.setItem('flow_last_room', roomCode);
    UI.updateRoomInfo(roomCode, 1);

    // The task list is visible from here, but tasks.ts has no room id until
    // initTasks() below; adding one in that gap would fail the insert.
    const taskInput = byId<HTMLInputElement>('new-task-input');
    const addTaskBtn = byId<HTMLButtonElement>('add-task-btn');
    taskInput.disabled = addTaskBtn.disabled = true;

    // A long wait here is almost always the browser asking for camera access; say so.
    const asking = setTimeout(() => loaderText('Allow camera and microphone to continue'), 1200);
    await initMedia(byId<HTMLVideoElement>('local-video'));
    clearTimeout(asking);
    loaderText('Opening your room…');
    if (leaving) return;
    showLocalCamera(isVideoActive());
    // The camera can work while the microphone is busy or denied. With no
    // track to toggle, disable the control instead of leaving a dead button.
    if (!hasAudioTrack()) {
        const micBtn = byId<HTMLButtonElement>('toggle-mic');
        setToggle(micBtn, false);
        micBtn.disabled = true;
        micBtn.title = 'No microphone detected';
    }

    // People inside their leave grace period are already gone as far as the room is concerned.
    const countPeople = () => UI.updateRoomInfo(roomCode, Object.keys(partners).filter(id => !(id in pendingLeaves)).length + 1);
    // One path for every kind of departure: say so at once (chime, a note on the
    // tile, one fewer in the count), then clear the tile after `grace`.
    // `unverified` is for a goodbye message, which anyone in the room could send
    // in someone else's name. It marks the tile at once (harmless, and undone by
    // that person's next heartbeat) but nothing is torn down while their call is
    // still connected: a real leaver's call drops within seconds, a faked one doesn't.
    const partnerLeft = (userId: string, grace: number, unverified = false) => {
        if (!partners[userId]) return;
        if (!(userId in pendingLeaves)) {
            chime('leave');
            markLeft(userId, true, partners[userId].username);
            pushNote(`${partners[userId].username || 'Someone'} left the room.`);
        }
        clearTimeout(pendingLeaves[userId]);
        const finish = () => {
            if (unverified && isPeerConnected(userId)) { pendingLeaves[userId] = setTimeout(finish, 3000); return; }
            delete pendingLeaves[userId];
            delete partners[userId];
            delete lastHeard[userId];
            removePeer(userId);
            removeTile(userId);
            countPeople();
            rerenderTasks();
        };
        pendingLeaves[userId] = setTimeout(finish, grace);
        countPeople();
    };
    // Last line of defence, for when neither presence nor a goodbye arrives (a
    // crashed browser, a laptop lid). Silence alone is not enough: a background
    // tab can go quiet while its call is still up. Silence with no live call is.
    // ("Not connected" rather than "failed": the reconnect loop below keeps
    // replacing a failed connection with a fresh one that hasn't failed yet.)
    setInterval(() => {
        const now = Date.now();
        Object.keys(partners).forEach(userId => {
            if (userId in pendingLeaves || now - (lastHeard[userId] ?? now) < SILENCE_MS) return;
            if (!isPeerConnected(userId)) partnerLeft(userId, CERTAIN_LEAVE_MS);
        });
    }, 5000);

    const welcome = (userId: string, data: Participants[string]) => {
        lastHeard[userId] = Date.now();
        // A new face gets a chime; someone returning from a blip does not.
        if (!partners[userId]) { chime('join'); pushNote(`${data.username || 'Someone'} joined the room.`); }
        cancelLeave(userId);
        partners[userId] = data;
        countPeople();
        updatePartnerUI(userId);
        rerenderTasks(); // the assignee picker lists everyone present
        broadcastCurrentState(); // bring the newcomer's timer in step
    };

    initSocket(roomId, currentUsername, !isVideoActive(), {
        onConnectionStatus: connectionStatus,
        onRoomState: state => {
            const users = state.participants || {};
            Object.keys(users).forEach(userId => { lastHeard[userId] = Date.now(); cancelLeave(userId); });
            // Add and update only. Presence "sync" fires on every track() call,
            // and a momentarily incomplete snapshot must not read as a
            // departure; removal belongs to the "leave" event below.
            Object.keys(users).forEach(userId => {
                if (userId === getMyUserId()) return;
                partners[userId] = users[userId];
                updatePartnerUI(userId);
            });
            countPeople();
        },
        onUserJoined: data => welcome(data.userId, data),
        // Presence says they left. It also says so during a reconnect blip, hence the long grace.
        onUserLeft: userId => partnerLeft(userId, LEAVE_GRACE_MS),
        // A goodbye message: fast, but only a hint until their call is seen to drop.
        onBye: userId => partnerLeft(userId, CERTAIN_LEAVE_MS, true),
        // Proof of life. Heals a presence "join" that never arrived, and cancels a departure that turned out to be a blip.
        onPresenceHeartbeat: data => {
            lastHeard[data.userId] = Date.now();
            if (!partners[data.userId]) welcome(data.userId, data); else cancelLeave(data.userId);
            countPeople();
        },
        onSignal: data => { lastHeard[data.from] = Date.now(); handleSignal(data, onRemoteStream); },
        onTimerUpdated: syncState,
        onTasksError: () => {
            byId<HTMLElement>('task-sync-status').textContent = 'Tasks could not be loaded.';
            byId<HTMLElement>('task-sync-status').classList.remove('hidden');
            byId<HTMLButtonElement>('retry-tasks-btn').classList.remove('hidden');
        },
        onRoomTasksUpdate: data => {
            byId<HTMLElement>('task-sync-status').classList.add('hidden');
            byId<HTMLButtonElement>('retry-tasks-btn').classList.add('hidden');
            setSharedTasks(data.tasks);
        },
        onPartnerPresenceUpdate: data => {
            if (!partners[data.userId]) return;
            partners[data.userId].presence = { status: data.status, nowPlaying: data.nowPlaying };
            updatePartnerUI(data.userId);
        },
        onChatMessage: message => handleIncomingMessage(message),
        onYouTubeSync: url => loadRoomAudio('youtube', url),
        onAudioSync: loadRoomAudio,
        onReaction: data => showReaction(data.userId, data.emoji),
        onHostChanged: (_host, name) => { syncHost(name); },
        onRoomEnded: () => { roomEnded(); },
        onNotice: kind => {
            if (kind !== 'pin-guessing') return;
            const text = 'Someone is guessing this room’s PIN. New people can’t join for the next ten minutes; everyone here is unaffected.';
            pushNote(text);
            notify(text, 'error');
        },
        onRemoved: userId => {
            if (userId === getMyUserId()) confirmRemoval();
            else if (partners[userId]) pushNote(`${partners[userId].username || 'Someone'} was removed by the host.`);
        }
    });

    // Self-healing calls: every few seconds, re-dial anyone we should be connected to but aren't.
    setInterval(() => {
        Object.keys(partners).forEach(userId => {
            if (userId === getMyUserId() || !peerNeedsCall(userId)) return;
            // A peer stuck in 'failed' still exists, so renegotiating would reuse the broken connection.
            if (hasPeer(userId)) removePeer(userId);
            // Only the smaller id dials, so two clients never call each other at once.
            if ((getMyUserId() || '') < userId) callUser(userId, onRemoteStream);
        });
    }, 3000);

    initTimer(roomId, timerState => {
        UI.updateTimerUI(timerState);
        if (timerState.isRunning) check('timer');
        // A stretch of focus just ended (paused, switched, reset, or stopped by someone else): save it now.
        const focusing = timerState.isRunning && timerState.mode === 'focus';
        if (wasFocusing && !focusing) saveFocus('focus-partial');
        wasFocusing = focusing;
        // Reminders tied to the timer fire when the room moves into a break, or back into focus.
        if (lastMode && timerState.mode !== lastMode) timerReached(timerState.mode === 'focus' ? 'focus' : 'break');
        lastMode = timerState.mode;
        // The callback fires every second; the board only needs to hear when the clock starts, stops, or changes mode.
        const phase = timerState.mode + timerState.isRunning;
        if (phase !== lastPhase) { lastPhase = phase; refreshBoardSoon(); }
        if (timerState.isRunning && timerState.mode === 'focus') startFocusTracking();
        else stopFocusTracking(timerState.isRunning ? 'On Break' : 'Online');
    });
    initTasks(roomId, [], (tasks, stats) => {
        const everyone = { [getMyUserId() || '']: { username: currentUsername }, ...partners };
        UI.renderTaskList(byId<HTMLElement>('room-task-list'), tasks, toggleTask, deleteTask, everyone, assignTask);
        UI.updateTaskStatsUI(stats);
        if (tasks.length) check('task');
    });
    taskInput.disabled = addTaskBtn.disabled = false;
    initPresence(roomId, presenceState => UI.updateMyPresenceUI(presenceState, currentUsername));
    initChat(roomId, currentUsername, (sender, text) => {
        // Only interrupt when the message would otherwise go unseen.
        const chatOpen = byId('chat-tab').classList.contains('active') && !document.body.classList.contains('focus-active') && !document.hidden;
        if (chatOpen) return;
        const badge = byId<HTMLElement>('chat-unread');
        badge.textContent = String(Math.min(99, Number(badge.textContent) + 1));
        badge.classList.remove('hidden');
        chime('message');
        pushNote(`${sender}: ${text}`, () => byId('chat-tab-button').click());
        systemNotify(`${sender} in Flow`, text);
    }, userId => partners[userId]?.username);

    // The soundscape chosen during setup starts with the room; the Sound tab turns it off.
    const sound = localStorage.getItem('flow_sound');
    if (isSound(sound)) document.querySelector<HTMLButtonElement>(`[data-sound="${sound}"]`)?.click();
    if (!localStorage.getItem('flow_first_session')) byId<HTMLElement>('room-guidance').classList.remove('hidden');
}

// First-session checklist: each item ticks itself when the thing actually happens.
function check(item: 'invite' | 'task' | 'timer') {
    const list = byId<HTMLElement>('room-guidance');
    if (list.classList.contains('hidden')) return;
    list.querySelector(`[data-check="${item}"]`)!.classList.add('done');
    if (list.querySelectorAll('li:not(.done)').length) return;
    localStorage.setItem('flow_first_session', 'done');
    setTimeout(() => list.classList.add('hidden'), 2400);
}

const onRemoteStream = (userId: string, stream: MediaStream) => attachStream(userId, stream, partners[userId]);

function updatePartnerUI(userId: string) {
    const partner = partners[userId];
    if (!partner) return;
    ensureTile(userId, partner); // everyone gets a tile, camera or not
    // A raised hand rides on presence, so it survives a channel reconnect.
    setHandRaised(userId, !!partner.handRaised);
    setCameraOff(userId, !!partner.isDummyMedia);
}

// ── Study-groups board ─────────────────────────────────────────────────────

const peopleHere = () => Object.keys(partners).filter(id => !(id in pendingLeaves)).length + 1;

async function listOnBoard(details: Omit<GroupDetails, 'host_name'>) {
    const status = byId<HTMLElement>('board-status');
    const result = await listRoom({
        ...details, host_id: getMyUserId(), room_id: currentRoomId, host_name: currentUsername.slice(0, 40),
        seats_taken: peopleHere(), closed: byId<HTMLInputElement>('board-closed').checked, ...timerSnapshot()
    });
    listed = result === 'listed';
    status.textContent = listed ? `Listed as “${details.topic}” with ${details.seats} seats. It comes off the board when you leave.`
        : result === 'locked' ? 'This room can’t go on the board. Only the person who created it can list it, and not if it has a PIN.'
        : 'The room could not be listed just now. Check your connection and try again.';
    if (!listed) notify(status.textContent, 'error');
    byId<HTMLElement>('board-unlist-btn').classList.toggle('hidden', !listed);
    byId<HTMLElement>('board-closed-row').classList.toggle('hidden', !listed);
    byId<HTMLButtonElement>('board-list-btn').textContent = listed ? 'Update listing' : 'List this room';
    if (listed) notify('Your room is on the study-groups board.');
    return listed;
}
const boardForm = () => ({
    topic: byId<HTMLInputElement>('board-topic').value.trim(), seats: Number(byId<HTMLSelectElement>('board-seats').value),
    subject: byId<HTMLSelectElement>('board-subject').value, camera: byId<HTMLSelectElement>('board-camera').value, vibe: byId<HTMLSelectElement>('board-vibe').value
});
// While listed, tell the board who is here and what the clock is doing. A
// listing nobody refreshes disappears from the board within two minutes.
// Timer changes arrive in bursts; one refresh shortly after the last is enough.
let lastPhase = '';
let lastMode = '';
let wasFocusing = false;
// A long block is saved every five minutes as it runs, so a crash loses little.
setInterval(() => { if (wasFocusing) saveFocus('focus-partial', true); }, 5 * 60 * 1000);
let boardSoon: ReturnType<typeof setTimeout> | undefined;
const refreshBoardSoon = () => { clearTimeout(boardSoon); boardSoon = setTimeout(refreshBoard, 2000); };
const refreshBoard = () => {
    if (listed) refreshListing(getMyUserId(), { seats_taken: peopleHere(), host_name: currentUsername.slice(0, 40), ...timerSnapshot() }).then(undefined, () => {});
    if (!currentRoomId || !hostAway) return;
    // The host stepped away. Whoever stands in checks in for the room (their seat stays
    // counted); if nobody does, or the stand-in has gone quiet, the database lets us take over.
    if (isActing) {
        const { timer_mode, timer_ends_at } = timerSnapshot();
        supabase.rpc('room_checkin', { p_room: currentRoomId, p_seats_taken: peopleHere() + 1, p_timer_mode: timer_mode, p_timer_ends_at: timer_ends_at })
            .then(({ data }) => { if (data === false) syncHost(); }, () => {});
    } else if (!hostId || !partners[hostId]) claimHost();
};
setInterval(refreshBoard, 45000);

// ── Who hosts ──────────────────────────────────────────────────────────────

// One place that decides who the host is, for the tiles, the remove buttons, and the leave dialog.
// While the host is away, whoever stands in is shown as host, but cannot remove people,
// hand the room on, or end it: those stay with the person who made it.
function applyHost(owner: string, away = false, acting = '') {
    const me = currentUser()?.id;
    hostAway = !!owner && away;
    hostId = hostAway ? acting : owner;
    isHost = !!owner && owner === me && !hostAway;
    isActing = hostAway && !!acting && acting === me;
    document.body.classList.toggle('is-host', isHost);
    setHost(hostId);
}

// Reads who hosts from the database, the only source trusted, and says what changed.
// `name` comes with the room's message about the change, for the note.
async function syncHost(name = '', announce = true) {
    const room = () => supabase.from('rooms').select('created_by, host_away, acting_host').eq('room_code', currentRoomCode).maybeSingle();
    let { data, error } = await room();
    // Before sql/012 there is no stepping away; fall back to whoever created the room.
    if (error) ({ data } = await supabase.from('rooms').select('created_by').eq('room_code', currentRoomCode).maybeSingle());
    const [wasHost, wasActing, wasAway, was] = [isHost, isActing, hostAway, hostId];
    applyHost(data?.created_by ?? '', !!data?.host_away, data?.acting_host ?? '');
    if (hostAway && !hostId) claimHost(); // nobody is hosting: offer to
    if (!announce || (was === hostId && wasAway === hostAway)) return;
    const who = name || partners[hostId]?.username || 'Someone';
    if (isActing) {
        pushNote('You’re the room host for now.');
        notify('You’re the room host for now. The host gets the role back when they return.');
    } else if (isHost && !wasHost) {
        pushNote('You’re the host now.');
        notify('You’re the host now. You can remove people, and hand the room on when you leave.');
        adoptListing();
    } else if (!isHost) {
        listed = false;
        if (hostAway && !hostId) pushNote(wasActing ? 'You’re no longer hosting.' : 'The host stepped away. The room stays open.');
        else if (hostAway) pushNote(`${who} is hosting for now.`);
        else if (wasAway) pushNote(`${who} is back and hosting again.`);
        else pushNote(`${who} is the host now.`);
    }
}

// Only one person stands in at a time; the database decides who.
async function claimHost() {
    const { data } = await supabase.rpc('claim_host', { p_room: currentRoomId });
    if (data === true && !isActing) await syncHost();
}

// If this room is on the board under our name, keep its listing checked in.
async function adoptListing() {
    const { data: ours } = await supabase.rpc('lists_room', { p_room: currentRoomId });
    if (ours !== true) return;
    const { data: listing } = await supabase.from('open_rooms').select('topic, subject, camera, vibe, seats, closed').eq('host_id', getMyUserId()).maybeSingle();
    if (!listing) return;
    listed = true;
    byId<HTMLInputElement>('board-topic').value = listing.topic;
    for (const [id, value] of [['board-seats', String(listing.seats)], ['board-subject', listing.subject], ['board-camera', listing.camera], ['board-vibe', listing.vibe]]) byId<HTMLSelectElement>(id).value = value;
    byId<HTMLInputElement>('board-closed').checked = listing.closed;
    byId<HTMLElement>('board-unlist-btn').classList.remove('hidden');
    byId<HTMLElement>('board-closed-row').classList.remove('hidden');
    byId<HTMLButtonElement>('board-list-btn').textContent = 'Update listing';
    refreshBoard();
}

// The host ended the room. Leave quietly, with a calm note on Home.
async function roomEnded() {
    const { error } = await supabase.rpc('join_room', { p_room_code: currentRoomCode, p_pin: currentPin });
    if (!error?.message?.includes('Room ended') || leaving) return;
    leaving = true;
    sessionStorage.setItem('flow_recap', 'The host ended the room. Your focus time from it is saved.');
    sessionStorage.removeItem('flow_last_room');
    await Promise.race([Promise.allSettled([saveFocus('focus-partial'), disconnectSocket()]), new Promise(resolve => setTimeout(resolve, 1500))]);
    cleanupMedia();
    stopSound();
    leaveWithLoader('/room.html', 'The host ended the room', true);
}

// The leave dialog says plainly what happens to the room.
const LEAVE_TEXT = 'Your camera and microphone will disconnect. You can rejoin with the room code; saved shared tasks stay in the room.';
function prepareLeave() {
    const others = Object.entries(partners).filter(([id]) => !(id in pendingLeaves));
    byId<HTMLElement>('leave-text').textContent = isActing
        ? 'You’re hosting for now. When you leave, the next person here takes over until the host is back.' : LEAVE_TEXT;
    byId<HTMLElement>('leave-host').classList.toggle('hidden', !isHost);
    if (!isHost) return updateLeaveButton();
    const select = byId<HTMLSelectElement>('leave-new-host');
    select.replaceChildren(...others.map(([id, partner]) => Object.assign(document.createElement('option'), { value: id, textContent: partner.username || 'Partner' })));
    byId<HTMLElement>('leave-handover-row').classList.toggle('hidden', !others.length);
    const board = listed ? ' and on the board' : '';
    byId<HTMLElement>('leave-away-text').textContent = (others.length
        ? `The room stays open${board}. Someone here hosts for now`
        : `The room stays open${board}. The next person to join hosts for now`) + ', and the role comes back to you when you return.';
    byId<HTMLElement>('leave-end-text').textContent = `Closes the room for good: ${others.length ? 'everyone here is sent Home, ' : ''}the code stops working${listed ? ', and it comes off the board' : ''}. Tasks and focus time are kept.`;
    document.querySelector<HTMLInputElement>('input[name="leave-choice"][value="away"]')!.checked = true;
    updateLeaveButton();
}
function updateLeaveButton() {
    const choice = isHost ? document.querySelector<HTMLInputElement>('input[name="leave-choice"]:checked')?.value : 'leave';
    byId<HTMLButtonElement>('confirm-leave-btn').textContent = choice === 'handover' ? 'Hand over and leave' : choice === 'end' ? 'End room for everyone' : choice === 'away' ? 'Step away' : 'Leave room';
}

// ── Host controls ──────────────────────────────────────────────────────────

let removing = '';
function askToRemove(userId: string) {
    if (!isHost || !partners[userId]) return;
    removing = userId;
    byId<HTMLElement>('remove-title').textContent = `Remove ${partners[userId].username || 'this person'}?`;
    openModal('remove-modal');
}
async function removeFromRoom() {
    const userId = removing;
    closeModal();
    const { error } = await supabase.rpc('remove_participant', { p_room: currentRoomId, p_user: userId });
    if (error) { notify('They could not be removed. Only the person who created the room can do this.', 'error'); return; }
    // The database has already shut them out; this tells their browser to leave now.
    sendRemoved(userId);
    notify(`${partners[userId]?.username || 'They'} was removed from the room.`);
    refreshBoard();
}
// Anyone could send a "removed" message, so it is only a hint. The database
// decides: if it still lets us in, the message was not real and is ignored.
async function confirmRemoval() {
    const { error } = await supabase.rpc('join_room', { p_room_code: currentRoomCode, p_pin: currentPin });
    if (!error?.message?.includes('Removed')) return;
    leaving = true;
    cleanupMedia();
    stopSound();
    sessionStorage.removeItem('flow_last_room');
    sessionStorage.setItem('flow_notice', 'The host removed you from that room.');
    await Promise.race([disconnectSocket(), new Promise(resolve => setTimeout(resolve, 1000))]);
    leaveWithLoader('/room.html', 'Back to your space…', true);
}

// ── Lobby home ─────────────────────────────────────────────────────────────

// Seven days of focus as small bars, oldest first; today includes time still in progress.
function weekChart(stats: ProfileStats) {
    const minutes = stats.weekSeconds.map((seconds, index) => index === 6 ? stats.todayMinutes : Math.floor(seconds / 60));
    const peak = Math.max(...minutes, 1);
    const days = minutes.map((value, index) => {
        const date = new Date();
        date.setDate(date.getDate() - (6 - index));
        const day = date.toLocaleDateString(undefined, { weekday: 'short' });
        return { day, value, tip: `${index === 6 ? 'Today' : day}: ${formatFocusTime(value)}` };
    });
    return `<div class="week" role="img" aria-label="Focus over the last seven days. ${days.map(d => d.tip).join(', ')}.">` +
        days.map((d, index) => `<div class="week-day${index === 6 ? ' today' : ''}" data-tip="${d.tip}"><i style="height:${Math.round(d.value / peak * 58)}px"></i>${d.day.charAt(0)}</div>`).join('') + '</div>';
}

// Home: who you are and how your week went on the left; groups open right now on the right.
async function showHome(user: { id: string; email: string }) {
    const recap = sessionStorage.getItem('flow_recap');
    sessionStorage.removeItem('flow_recap');
    if (recap) byId<HTMLElement>('lobby-recap').textContent = recap;
    const notice = sessionStorage.getItem('flow_notice');
    sessionStorage.removeItem('flow_notice');
    if (notice) showLobbyError(notice);

    const setName = (name: string) => {
        byId<HTMLElement>('join-title').textContent = `Hi, ${name}.`;
        byId<HTMLElement>('home-avatar').textContent = UI.initial(name);
        byId<HTMLInputElement>('home-name-input').value = name;
    };
    setName(user.email.split('@')[0]);
    getMyProfile(user.id).then(profile => { if (profile?.display_name) setName(profile.display_name); });
    const nameForm = byId<HTMLFormElement>('home-name-form');
    on('home-edit-name', () => { nameForm.classList.toggle('hidden'); byId<HTMLInputElement>('home-name-input').select(); });
    nameForm.addEventListener('submit', async event => {
        event.preventDefault();
        const name = byId<HTMLInputElement>('home-name-input').value.trim();
        if (!name) return;
        if (!await saveDisplayName(user.id, name)) { showLobbyError('Your name could not be saved. Check your connection and try again.'); return; }
        setName(name);
        nameForm.classList.add('hidden');
    });

    getProfileStats(user.id).then(stats => {
        // Numbers and locale weekday names only; nothing here comes from another user.
        byId<HTMLElement>('home-stats').innerHTML =
            `<div class="home-today"><div><span>Focused today</span><strong>${formatFocusTime(stats.todayMinutes)}</strong></div>${weekChart(stats)}</div>` +
            `<dl class="home-figures"><div><dt>Streak</dt><dd>${stats.streak} day${stats.streak === 1 ? '' : 's'}</dd></div><div><dt>All time</dt><dd>${formatFocusTime(stats.totalMinutes)}</dd></div><div><dt>Sessions</dt><dd>${stats.sessionsCompleted}</dd></div></dl>`;
    }).catch(() => {});

    // Open groups on Home stay current: the board's ping refreshes them within a second.
    const homeGroups = () => fetchOpenRooms().then(rooms => {
        const free = rooms.filter(room => !room.closed && room.seats_taken < room.seats && (room.host_id !== user.id || !!room.away_until));
        byId<HTMLElement>('lobby-board').replaceChildren(Object.assign(document.createElement('a'), {
            href: '/groups.html', textContent: free.length ? `${free.length} group${free.length === 1 ? ' has' : 's have'} a free seat right now` : 'No group is open this minute. See what’s planned'
        }), '.');
        byId<HTMLElement>('home-groups').replaceChildren(...free.slice(0, 3).map(room => {
            const item = document.createElement('li');
            const text = document.createElement('div');
            text.append(Object.assign(document.createElement('strong'), { textContent: room.topic }), Object.assign(document.createElement('span'), { textContent: `${room.host_id === user.id ? 'Your room' : hostedBy(room)}, ${statusOf(room).toLowerCase()}` }));
            const sit = Object.assign(document.createElement('button'), { className: 'btn btn-primary', type: 'button', textContent: room.host_id === user.id ? 'Return' : 'Join' });
            sit.setAttribute('aria-label', `Take a seat in ${room.topic}`);
            sit.addEventListener('click', async () => {
                if (roomActionBusy) return;
                sit.disabled = true;
                const seat = await takeSeat(room.id);
                if ('code' in seat) { roomCodeInput.value = seat.code; pinInput.value = ''; await joinRoom(); }
                else { showLobbyError(seat.reason); sit.disabled = false; }
            });
            item.append(text, sit);
            return item;
        }));
    }).catch(() => {});
    homeGroups();
    watchBoard(() => { if (!appContainer.classList.contains('hidden')) return; homeGroups(); });

    // "Start a room": the audience choice swaps between a PIN and a board topic.
    const audience = () => (document.querySelector<HTMLInputElement>('input[name="audience"]:checked')!).value;
    document.querySelectorAll('input[name="audience"]').forEach(radio => radio.addEventListener('change', () => {
        byId('create-private').classList.toggle('hidden', audience() === 'open');
        byId('create-open').classList.toggle('hidden', audience() !== 'open');
        hostBtn.textContent = audience() === 'open' ? 'Open a study group' : 'Create a room';
    }));
    on('host-btn', () => {
        if (audience() !== 'open') return createRoom();
        const topic = byId<HTMLInputElement>('create-topic').value.trim();
        if (topic.length < 3) { showLobbyError('Say what you’re studying, so people know what the group is for.'); byId('create-topic').focus(); return; }
        createRoom({ topic, subject: byId<HTMLSelectElement>('create-subject').value, seats: Number(byId<HTMLSelectElement>('create-seats').value), camera: 'optional', vibe: 'quiet' });
    });
}

// ── Profile ────────────────────────────────────────────────────────────────

function renderProfileStats(stats: ProfileStats) {
    const week = weekChart(stats);
    const note = stats.liveMinutes ? `Includes ${stats.liveMinutes} live minute${stats.liveMinutes === 1 ? '' : 's'} from this visit.` : 'Your focus time, one session at a time.';
    const rows = [
        ['All-time focus', formatFocusTime(stats.totalMinutes)],
        ['Current streak', `${stats.streak} day${stats.streak === 1 ? '' : 's'}`],
        ['Completed sessions', stats.sessionsCompleted],
        ['Completed tasks', stats.tasksCompleted]
    ];
    const markup = `<div class="focus-summary"><div><span>Focused today</span><strong id="profile-today-value">${formatFocusTime(stats.todayMinutes)}</strong><p>${note}</p></div>${week}</div>` +
        `<dl class="profile-stat-list">${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('')}</dl>`;
    const container = byId<HTMLElement>('profile-stats');
    if (container.innerHTML !== markup) container.innerHTML = markup;
}
const profileOpen = () => !byId<HTMLElement>('profile-modal').classList.contains('hidden');

async function openProfile() {
    openModal('profile-modal');
    byId<HTMLInputElement>('profile-display-name-input').value = currentUsername;
    byId<HTMLElement>('profile-avatar').textContent = UI.initial(currentUsername);
    const statsEl = byId<HTMLElement>('profile-stats');
    cachedProfileStats = null;
    statsEl.innerHTML = '<p class="panel-description">Loading…</p>';
    try {
        cachedProfileStats = await getProfileStats(getMyUserId());
        renderProfileStats(withLiveFocus(cachedProfileStats));
    } catch {
        statsEl.textContent = 'Stats are unavailable right now. Close and reopen your profile to retry.';
    }
}

async function saveProfileName() {
    const input = byId<HTMLInputElement>('profile-display-name-input');
    const button = byId<HTMLButtonElement>('save-profile-name-btn');
    const newName = input.value.trim();
    if (!newName || newName.length > 40) { input.reportValidity(); return; }
    button.textContent = 'Saving…';
    button.disabled = true;
    const saved = await saveDisplayName(getMyUserId(), newName);
    button.textContent = 'Save Name';
    button.disabled = false;
    if (!saved) { notify('Your name could not be saved. Please try again.', 'error'); return; }

    currentUsername = newName;
    updateMyUsername(newName);
    updatePresence({});
    byId<HTMLElement>('local-dummy-avatar').textContent = byId<HTMLElement>('profile-avatar').textContent = UI.initial(newName);
    notify('Display name saved.');
    refreshBoard(); // a listed room shows the host's new name straight away
}

// ── Wiring ─────────────────────────────────────────────────────────────────

function bindRoomControls() {
    on<HTMLButtonElement>('toggle-mic', event => {
        const enabled = toggleAudio();
        if (enabled === null) { notify('No microphone is available. Check your browser permissions, then rejoin.', 'error'); return; }
        setToggle(event.currentTarget, enabled);
    });
    on('toggle-cam', () => {
        const enabled = toggleVideo();
        showLocalCamera(enabled);
        updateCameraState(enabled);
    });
    document.querySelectorAll<HTMLButtonElement>('.reaction-btn').forEach(button => button.addEventListener('click', () => {
        const emoji = button.dataset.emoji!;
        sendReaction(emoji);
        showReaction(getMyUserId(), emoji); // broadcasts don't echo to the sender
    }));
    on<HTMLButtonElement>('toggle-hand', event => {
        handRaised = !handRaised;
        setToggle(event.currentTarget, handRaised);
        sendHandRaise(handRaised);
        setHandRaised(getMyUserId(), handRaised);
    });

    // Timer
    on('timer-toggle-btn', () => toggleTimer());
    on('timer-reset-btn', () => resetTimer());
    on<HTMLButtonElement>('focus-mode-toggle', event => setToggle(event.currentTarget, document.body.classList.toggle('focus-active')));
    UI.UI.timerModes.forEach(button => button.addEventListener('click', () => setMode(button.dataset.mode as TimerMode)));
    const notifyBox = byId<HTMLInputElement>('setting-notify');
    notifyBox.checked = localStorage.getItem('flow_notify') === '1';
    on('open-timer-settings-btn', () => openModal('timer-settings-modal'));
    on('close-timer-settings-btn', closeModal);
    on('save-timer-settings-btn', async () => {
        const inputs = ['setting-focus-duration', 'setting-short-break-duration', 'setting-long-break-duration'].map(id => byId<HTMLInputElement>(id));
        if (!inputs.every(input => input.reportValidity())) return;
        const [focus, shortBreak, longBreak] = inputs.map(input => Number(input.value) * 60);
        setTimerSettings({ focus, shortBreak, longBreak });
        closeModal();
        // Ask for permission only when the user ticks the box, never on page load.
        let allowed = false;
        if (notifyBox.checked && 'Notification' in window) {
            allowed = (Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission) === 'granted';
            if (!allowed) notify('Notifications are blocked for this site. Allow them in your browser settings, then tick the box again.', 'error');
        }
        notifyBox.checked = allowed;
        localStorage.setItem('flow_notify', allowed ? '1' : '0');
    });

    // Profile
    const profileCard = byId<HTMLElement>('my-presence-card');
    profileCard.addEventListener('click', openProfile);
    profileCard.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openProfile(); }
    });
    on('close-profile-btn', closeModal);
    on('save-profile-name-btn', saveProfileName);
    document.addEventListener('focus-progress', () => {
        if (cachedProfileStats && profileOpen()) renderProfileStats(withLiveFocus(cachedProfileStats));
    });
    document.addEventListener('session-completed', async () => {
        cachedProfileStats = null;
        if (!profileOpen()) return;
        try {
            cachedProfileStats = await getProfileStats(getMyUserId());
            renderProfileStats(withLiveFocus(cachedProfileStats));
        } catch { notify('Your focus summary could not be refreshed. Reopen it to retry.', 'error'); }
    });

    // Tasks
    const taskInput = byId<HTMLInputElement>('new-task-input');
    const addTaskBtn = byId<HTMLButtonElement>('add-task-btn');
    const submitTask = async () => {
        if (addTaskBtn.disabled) return;
        const title = taskInput.value;
        addTaskBtn.disabled = true;
        try { if (await addTask(title) && taskInput.value === title) taskInput.value = ''; }
        finally { addTaskBtn.disabled = false; }
    };
    addTaskBtn.addEventListener('click', submitTask);
    taskInput.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); submitTask(); }
    });
    on<HTMLButtonElement>('retry-tasks-btn', async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await reloadTasks(); } finally { button.disabled = false; }
    });

    // Invite
    const inviteInput = byId<HTMLInputElement>('invite-link-input');
    on('share-link-btn', () => {
        inviteInput.value = inviteUrl();
        byId<HTMLElement>('invite-code-text').textContent = currentRoomCode;
        openModal('invite-modal');
        check('invite');
        requestAnimationFrame(() => inviteInput.select());
    });
    on('invite-empty-btn', () => byId<HTMLButtonElement>('share-link-btn').click());
    on('header-room-code', async () => {
        try {
            await navigator.clipboard.writeText(currentRoomCode);
            notify('Room code copied.');
        } catch {
            notify(`Copying was blocked. The room code is ${currentRoomCode}.`, 'error');
        }
    });
    on('copy-invite-btn', async () => {
        try {
            await navigator.clipboard.writeText(inviteInput.value);
            notify('Invite link copied.');
        } catch {
            inviteInput.select();
            notify('Copying was blocked. The link is selected; copy it with your keyboard.', 'error');
        }
    });
    on('close-invite-btn', closeModal);
    byId<HTMLFormElement>('board-form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = byId<HTMLButtonElement>('board-list-btn');
        button.disabled = true;
        try { await listOnBoard(boardForm()); }
        finally { button.disabled = false; }
    });
    on('board-unlist-btn', async () => {
        await unlistRoom(getMyUserId());
        listed = false;
        byId<HTMLElement>('board-unlist-btn').classList.add('hidden');
        byId<HTMLElement>('board-closed-row').classList.add('hidden');
        byId<HTMLButtonElement>('board-list-btn').textContent = 'List this room';
        byId<HTMLElement>('board-status').textContent = 'Removed from the board. People already here stay.';
    });
    const closedBox = byId<HTMLInputElement>('board-closed');
    closedBox.addEventListener('change', async () => {
        const { error } = await setClosed(getMyUserId(), closedBox.checked);
        if (error) { closedBox.checked = !closedBox.checked; notify('That could not be changed. Try again.', 'error'); return; }
        notify(closedBox.checked ? 'New people can no longer join.' : 'Your room is taking new people again.');
    });

    // Host controls
    document.addEventListener('flow-remove', event => askToRemove((event as CustomEvent<string>).detail));
    on('cancel-remove-btn', closeModal);
    on('confirm-remove-btn', removeFromRoom);

    // Soundscape
    const soundButtons = document.querySelectorAll<HTMLButtonElement>('[data-sound]');
    const volume = byId<HTMLInputElement>('sound-volume');
    soundButtons.forEach(button => button.addEventListener('click', () => {
        const turningOn = button.getAttribute('aria-pressed') !== 'true';
        soundButtons.forEach(item => item.setAttribute('aria-pressed', String(turningOn && item === button)));
        if (!turningOn) return stopSound();
        if (!playSound(button.dataset.sound as Sound)) notify('This browser cannot generate audio.', 'error');
    }));
    volume.addEventListener('input', () => setSoundVolume(Number(volume.value) / 100));
    setSoundVolume(Number(volume.value) / 100);

    // Tabs
    const tabs = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
    tabs.forEach(tab => {
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const step = event.key === 'ArrowRight' ? 1 : -1;
            const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[([...tabs].indexOf(tab) + step + tabs.length) % tabs.length];
            next?.click();
            next?.focus();
        });
        tab.addEventListener('click', () => {
            tabs.forEach(other => {
                const selected = other === tab;
                other.classList.toggle('active', selected);
                other.setAttribute('aria-selected', String(selected));
                other.tabIndex = selected ? 0 : -1;
                byId(other.dataset.tab!).classList.toggle('active', selected);
            });
            reveal(byId(tab.dataset.tab!));
            if (tab.id === 'chat-tab-button') { byId('chat-unread').textContent = '0'; byId('chat-unread').classList.add('hidden'); }
        });
    });

    // Leaving
    on('leave-btn', () => { prepareLeave(); openModal('leave-modal'); });
    document.querySelector<HTMLElement>('.app-header .brand')!.addEventListener('click', event => { event.preventDefault(); prepareLeave(); openModal('leave-modal'); });
    document.querySelectorAll('input[name="leave-choice"]').forEach(radio => radio.addEventListener('change', updateLeaveButton));
    on('cancel-leave-btn', closeModal);
    on<HTMLButtonElement>('confirm-leave-btn', async event => {
        if (leaving) return;
        const button = event.currentTarget;
        // As host: hand the room on, or end it, before going. If that fails, stay.
        const choice = isHost ? document.querySelector<HTMLInputElement>('input[name="leave-choice"]:checked')?.value : 'leave';
        let ended = false;
        if (choice === 'handover' || choice === 'end' || choice === 'away') {
            button.disabled = true;
            const newHost = byId<HTMLSelectElement>('leave-new-host').value;
            const { error } = choice === 'handover' ? await supabase.rpc('transfer_host', { p_room: currentRoomId, p_user: newHost })
                : choice === 'away' ? await supabase.rpc('step_away', { p_room: currentRoomId })
                : await supabase.rpc('end_room', { p_room: currentRoomId });
            button.disabled = false;
            // Before sql/012 there is no stepping away: just leave, as hosts always could.
            const plainLeave = choice === 'away' && error?.code === 'PGRST202';
            if (error && !plainLeave) { notify(choice === 'handover' ? 'The room could not be handed over. They may have just left; try again.' : choice === 'away' ? 'The room could not be kept open. Try again, or end it.' : 'The room could not be ended. Try again.', 'error'); return; }
            if (choice !== 'end' && !plainLeave) listed = false; // the listing stays up: theirs now, or kept for our return
            ended = choice === 'end';
        }
        leaving = true;
        button.disabled = true;
        sendBye(); // tell the room now; presence may take a while, or never say
        showLoader('Leaving the room…');
        cleanupMedia();
        stopSound();
        // A one-line summary, shown in the lobby we are about to return to.
        const minutes = Math.max(1, Math.round((Date.now() - enteredAt) / 60000));
        const tasks = getTaskStats();
        sessionStorage.setItem('flow_recap', `Last session: ${formatFocusTime(minutes)} in room ${currentRoomCode}` + (tasks.total ? `, ${tasks.completed} of ${tasks.total} tasks done.` : '.'));
        if (ended) sessionStorage.removeItem('flow_last_room'); // its code no longer works
        const goodbye = [saveFocus('focus-partial'), disconnectSocket(), listed ? unlistRoom(getMyUserId()) : null,
            isActing ? supabase.rpc('release_host', { p_room: currentRoomId }) : null]; // standing in: the next person takes over
        try { await Promise.race([Promise.allSettled(goodbye), new Promise(resolve => setTimeout(resolve, 1500))]); }
        finally { leaveWithLoader('/room.html', 'Back to your space…', true); }
    });

    on('open-shortcuts-btn', () => openModal('shortcuts-modal'));
    on('close-shortcuts-btn', closeModal);
    initShortcuts({
        s: () => toggleTimer(),
        f: () => byId('focus-mode-toggle').click(),
        m: () => byId('toggle-mic').click(),
        v: () => byId('toggle-cam').click(),
        '?': () => openModal('shortcuts-modal')
    });
}

async function start() {
    const user = await loadUser();
    if (!user) return signOutLocally();
    // Supabase reports SIGNED_OUT when a refresh token can no longer be renewed.
    supabase.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') signOutLocally(); });

    initDialogs();
    initNotifications();
    initReminders();
    initAudio();
    bindThemePicker(byId<HTMLSelectElement>('theme-picker'));
    bindRoomControls();

    const invited = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '';
    roomCodeInput.value = invited || sessionStorage.getItem('flow_last_room') || '';
    // Arriving from an invite link: say so, and make joining the obvious next step.
    // (The person still presses Join; a link never puts anyone in a room by itself.)
    if (/^[A-Z0-9]{6}$/.test(invited)) {
        byId<HTMLElement>('join-heading').textContent = 'You’re invited';
        byId<HTMLElement>('join-hint').textContent = `Room ${invited} is waiting for you. Press Join to go in.`;
        byId<HTMLElement>('join-heading').closest('.home-card')!.classList.add('invited');
        joinBtn.classList.add('btn-primary');
        hostBtn.classList.remove('btn-primary');
        joinBtn.dataset.autofocus = '';
        roomCodeInput.removeAttribute('data-autofocus');
    }
    on('join-btn', joinRoom);
    [roomCodeInput, pinInput].forEach(input => input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); joinRoom(); }
    }));
    on('logout-link', async event => {
        event.preventDefault();
        showLoader('Signing you out…');
        try { await supabase.auth.signOut(); } catch { /* Clear the local login even when offline. */ }
        signOutLocally('Signing you out…');
    });

    window.addEventListener('offline', () => connectionStatus('OFFLINE'));
    window.addEventListener('online', () => connectionStatus('CONNECTING'));
    connectionStatus('CONNECTING');
    // Drop from presence at once when the tab closes or reloads.
    window.addEventListener('pagehide', () => {
        saveFocus('focus-partial'); // sent with keepalive, so it outlives the closing tab
        sendBye();
        // Closing the tab ends the listing now, rather than when it expires two minutes later.
        if (listed) unlistRoom(getMyUserId()).then(undefined, () => {});
        if (isActing) supabase.rpc('release_host', { p_room: currentRoomId }).then(undefined, () => {});
        cleanupMedia();
        disconnectSocket();
    });

    await firstRunName(user.id);
    setRoomBusy(false);
    showHome(user);

    // Arriving from the study-groups board: either to host a new group, or with a seat already taken.
    // Both are one-time notes left by the board page in this tab. A URL alone never joins a room:
    // an invite link only fills in the code, and the person still presses Join.
    const hosting = sessionStorage.getItem('flow_host');
    const seat = sessionStorage.getItem('flow_join');
    sessionStorage.removeItem('flow_host');
    sessionStorage.removeItem('flow_join');
    if (hosting) {
        const plan = JSON.parse(hosting);
        if (typeof plan.topic === 'string') await createRoom({ topic: plan.topic, subject: plan.subject, camera: plan.camera, vibe: plan.vibe, seats: Math.min(6, Math.max(2, Number(plan.seats) || 4)), planId: typeof plan.planId === 'string' ? plan.planId : undefined });
    } else if (seat && /^[A-Z0-9]{6}$/.test(seat)) {
        roomCodeInput.value = seat;
        await joinRoom();
    }
    // The page held the loader through start-up; the home screen (or the room) is ready now.
    hideLoader();
}

start().catch(() => { hideLoader(); showLobbyError('Flow could not start. Refresh this page to try again.'); });
