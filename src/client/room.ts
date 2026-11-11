// The room page: lobby (name, join, create) first, then the live room.
import { reveal } from './motion';
import type { Participants, ProfileStats, TimerMode } from './types';
import { byId } from './dom';
import { bindThemePicker } from './theme';
import { initSocket, disconnectSocket, reloadTasks, getMyUserId, updateCameraState, updateMyUsername, sendReaction, sendHandRaise } from './modules/socket';
import { initMedia, toggleAudio, toggleVideo, handleSignal, removePeer, callUser, hasPeer, peerNeedsCall, cleanupMedia, isVideoActive, hasAudioTrack } from './modules/rtc';
import { initTimer, toggleTimer, resetTimer, setMode, syncState, setTimerSettings, broadcastCurrentState } from './modules/timer';
import { initTasks, addTask, toggleTask, deleteTask, assignTask, rerenderTasks, setSharedTasks } from './modules/tasks';
import { initPresence, updatePresence, startFocusTracking, stopFocusTracking, formatFocusTime } from './modules/presence';
import { initChat, handleIncomingMessage } from './modules/chat';
import { getMyProfile, hasDisplayName, saveDisplayName, getStats as getProfileStats, withLiveFocus } from './modules/profile';
import * as UI from './modules/ui';
import supabase from './modules/supabase';
import { initAudio, loadRoomAudio } from './modules/audio';
import { notify, openModal, closeModal, initDialogs } from './modules/feedback';
import { getStoredUser } from './modules/utils';
import { ensureTile, attachStream, removeTile, markLeft, setCameraOff, showReaction, setHandRaised } from './modules/stage';
import { playSound, stopSound, setSoundVolume, isSound, type Sound } from './modules/soundscape';
import { chime } from './modules/chime';
import { listRoom, refreshListing, unlistRoom } from './modules/board';
import { initShortcuts } from './modules/shortcuts';

let currentRoomId = '';
let currentRoomCode = '';
let listed = false; // this room is on the study-groups board, and we are its host
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
const cancelLeave = (userId: string) => {
    if (!(userId in pendingLeaves)) return;
    clearTimeout(pendingLeaves[userId]);
    delete pendingLeaves[userId];
    markLeft(userId, false); // they were only gone for a moment
};

// Excludes look-alike characters (0/O, 1/I/L) so a code read aloud can't be mistyped into another valid one.
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const generateRoomCode = () => Array.from({ length: 6 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');

function signOutLocally() {
    localStorage.removeItem('flow_user');
    localStorage.removeItem('flow_named');
    sessionStorage.removeItem('flow_last_room');
    window.location.replace('/login.html');
}
function setRoomBusy(busy: boolean, action = 'join') {
    roomActionBusy = busy;
    joinBtn.disabled = hostBtn.disabled = busy;
    joinBtn.textContent = busy && action === 'join' ? 'Joining…' : 'Join room';
    hostBtn.textContent = busy && action === 'host' ? 'Creating…' : 'Create a room';
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

async function createRoom() {
    if (roomActionBusy) return;
    const pin = pinInput.value.trim();
    if (pin && !/^\d{4}$/.test(pin)) { showLobbyError('Use a 4-digit PIN, or leave it empty.'); return; }
    setRoomBusy(true, 'host');
    lobbyError.classList.add('hidden');
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
    await joinRoom();
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
    const user = getStoredUser();
    if (!user) return signOutLocally();
    setRoomBusy(true);
    lobbyError.classList.add('hidden');
    try {
        const { data: roomUuid, error } = await supabase.rpc('join_room', { p_room_code: roomCode, p_pin: pin });
        if (error || !roomUuid) {
            showLobbyError(error?.message?.includes('Incorrect PIN') ? 'This room needs a different PIN. Enter it above and try again.'
                : error?.message?.includes('Room not found') ? 'Room not found. Check the code and try again.'
                : error?.message?.includes('Authentication required') ? 'Your sign-in has expired. Log out and log in again.'
                : 'Could not join this room. Check your connection and try again.');
            return;
        }
        currentRoomId = roomUuid;
        currentRoomCode = roomCode;
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

    await initMedia(byId<HTMLVideoElement>('local-video'));
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
    const welcome = (userId: string, data: Participants[string]) => {
        // A new face gets a chime; someone returning from a blip does not.
        if (!partners[userId]) chime('join');
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
            Object.keys(users).forEach(cancelLeave);
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
        onUserLeft: userId => {
            if (!partners[userId]) return;
            // Say so at once: chime, a note on their tile, and one fewer in the count.
            // The connection itself is only torn down after the grace period.
            if (!(userId in pendingLeaves)) { chime('leave'); markLeft(userId, true, partners[userId].username); }
            clearTimeout(pendingLeaves[userId]);
            pendingLeaves[userId] = setTimeout(() => {
                delete pendingLeaves[userId];
                delete partners[userId];
                removePeer(userId);
                removeTile(userId);
                countPeople();
                rerenderTasks();
            }, LEAVE_GRACE_MS);
            countPeople();
        },
        // Heals a presence "join" that never arrived; a no-op for people we already know.
        onPresenceHeartbeat: data => { if (!partners[data.userId]) welcome(data.userId, data); },
        onSignal: data => handleSignal(data, onRemoteStream),
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
        onChatMessage: handleIncomingMessage,
        onYouTubeSync: url => loadRoomAudio('youtube', url),
        onAudioSync: loadRoomAudio,
        onReaction: data => showReaction(data.userId, data.emoji)
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
    initChat(roomId, currentUsername);

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

async function listOnBoard(topic: string, seats: number) {
    const status = byId<HTMLElement>('board-status');
    listed = await listRoom({ host_id: getMyUserId(), room_id: currentRoomId, host_name: currentUsername.slice(0, 40), topic, seats, seats_taken: peopleHere() });
    status.textContent = listed ? `Listed as “${topic}” with ${seats} seats. It comes off the board when you leave.` : 'This room could not be listed. Rooms with a PIN can’t go on the board.';
    byId<HTMLElement>('board-unlist-btn').classList.toggle('hidden', !listed);
    byId<HTMLButtonElement>('board-list-btn').textContent = listed ? 'Update listing' : 'List this room';
    if (listed) notify('Your room is on the study-groups board.');
    return listed;
}
// While listed, keep the seat count and "still here" time fresh. A listing
// nobody refreshes disappears from the board within two minutes.
setInterval(() => { if (listed) refreshListing(getMyUserId(), peopleHere()).then(undefined, () => {}); }, 45000);

// ── Profile ────────────────────────────────────────────────────────────────

function renderProfileStats(stats: ProfileStats) {
    // Seven days of focus, oldest first; today includes time still in progress.
    const minutes = stats.weekSeconds.map((seconds, index) => index === 6 ? stats.todayMinutes : Math.floor(seconds / 60));
    const peak = Math.max(...minutes, 1);
    const days = minutes.map((value, index) => {
        const date = new Date();
        date.setDate(date.getDate() - (6 - index));
        const day = date.toLocaleDateString(undefined, { weekday: 'short' });
        return { day, value, tip: `${index === 6 ? 'Today' : day}: ${formatFocusTime(value)}` };
    });
    const week = `<div class="week" role="img" aria-label="Focus over the last seven days. ${days.map(d => d.tip).join(', ')}.">` +
        days.map((d, index) => `<div class="week-day${index === 6 ? ' today' : ''}" data-tip="${d.tip}"><i style="height:${Math.round(d.value / peak * 58)}px"></i>${d.day.charAt(0)}</div>`).join('') + '</div>';
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
        try { await listOnBoard(byId<HTMLInputElement>('board-topic').value.trim(), Number(byId<HTMLSelectElement>('board-seats').value)); }
        finally { button.disabled = false; }
    });
    on('board-unlist-btn', async () => {
        await unlistRoom(getMyUserId());
        listed = false;
        byId<HTMLElement>('board-unlist-btn').classList.add('hidden');
        byId<HTMLButtonElement>('board-list-btn').textContent = 'List this room';
        byId<HTMLElement>('board-status').textContent = 'Removed from the board. People already here stay.';
    });

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
        });
    });

    // Leaving
    on('leave-btn', () => openModal('leave-modal'));
    document.querySelector<HTMLElement>('.app-header .brand')!.addEventListener('click', event => { event.preventDefault(); openModal('leave-modal'); });
    on('cancel-leave-btn', closeModal);
    on<HTMLButtonElement>('confirm-leave-btn', async event => {
        if (leaving) return;
        leaving = true;
        event.currentTarget.disabled = true;
        cleanupMedia();
        stopSound();
        const goodbye = [disconnectSocket(), listed ? unlistRoom(getMyUserId()) : null];
        try { await Promise.race([Promise.allSettled(goodbye), new Promise(resolve => setTimeout(resolve, 1500))]); }
        finally { window.location.replace('/room.html'); }
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
    const user = getStoredUser();
    if (!user) return signOutLocally();
    // Supabase reports SIGNED_OUT when a refresh token can no longer be renewed.
    supabase.auth.onAuthStateChange(event => { if (event === 'SIGNED_OUT') signOutLocally(); });

    initDialogs();
    initAudio();
    bindThemePicker(byId<HTMLSelectElement>('theme-picker'));
    bindRoomControls();

    roomCodeInput.value = new URLSearchParams(location.search).get('room') || sessionStorage.getItem('flow_last_room') || '';
    on('join-btn', joinRoom);
    on('host-btn', createRoom);
    [roomCodeInput, pinInput].forEach(input => input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); joinRoom(); }
    }));
    on('logout-link', async event => {
        event.preventDefault();
        try { await supabase.auth.signOut(); } catch { /* Clear the local login even when offline. */ }
        signOutLocally();
    });

    window.addEventListener('offline', () => connectionStatus('OFFLINE'));
    window.addEventListener('online', () => connectionStatus('CONNECTING'));
    connectionStatus('CONNECTING');
    // Drop from presence at once when the tab closes or reloads.
    window.addEventListener('beforeunload', () => { cleanupMedia(); disconnectSocket(); });

    await firstRunName(user.id);
    setRoomBusy(false);

    // Arriving from the study-groups board: either to host a new group, or with a seat already taken.
    // Both are one-time notes left by the board page in this tab. A URL alone never joins a room:
    // an invite link only fills in the code, and the person still presses Join.
    const hosting = sessionStorage.getItem('flow_host');
    const seat = sessionStorage.getItem('flow_join');
    sessionStorage.removeItem('flow_host');
    sessionStorage.removeItem('flow_join');
    if (hosting) {
        const { topic, seats } = JSON.parse(hosting);
        roomCodeInput.value = pinInput.value = '';
        await createRoom();
        if (currentRoomId && typeof topic === 'string') {
            byId<HTMLInputElement>('board-topic').value = topic;
            byId<HTMLSelectElement>('board-seats').value = String(seats);
            await listOnBoard(topic, Math.min(6, Math.max(2, Number(seats) || 4)));
        }
    } else if (seat && /^[A-Z0-9]{6}$/.test(seat)) {
        roomCodeInput.value = seat;
        await joinRoom();
    }
}

start().catch(() => showLobbyError('Flow could not start. Refresh this page to try again.'));
