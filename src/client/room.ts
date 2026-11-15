// The room page: lobby (name, join, create) first, then the live room.
import { reveal } from './motion';
import { showLoader, hideLoader, leaveWithLoader, loaderText } from './loader';
import type { Participants, TimerMode } from './types';
import { byId, on } from './dom';
import { bindThemePicker } from './theme';
import { initSocket, disconnectSocket, reloadTasks, getMyUserId, updateCameraState, sendReaction, sendHandRaise, sendBye } from './modules/socket';
import { initNotifications, pushNote, systemNotify } from './modules/notifications';
import { initMedia, toggleAudio, toggleVideo, handleSignal, removePeer, callUser, hasPeer, peerNeedsCall, isPeerConnected, cleanupMedia, isVideoActive, hasAudioTrack } from './modules/rtc';
import { initTimer, toggleTimer, resetTimer, setMode, syncState, setTimerSettings, broadcastCurrentState, saveFocus, restoreTimer, autoAdvance } from './modules/timer';
import { initTasks, addTask, toggleTask, deleteTask, assignTask, rerenderTasks, setSharedTasks } from './modules/tasks';
import { initPresence, startFocusTracking, stopFocusTracking, formatFocusTime } from './modules/presence';
import { initChat, handleIncomingMessage } from './modules/chat';
import { getMyProfile, hasDisplayName, saveDisplayName } from './modules/profile';
import * as UI from './modules/ui';
import supabase from './modules/supabase';
import { initAudio, loadRoomAudio } from './modules/audio';
import { notify, openModal, closeModal, initDialogs } from './modules/feedback';
import { loadUser, currentUser, markSignedOut } from './modules/session';
import { ensureTile, attachStream, removeTile, markLeft, setCameraOff, showReaction, setHandRaised } from './modules/stage';
import { playSound, stopSound, setSoundVolume, isSound, type Sound } from './modules/soundscape';
import { chime } from './modules/chime';
import { initReminders, timerReached } from './modules/reminders';
import { unlistRoom, cancelPlan } from './modules/board';
import { getStats as getTaskStats } from './modules/tasks';
import type { GroupDetails } from './types';
import { initShortcuts } from './modules/shortcuts';
import { here, partners, pendingLeaves, lastHeard, peopleHere } from './room/state';
import { applyHideIp, checkListed, chooseHideIp, hidingIp, setFromBoard } from './room/hide-ip';
import { awayTimer, isAway, setAwayState } from './room/away';
import { adoptListing, bindHosting, boardForm, listOnBoard, prepareLeave, refreshBoardSoon, roomEnded, confirmRemoval, syncHost, updateLeaveButton } from './room/hosting';
import { bindProfile } from './room/profile';
import { showHome } from './room/home';

let handRaised = false;
let toldLate = false;
let pendingTimer: unknown = null; // the room's saved timer (sql/017), put back once the room is open

const joinBtn = byId<HTMLButtonElement>('join-btn');
const hostBtn = byId<HTMLButtonElement>('host-btn');
const lobbyError = byId<HTMLElement>('lobby-error');
const roomCodeInput = byId<HTMLInputElement>('room-code-input');
const pinInput = byId<HTMLInputElement>('room-pin-input');
const appContainer = byId<HTMLElement>('app');

// A participant's realtime channel can drop and reconnect on its own (network
// blips, provider-side churn); closed-to-resubscribed takes a few seconds.
// Holding a leave past that window lets a rejoin cancel the teardown instead
// of rebuilding the peer connection and video tile for someone who never left.
const LEAVE_GRACE_MS = 18000;
// Someone who said goodbye, or has gone silent with a dead connection, is not coming back from a blip.
const CERTAIN_LEAVE_MS = 4000;
// Background tabs may only get to send a heartbeat about once a minute, so allow for that.
const SILENCE_MS = 95000;
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
    here.busy = busy;
    joinBtn.disabled = hostBtn.disabled = busy;
    joinBtn.textContent = busy && action === 'join' ? 'Joining…' : 'Join room';
    hostBtn.textContent = busy && action === 'host' ? 'Creating…' : document.querySelector<HTMLInputElement>('input[name="audience"]:checked')?.value === 'open' ? 'Open a study group' : 'Create a room';
}
function showLobbyError(message: string, action?: { label: string; run: () => void }) {
    lobbyError.textContent = message;
    if (action) {
        const button = Object.assign(document.createElement('button'), { type: 'button', className: 'link-btn', textContent: action.label });
        button.addEventListener('click', action.run);
        lobbyError.append(' ', button);
    }
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
    byId<HTMLElement>('local-dummy-avatar').textContent = UI.initial(here.username);
}
const inviteUrl = () => {
    const url = new URL('/room.html', location.origin);
    url.searchParams.set('room', here.code);
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
        // Home was drawn before there was a name to show; this updates it.
        document.dispatchEvent(new CustomEvent('flow-name', { detail: name }));
        step.classList.add('hidden');
        byId<HTMLElement>('lobby-step').classList.remove('hidden');
        roomCodeInput.focus();
    });
}

// Creates a room and walks into it. With `open`, the new room is also listed on
// the study-groups board; such a room never has a PIN.
async function createRoom(open?: Omit<GroupDetails, 'host_name'> & { planId?: string }) {
    if (here.busy) return;
    setFromBoard(!!open);
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
    if (open && here.code === createdCode) {
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
    if (here.code === createdCode && minutes >= 10 && minutes <= 90 && minutes !== 25) {
        setTimerSettings({ focus: minutes * 60, shortBreak: 5 * 60, longBreak: 15 * 60 });
        byId<HTMLInputElement>('setting-focus-duration').value = String(minutes);
    }
}

async function joinRoom() {
    if (here.busy) return;
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
            // An ended room is not a connection problem: say what happened, and offer the way on.
            if (error?.message?.includes('Room ended')) {
                showLobbyError('This room was ended by its host.', { label: 'Start a new room', run: () => { lobbyError.classList.add('hidden'); roomCodeInput.value = ''; byId<HTMLButtonElement>('host-btn').focus(); byId<HTMLButtonElement>('host-btn').click(); } });
                sessionStorage.removeItem('flow_last_room');
                return;
            }
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
        here.id = roomUuid;
        here.code = roomCode;
        here.pin = pin;
        here.enteredAt = Date.now();
        toldLate = false;
        applyHideIp(); // before any call is set up
        await checkListed(); // and before anyone is called, now that the board's answer is in
        await syncHost('', false);
        if (here.isHost) adoptListing(); // back after stepping away: the listing is still ours
        // The room's saved timer (sql/017), put back once the room is open. Older servers have none.
        pendingTimer = (await supabase.from('rooms').select('timer').eq('room_code', roomCode).maybeSingle()).data?.timer ?? null;
        // A saved display name overrides the email-derived default.
        here.username = (await getMyProfile(user.id))?.display_name || user.email.split('@')[0];
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

// What the timer callback remembers between ticks (enterRoom).
let lastPhase = '';
let lastMode = '';
let wasFocusing = false;
// A long block is saved every five minutes as it runs, so a crash loses little.
setInterval(() => { if (wasFocusing) saveFocus('focus-partial', true); }, 5 * 60 * 1000);

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
    if (here.leaving) return;
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
    const countPeople = () => UI.updateRoomInfo(roomCode, peopleHere());
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
        const arriving = !partners[userId];
        if (arriving) { chime('join'); pushNote(`${data.username || 'Someone'} joined the room.`); }
        cancelLeave(userId);
        partners[userId] = data;
        countPeople();
        updatePartnerUI(userId);
        rerenderTasks(); // the assignee picker lists everyone present
        broadcastCurrentState(); // bring the newcomer's timer in step
        // Call them now rather than at the next three-second check (the smaller id dials).
        if (arriving && (getMyUserId() || '') < userId && peerNeedsCall(userId)) callUser(userId, onRemoteStream);
    };

    initSocket(roomId, here.username, !isVideoActive(), {
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
        awayTimer(timerState);
        // Arriving partway through a block: the sun is already where the room's is. Say so, once.
        const elapsed = Math.floor((timerState.duration - timerState.timeLeft) / 60);
        if (!toldLate && timerState.isRunning && timerState.mode === 'focus' && elapsed >= 1 && Date.now() - here.enteredAt < 15000) {
            toldLate = true;
            notify(`The room is ${elapsed} min into a focus block. Settle in; your time counts from now.`);
        }
    });
    restoreTimer(pendingTimer); // where the room's block really is, after a reload
    pendingTimer = null;
    initTasks(roomId, [], (tasks, stats) => {
        const everyone = { [getMyUserId() || '']: { username: here.username }, ...partners };
        UI.renderTaskList(byId<HTMLElement>('room-task-list'), tasks, toggleTask, deleteTask, everyone, assignTask);
        UI.updateTaskStatsUI(stats);
        if (tasks.length) check('task');
    });
    taskInput.disabled = addTaskBtn.disabled = false;
    initPresence(roomId, presenceState => UI.updateMyPresenceUI(presenceState, here.username));
    initChat(roomId, here.username, (sender, text) => {
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
    on('toggle-away', () => setAwayState(!isAway()));
    on('time-visibility', () => UI.setTimeHidden(!UI.timeHidden()));
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
    const hideIpBox = byId<HTMLInputElement>('setting-hide-ip');
    on('open-timer-settings-btn', () => { hideIpBox.checked = hidingIp(); byId<HTMLInputElement>('setting-auto-advance').checked = autoAdvance(); });
    const notifyBox = byId<HTMLInputElement>('setting-notify');
    notifyBox.checked = localStorage.getItem('flow_notify') === '1';
    on('open-timer-settings-btn', () => openModal('timer-settings-modal'));
    on('close-timer-settings-btn', closeModal);
    on('save-timer-settings-btn', async () => {
        const inputs = ['setting-focus-duration', 'setting-short-break-duration', 'setting-long-break-duration'].map(id => byId<HTMLInputElement>(id));
        if (!inputs.every(input => input.reportValidity())) return;
        const [focus, shortBreak, longBreak] = inputs.map(input => Number(input.value) * 60);
        setTimerSettings({ focus, shortBreak, longBreak }, true, byId<HTMLInputElement>('setting-auto-advance').checked);
        closeModal();
        // Ask for permission only when the user ticks the box, never on page load.
        let allowed = false;
        if (notifyBox.checked && 'Notification' in window) {
            allowed = (Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission) === 'granted';
            if (!allowed) notify('Notifications are blocked for this site. Allow them in your browser settings, then tick the box again.', 'error');
        }
        notifyBox.checked = allowed;
        localStorage.setItem('flow_notify', allowed ? '1' : '0');
        // A changed choice applies at once: calls are set up again with the new route.
        if (hideIpBox.checked !== hidingIp()) {
            chooseHideIp(hideIpBox.checked);
            notify(hideIpBox.checked ? 'Your IP address is hidden. Reconnecting calls through the relay…' : 'Calls connect directly again. Reconnecting…');
        }
    });

    bindProfile();

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
        byId<HTMLElement>('invite-code-text').textContent = here.code;
        openModal('invite-modal');
        check('invite');
        requestAnimationFrame(() => inviteInput.select());
    });
    on('invite-empty-btn', () => byId<HTMLButtonElement>('share-link-btn').click());
    on('header-room-code', async () => {
        try {
            await navigator.clipboard.writeText(here.code);
            notify('Room code copied.');
        } catch {
            notify(`Copying was blocked. The room code is ${here.code}.`, 'error');
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
    bindHosting();

    // Soundscape
    const soundButtons = document.querySelectorAll<HTMLButtonElement>('[data-sound]');
    const volume = byId<HTMLInputElement>('sound-volume');
    soundButtons.forEach(button => button.addEventListener('click', () => {
        const turningOn = button.getAttribute('aria-pressed') !== 'true';
        soundButtons.forEach(item => item.setAttribute('aria-pressed', String(turningOn && item === button)));
        if (!turningOn) return stopSound();
        if (!playSound(button.dataset.sound as Sound)) notify('This browser cannot generate audio.', 'error');
    }));
    // The volume is kept between visits. Anything stored that the slider could not have set keeps its default.
    const savedVolume = localStorage.getItem('flow_sound_volume');
    if (savedVolume && /^(100|\d{1,2})$/.test(savedVolume)) volume.value = savedVolume;
    volume.addEventListener('input', () => {
        setSoundVolume(Number(volume.value) / 100);
        localStorage.setItem('flow_sound_volume', volume.value);
    });
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
        if (here.leaving) return;
        const button = event.currentTarget;
        // As host: hand the room on, or end it, before going. If that fails, stay.
        const choice = here.isHost ? document.querySelector<HTMLInputElement>('input[name="leave-choice"]:checked')?.value : 'leave';
        let ended = false;
        if (choice === 'handover' || choice === 'end' || choice === 'away') {
            button.disabled = true;
            const newHost = byId<HTMLSelectElement>('leave-new-host').value;
            const { error } = choice === 'handover' ? await supabase.rpc('transfer_host', { p_room: here.id, p_user: newHost })
                : choice === 'away' ? await supabase.rpc('step_away', { p_room: here.id })
                : await supabase.rpc('end_room', { p_room: here.id });
            button.disabled = false;
            // Before sql/012 there is no stepping away: just leave, as hosts always could.
            const plainLeave = choice === 'away' && error?.code === 'PGRST202';
            if (error && !plainLeave) { notify(choice === 'handover' ? 'The room could not be handed over. They may have just left; try again.' : choice === 'away' ? 'The room could not be kept open. Try again, or end it.' : 'The room could not be ended. Try again.', 'error'); return; }
            if (choice !== 'end' && !plainLeave) here.listed = false; // the listing stays up: theirs now, or kept for our return
            ended = choice === 'end';
        }
        here.leaving = true;
        button.disabled = true;
        sendBye(); // tell the room now; presence may take a while, or never say
        showLoader('Leaving the room…');
        cleanupMedia();
        stopSound();
        // A one-line summary, shown in the lobby we are about to return to.
        const minutes = Math.max(1, Math.round((Date.now() - here.enteredAt) / 60000));
        const tasks = getTaskStats();
        sessionStorage.setItem('flow_recap', `Last session: ${formatFocusTime(minutes)} in room ${here.code}` + (tasks.total ? `, ${tasks.completed} of ${tasks.total} tasks done.` : '.'));
        if (ended) sessionStorage.removeItem('flow_last_room'); // its code no longer works
        const goodbye = [saveFocus('focus-partial'), disconnectSocket(), here.listed ? unlistRoom(getMyUserId()) : null,
            here.isActing ? supabase.rpc('release_host', { p_room: here.id }) : null]; // standing in: the next person takes over
        try { await Promise.race([Promise.allSettled(goodbye), new Promise(resolve => setTimeout(resolve, 1500))]); }
        finally { leaveWithLoader('/room.html', 'Back to your space…', true); }
    });

    on('open-shortcuts-btn', () => openModal('shortcuts-modal'));
    on('close-shortcuts-btn', closeModal);
    // Focus mode hides chat and the bell, so C and N leave it first.
    const leaveFocusMode = () => { if (document.body.classList.contains('focus-active')) byId('focus-mode-toggle').click(); };
    initShortcuts({
        s: () => toggleTimer(),
        f: () => byId('focus-mode-toggle').click(),
        m: () => byId('toggle-mic').click(),
        v: () => byId('toggle-cam').click(),
        c: () => { leaveFocusMode(); byId('chat-tab-button').click(); byId('chat-input').focus(); },
        n: () => { leaveFocusMode(); byId<HTMLDetailsElement>('notify').open = true; byId('notify-summary').focus(); },
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
        if (here.listed) unlistRoom(getMyUserId()).then(undefined, () => {});
        if (here.isActing) supabase.rpc('release_host', { p_room: here.id }).then(undefined, () => {});
        cleanupMedia();
        disconnectSocket();
    });

    await firstRunName(user.id);
    setRoomBusy(false);
    showHome(user, { join: code => { roomCodeInput.value = code; pinInput.value = ''; return joinRoom(); }, create: createRoom, showError: showLobbyError });

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
        setFromBoard(true);
        roomCodeInput.value = seat;
        await joinRoom();
    }
    // The page held the loader through start-up; the home screen (or the room) is ready now.
    hideLoader();
}

start().catch(() => { hideLoader(); showLobbyError('Flow could not start. Refresh this page to try again.'); });
