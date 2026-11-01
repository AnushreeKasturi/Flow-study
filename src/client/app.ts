import { enterPage, reveal } from './motion';
import type { Participants, ProfileStats, TimerMode } from './types';
import { byId } from './dom';
import { initSocket, disconnectSocket, reloadTasks, getMyUserId, updateCameraState, updateMyUsername, sendReaction, sendHandRaise } from './modules/socket';
import { initMedia, toggleAudio, toggleVideo, handleSignal, removePeer, callUser, hasPeer, peerNeedsCall, cleanupMedia, isVideoActive, hasAudioTrack } from './modules/rtc';
import { initTimer, toggleTimer, resetTimer, setMode, syncState, setTimerSettings, broadcastCurrentState } from './modules/timer';
import { initTasks, addTask, toggleTask, deleteTask, assignTask, rerenderTasks, getStats as getTaskStats, setSharedTasks } from './modules/tasks';
import { initPresence, updatePresence, startFocusTracking, stopFocusTracking, formatFocusTime } from './modules/presence';
import { initChat, handleIncomingMessage } from './modules/chat';
import { getMyProfile, saveDisplayName, getStats as getProfileStats, withLiveFocus } from './modules/profile';
import * as UI from './modules/ui';
import supabase from './modules/supabase';
import { initAudio, loadRoomAudio } from './modules/audio';
import { notify, openModal, closeModal, initDialogs } from './modules/feedback';
import { escapeHTML, getStoredUser } from './modules/utils';

let currentRoomId = null;
let currentUsername = '';
let partners: Participants = {}; // Store partner data
let handRaised = false;
let roomActionBusy = false;
let leaving = false;
let cachedProfileStats: ProfileStats | null = null;
const hostBtn = byId<HTMLButtonElement>('host-btn');
const lobbyError = byId<HTMLElement>('lobby-error');
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

// A participant's realtime channel can drop and reconnect on its own (network
// blips, provider-side connection churn) — from CLOSED to fully resubscribed
// takes a 3s retry delay plus round-trip time, occasionally more. Debouncing
// the leave past that window lets a rejoin cancel the teardown instead of
// tearing down and rebuilding the peer connection and video tile for a blip
// that was never a real leave.
const pendingLeaves: Record<string, ReturnType<typeof setTimeout>> = {};
const LEAVE_GRACE_MS = 18000;

// Mic/camera toggle icons, swapped in on click so the button's on/off state
// is unmistakable at a glance instead of relying on a subtle background
// color change alone.
const MIC_ON_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
const MIC_OFF_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>';
const CAM_ON_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>';
const CAM_OFF_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

// Modals
const joinBtn = byId<HTMLButtonElement>('join-btn');
const roomCodeInput = byId<HTMLInputElement>('room-code-input');
const appContainer = byId<HTMLElement>('app');

// Video Container
const videoGrid = byId<HTMLElement>('video-grid');

// Excludes visually ambiguous characters (0/O, 1/I/L) so codes shared verbally
// or by text can't be mistyped into a different valid-looking code.
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const generateRoomCode = () => {
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    return code;
};

const initApp = async () => {
    const user = getStoredUser();
    if (!user) {
        localStorage.removeItem('flow_user');
        window.location.replace('/login.html');
        return;
    }
    initDialogs();
    initAudio();

    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room') || sessionStorage.getItem('flow_last_room');
    if (roomParam) {
        roomCodeInput.value = roomParam;
    }

    joinBtn.addEventListener('click', handleJoin);

    [roomCodeInput, byId<HTMLInputElement>('room-pin-input')].forEach(input => {
        input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); handleJoin(); }
        });
    });
    hostBtn.addEventListener('click', async () => {
        if (roomActionBusy) return;
        const pin = byId<HTMLInputElement>('room-pin-input').value.trim();
        if (pin && !/^\d{4}$/.test(pin)) { showLobbyError('Use a 4-digit PIN, or leave it empty.'); return; }
        setRoomBusy(true, 'host');
        lobbyError.classList.add('hidden');
        let createdCode;
        try {
            if (!supabase) throw new Error('Connection unavailable');
            for (let attempt = 0; attempt < 5; attempt++) {
                const code = generateRoomCode();
                const { data, error } = await supabase.from('rooms').select('id').eq('room_code', code).limit(1);
                if (error) throw error;
                if (data?.length) continue;
                const result = await supabase.from('rooms').insert([{ room_code: code, is_locked: !!pin, pin: pin || null }]);
                if (result.error?.code === '23505') continue;
                if (result.error) throw result.error;
                createdCode = code;
                break;
            }
            if (!createdCode) throw new Error('No available room code');
        } catch {
            showLobbyError('The room could not be created. Check your connection and try again.');
        } finally {
            setRoomBusy(false);
        }
        if (createdCode) { roomCodeInput.value = createdCode; await handleJoin(); }
    });
    byId<HTMLElement>('logout-link').addEventListener('click', async e => {
        e.preventDefault();
        try { await supabase?.auth.signOut(); } catch { /* Clear the local login even when offline. */ }
        localStorage.removeItem('flow_user');
        sessionStorage.removeItem('flow_last_room');
        window.location.replace('/login.html');
    });
    byId<HTMLButtonElement>('toggle-mic').addEventListener('click', (e) => {
        const enabled = toggleAudio();
        if (enabled === null) {
            notify('No microphone is available. Check your browser permissions, then rejoin.', 'error');
            return;
        }
        (e.currentTarget as HTMLButtonElement).classList.toggle('active', enabled);
        (e.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(enabled));
        (e.currentTarget as HTMLButtonElement).innerHTML = enabled ? MIC_ON_ICON : MIC_OFF_ICON;
    });

    byId<HTMLButtonElement>('toggle-cam').addEventListener('click', (e) => {
        const isEnabled = toggleVideo();
        (e.currentTarget as HTMLButtonElement).classList.toggle('active', isEnabled);
        (e.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(isEnabled));
        (e.currentTarget as HTMLButtonElement).innerHTML = isEnabled ? CAM_ON_ICON : CAM_OFF_ICON;

        const localDummy = byId<HTMLElement>('local-dummy-placeholder');
        if (!isEnabled) {
            localDummy.classList.remove('hidden');
            byId<HTMLElement>('local-dummy-avatar').innerText = currentUsername.charAt(0).toUpperCase();
            localDummy.querySelector<HTMLElement>('.text')!.innerText = 'Camera Off';
        } else {
            localDummy.classList.add('hidden');
        }

        updateCameraState(isEnabled);
    });

    // Reactions & Raise Hand
    document.querySelectorAll<HTMLButtonElement>('.reaction-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
            const emoji = btn.dataset.emoji;
            if (!emoji) return;
            sendReaction(emoji);
            showReaction(getMyUserId(), emoji); // no self-broadcast echo, so render locally too
        });
    });

    byId<HTMLElement>('toggle-hand').addEventListener('click', (e) => {
        handRaised = !handRaised;
        (e.currentTarget as HTMLButtonElement).classList.toggle('active', handRaised);
        (e.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(handRaised));
        sendHandRaise(handRaised);
        setHandRaised(getMyUserId(), handRaised);
    });

    // Timer Controls
    UI.UI.timerToggleBtn.addEventListener('click', () => {
        toggleTimer();
    });

    byId<HTMLButtonElement>('timer-reset-btn').addEventListener('click', () => {
        resetTimer();
    });

    byId<HTMLElement>('focus-mode-toggle').addEventListener('click', (e) => {
        document.body.classList.toggle('focus-active');
        (e.currentTarget as HTMLButtonElement).classList.toggle('active', document.body.classList.contains('focus-active'));
        (e.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(document.body.classList.contains('focus-active')));
    });

    UI.UI.timerModes.forEach(btn => {
        btn.addEventListener('click', (e) => {
            setMode((e.target as HTMLButtonElement).dataset.mode as TimerMode);
        });
    });

    // Timer Settings Modal
    byId<HTMLButtonElement>('open-timer-settings-btn').addEventListener('click', () => {
        openModal('timer-settings-modal');
    });

    byId<HTMLButtonElement>('close-timer-settings-btn').addEventListener('click', () => {
        closeModal();
    });

    byId<HTMLButtonElement>('save-timer-settings-btn').addEventListener('click', () => {
        const inputs = ['setting-focus-duration', 'setting-short-break-duration', 'setting-long-break-duration'].map(id => byId<HTMLInputElement>(id));
        if (!inputs.every(input => input.reportValidity())) return;
        const [focus, shortBreak, longBreak] = inputs.map(input => Number(input.value));

        setTimerSettings({
            focus: focus * 60,
            shortBreak: shortBreak * 60,
            longBreak: longBreak * 60
        });

        closeModal();
    });

    // Profile Modal
    const profileCard = byId<HTMLElement>('my-presence-card');
    profileCard.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            profileCard.click();
        }
    });
    profileCard.addEventListener('click', async () => {
        openModal('profile-modal');

        byId<HTMLInputElement>('profile-display-name-input').value = currentUsername || '';
        byId<HTMLElement>('profile-avatar').textContent = currentUsername.charAt(0).toUpperCase();
        const statsEl = byId<HTMLElement>('profile-stats');
        cachedProfileStats = null;
        statsEl.innerHTML = '<div style="color: var(--text-muted);">Loading…</div>';

        try {
            const stats = await getProfileStats(getMyUserId());
            cachedProfileStats = stats;
            renderProfileStats(withLiveFocus(stats));
        } catch {
            statsEl.textContent = 'Stats are unavailable right now. Close and reopen your profile to retry.';
        }
    });

    document.addEventListener('focus-progress', () => {
        if (cachedProfileStats && !byId<HTMLElement>('profile-modal').classList.contains('hidden')) renderProfileStats(withLiveFocus(cachedProfileStats));
    });
    document.addEventListener('session-completed', async () => {
        cachedProfileStats = null;
        if (byId<HTMLElement>('profile-modal').classList.contains('hidden')) return;
        try {
            cachedProfileStats = await getProfileStats(getMyUserId());
            renderProfileStats(withLiveFocus(cachedProfileStats));
        } catch { notify('Your focus summary could not be refreshed. Reopen it to retry.', 'error'); }
    });
    byId<HTMLButtonElement>('close-profile-btn').addEventListener('click', () => {
        closeModal();
    });

    byId<HTMLButtonElement>('save-profile-name-btn').addEventListener('click', async () => {
        const input = byId<HTMLInputElement>('profile-display-name-input');
        const newName = input.value.trim();
        if (!newName || newName.length > 40) { input.reportValidity(); return; }

        const btn = byId<HTMLButtonElement>('save-profile-name-btn');
        const originalText = btn.innerText;
        btn.innerText = 'Saving...';
        btn.disabled = true;

        const ok = await saveDisplayName(getMyUserId(), newName);

        btn.innerText = originalText;
        btn.disabled = false;

        if (!ok) {
            notify('Your name could not be saved. Please try again.', 'error');
            return;
        }

        currentUsername = newName;
        updateMyUsername(newName);
        updatePresence({});
        UI.updateMyPresenceUI({ status: UI.UI.myStatusText.textContent }, getTaskStats(), currentUsername);
        byId<HTMLElement>('local-dummy-avatar').textContent = currentUsername.charAt(0).toUpperCase();
        byId<HTMLElement>('profile-avatar').textContent = currentUsername.charAt(0).toUpperCase();
        notify('Display name saved.');
    });

    byId<HTMLButtonElement>('retry-tasks-btn').addEventListener('click', async event => {
        (event.currentTarget as HTMLButtonElement).disabled = true;
        try { await reloadTasks(); }
        finally { byId<HTMLButtonElement>('retry-tasks-btn').disabled = false; }
    });

    // Task Controls
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
    taskInput.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submitTask(); }
    });
    byId<HTMLButtonElement>('share-link-btn').addEventListener('click', async () => {
        const url = new URL(window.location.href);
        url.searchParams.set('room', byId<HTMLElement>('header-room-code').textContent);
        try {
            await navigator.clipboard.writeText(url.toString());
            notify('Invite link copied.');
        } catch {
            byId<HTMLInputElement>('invite-link-input').value = url.toString();
            openModal('invite-modal');
            byId<HTMLInputElement>('invite-link-input').select();
        }
    });

    byId<HTMLButtonElement>('invite-empty-btn').addEventListener('click', () => byId<HTMLButtonElement>('share-link-btn').click());

    // Theming Logic
    const themePicker = byId<HTMLSelectElement>('theme-picker');
    const supportedThemes = new Set(['forest', 'midnight', 'warm', 'aqua', 'amethyst']);
    const savedTheme = localStorage.getItem('flow_theme') || 'forest';
    const activeTheme = supportedThemes.has(savedTheme) ? savedTheme : 'forest';
    document.documentElement.setAttribute('data-theme', activeTheme);
    themePicker.value = activeTheme;

    themePicker.addEventListener('change', (e) => {
        const theme = (e.target as HTMLSelectElement).value;
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('flow_theme', theme);
    });



    byId<HTMLButtonElement>('leave-btn').addEventListener('click', () => openModal('leave-modal'));
    document.querySelector<HTMLElement>('.app-header .brand')!.addEventListener('click', e => { e.preventDefault(); openModal('leave-modal'); });
    byId<HTMLButtonElement>('cancel-leave-btn').addEventListener('click', closeModal);
    byId<HTMLButtonElement>('close-invite-btn').addEventListener('click', closeModal);
    byId<HTMLButtonElement>('confirm-leave-btn').addEventListener('click', async () => {
        if (leaving) return;
        leaving = true;
        byId<HTMLButtonElement>('confirm-leave-btn').disabled = true;
        cleanupMedia();
        try {
            await Promise.race([disconnectSocket(), new Promise(resolve => setTimeout(resolve, 1500))]);
        } finally {
            window.location.replace('/');
        }
    });
    window.addEventListener('offline', () => connectionStatus('OFFLINE'));
    window.addEventListener('online', () => connectionStatus('CONNECTING'));
    connectionStatus('CONNECTING');

    // Tab Logic
    const tabBtns = document.querySelectorAll<HTMLButtonElement>('.tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('keydown', (e) => {
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                e.preventDefault();
                const next = e.key === 'Home' ? tabBtns[0] : e.key === 'End' ? tabBtns[tabBtns.length - 1] : [...tabBtns].find(b => b !== btn);
                next?.click();
                next?.focus();
            }
        });
        btn.addEventListener('click', (e) => {
            tabBtns.forEach(b => {
                b.classList.remove('active');
                b.setAttribute('aria-selected', 'false');
                b.tabIndex = -1;
            });
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

            (e.target as HTMLElement).classList.add('active');
            (e.target as HTMLElement).setAttribute('aria-selected', 'true');
            (e.target as HTMLElement).tabIndex = 0;
            byId((e.target as HTMLButtonElement).dataset.tab!).classList.add('active');
            reveal(byId((e.target as HTMLButtonElement).dataset.tab!));
        });
    });

    // Instantly drop from presence when tab is closed or refreshed
    window.addEventListener('beforeunload', () => {
        cleanupMedia();
        disconnectSocket();
    });

    setRoomBusy(false);
    enterPage();
};

const renderProfileStats = (stats: ProfileStats) => {
    const markup = '<div class="focus-summary"><span>Focused today</span><strong id="profile-today-value">' + formatFocusTime(stats.todayMinutes) + '</strong><p>' + (stats.liveMinutes ? 'Includes ' + stats.liveMinutes + ' live minute' + (stats.liveMinutes === 1 ? '' : 's') + ' from this visit.' : 'Your focus time, one session at a time.') + '</p></div>' +
        '<dl class="profile-stat-list">' + [
            ['All-time focus', formatFocusTime(stats.totalMinutes)],
            ['Current streak', stats.streak + ' day' + (stats.streak === 1 ? '' : 's')],
            ['Completed sessions', stats.sessionsCompleted], ['Completed tasks', stats.tasksCompleted]
        ].map(([label, value]) => '<div><dt>' + label + '</dt><dd>' + value + '</dd></div>').join('') + '</dl>';
    const container = byId<HTMLElement>('profile-stats');
    if (container.innerHTML !== markup) container.innerHTML = markup;
};

// Everyone currently in the room, keyed by user id, for the task
// assignee picker — includes yourself alongside partners.js's tracked list.
const getRoomParticipants = () => ({
    [getMyUserId() || '']: { username: currentUsername },
    ...partners
});

const handleJoin = async () => {
    if (roomActionBusy) return;
    const roomCode = roomCodeInput.value.trim().toUpperCase();
    const pin = byId<HTMLInputElement>('room-pin-input').value.trim();
    if (!/^[A-Z0-9]{6}$/.test(roomCode)) { showLobbyError('Enter the 6-character code shared by your study group.'); roomCodeInput.focus(); return; }
    if (pin && !/^\d{4}$/.test(pin)) { showLobbyError('Use a 4-digit PIN, or leave it empty.'); return; }
    const userObj = getStoredUser();
    if (!userObj) { window.location.replace('/login.html'); return; }
    const username = userObj.email.split('@')[0];
    setRoomBusy(true);
    lobbyError.classList.add('hidden');
    try {
        if (!supabase) throw new Error('Connection unavailable');
        const { data: roomUuid, error } = await supabase.rpc('join_room', { p_room_code: roomCode, p_pin: pin });
        if (error || !roomUuid) {
            showLobbyError(error?.message?.includes('Incorrect PIN') ? 'This room needs a different PIN. Enter it above and try again.' : error?.message?.includes('Room not found') ? 'Room not found. Check the code and try again.' : 'Could not join this room. Check your connection and try again.');
            return;
        }
        currentRoomId = roomUuid; // currentRoomId is now the UUID

        // A saved display name overrides the email-derived default.
        const profile = await getMyProfile(userObj.id);
        currentUsername = profile?.display_name || username;

        closeModal();
        appContainer.classList.remove('hidden');
        reveal(appContainer, 'room');
        const roomUrl = new URL(window.location.href);
        roomUrl.searchParams.set('room', roomCode);
        history.replaceState(null, '', roomUrl);
        sessionStorage.setItem('flow_last_room', roomCode);

        // Task list becomes visible/clickable here, but tasks.js's roomId isn't
        // set until initTasks() runs much later in this function (after media
        // and socket setup) — adding a task in that window hits a real "room_id
        // violates not-null constraint" error. Disable until initTasks is ready.
        const taskInput = byId<HTMLInputElement>('new-task-input');
        const addTaskBtn = byId<HTMLButtonElement>('add-task-btn');
        taskInput.disabled = true;
        addTaskBtn.disabled = true;

        byId<HTMLElement>('header-room-code').innerText = roomCode; // Still show the code in the UI


        // Initialize Local Media
        const localVideo = byId<HTMLVideoElement>('local-video');
        await initMedia(localVideo);
        if (leaving) return;

        const localDummy = byId<HTMLElement>('local-dummy-placeholder');
        const cameraButton = byId<HTMLButtonElement>('toggle-cam');
        cameraButton.classList.toggle('active', isVideoActive());
        cameraButton.setAttribute('aria-pressed', String(isVideoActive()));
        cameraButton.innerHTML = isVideoActive() ? CAM_ON_ICON : CAM_OFF_ICON;
        if (!isVideoActive()) {
            localDummy.classList.remove('hidden');
            byId<HTMLElement>('local-dummy-avatar').innerText = currentUsername.charAt(0).toUpperCase();
            localDummy.querySelector<HTMLElement>('.text')!.innerText = 'Camera Off';
        }

        // getUserMedia can succeed for video while falling back to no audio at
        // all (mic busy/denied while camera works). There's no track to toggle
        // in that case, so disable the control up front instead of leaving a
        // clickable button that silently does nothing.
        if (!hasAudioTrack()) {
            const micBtn = byId<HTMLButtonElement>('toggle-mic');
            micBtn.classList.remove('active');
            micBtn.innerHTML = MIC_OFF_ICON;
            micBtn.disabled = true;
            micBtn.title = 'No microphone detected';
        }

        // Setup Socket
        initSocket(currentRoomId, currentUsername, !isVideoActive(), {
            onConnectionStatus: connectionStatus,
            onRoomState: (state) => {
                const users = state.participants || {};
                UI.updateRoomInfo(roomCode, Object.keys(users).length);

                // Add/update current partners. Removal is handled exclusively by the
                // presence "leave" event (onUserLeft) below — "sync" fires on every
                // track() call (e.g. every focus-mode/status change), and treating a
                // momentarily-incomplete sync snapshot as "user left" was tearing down
                // healthy WebRTC connections and partner UI for users who never left.
                Object.keys(users).forEach(userId => {
                    if (userId !== getMyUserId()) {
                        if (pendingLeaves[userId]) {
                            clearTimeout(pendingLeaves[userId]);
                            delete pendingLeaves[userId];
                        }
                        partners[userId] = users[userId];
                        updatePartnerUI(userId);
                    }
                });
            },
            onUserJoined: (data) => {
                // If this is just a rejoin from a pending debounced leave, cancel
                // the teardown instead of destroying and recreating the peer
                // connection/video tile.
                if (pendingLeaves[data.userId]) {
                    clearTimeout(pendingLeaves[data.userId]);
                    delete pendingLeaves[data.userId];
                }

                partners[data.userId] = data;
                UI.updateRoomInfo(roomCode, Object.keys(partners).length + 1);
                updatePartnerUI(data.userId);
                rerenderTasks(); // refresh assignee picker options with the new participant
                // Broadcast timer state to the new user
                broadcastCurrentState();
            },
            onUserLeft: (userId: string) => {
                // Don't tear down immediately — a channel rebuild elsewhere in
                // the room looks identical to a genuine leave followed almost
                // instantly by a rejoin. Give it a grace window to resolve
                // itself before destroying the peer connection and video tile.
                if (pendingLeaves[userId]) clearTimeout(pendingLeaves[userId]);
                pendingLeaves[userId] = setTimeout(() => {
                    delete pendingLeaves[userId];
                    delete partners[userId];
                    removePeer(userId);
                    removeRemoteVideo(userId);
                    UI.removePartnerPresenceCard(userId);
                    UI.updateRoomInfo(roomCode, Object.keys(partners).length + 1);
                    rerenderTasks(); // drop the departed participant from the assignee picker
                }, LEAVE_GRACE_MS);
            },
            onPresenceHeartbeat: (data) => {
                // Presence is already tracking this user normally — nothing to heal.
                if (partners[data.userId]) return;

                if (pendingLeaves[data.userId]) {
                    clearTimeout(pendingLeaves[data.userId]);
                    delete pendingLeaves[data.userId];
                }

                partners[data.userId] = data;
                UI.updateRoomInfo(roomCode, Object.keys(partners).length + 1);
                updatePartnerUI(data.userId);
                rerenderTasks(); // refresh assignee picker options with the recovered participant
                broadcastCurrentState();
            },
            onSignal: (data) => {
                handleSignal(data, onRemoteStream);
            },
            onTimerUpdated: timerData => syncState(timerData),
            onTasksError: () => {
                byId<HTMLElement>('task-sync-status').textContent = 'Tasks could not be loaded.';
                byId<HTMLElement>('task-sync-status').classList.remove('hidden');
                byId<HTMLButtonElement>('retry-tasks-btn').classList.remove('hidden');
            },
            onRoomTasksUpdate: (data) => {
                byId<HTMLElement>('task-sync-status').classList.add('hidden');
                byId<HTMLButtonElement>('retry-tasks-btn').classList.add('hidden');
                setSharedTasks(data.tasks);
            },
            onPartnerPresenceUpdate: (data) => {
                if (partners[data.userId]) {
                    partners[data.userId].presence = { status: data.status, nowPlaying: data.nowPlaying };
                    updatePartnerUI(data.userId);
                }
            },
            onChatMessage: (messageData) => {
                handleIncomingMessage(messageData);
            },
            onYouTubeSync: url => loadRoomAudio('youtube', url),
            onAudioSync: loadRoomAudio,
            onReaction: (data) => {
                showReaction(data.userId, data.emoji);
            }
        });

        // Self-healing WebRTC loop: Continuously check if we are missing any connections
        setInterval(() => {
            Object.keys(partners).forEach(userId => {
                if (userId !== getMyUserId() && peerNeedsCall(userId)) {
                    // getOrCreatePeerConnection only builds a fresh RTCPeerConnection
                    // when there's no existing one — a peer stuck 'failed'/'disconnected'
                    // is still "there", so without this it would keep renegotiating on
                    // the same broken connection instead of actually recovering.
                    if (hasPeer(userId)) removePeer(userId);
                    // Only the "smaller" ID initiates the call to prevent double-calling
                    if ((getMyUserId() || '') < userId) {
                        console.log(`[Self-Healing] Missing connection to ${userId}. Initiating call...`);
                        callUser(userId, onRemoteStream);
                    }
                }
            });

        }, 3000);

        // Initialize Modules
        initTimer(currentRoomId, (timerState) => {
            UI.updateTimerUI(timerState);
            if (timerState.isRunning && timerState.mode === 'focus') startFocusTracking();
            else stopFocusTracking(timerState.isRunning ? 'On Break' : 'Online');
        });

        initTasks(currentRoomId, [], (tasks, stats) => {
            UI.renderTaskList(byId<HTMLElement>('room-task-list'), tasks, false, toggleTask, deleteTask, getRoomParticipants(), assignTask);
            UI.updateTaskStatsUI(stats, byId<HTMLElement>('room-task-progress-text'), byId<HTMLElement>('room-task-progress-fill'));

            // Refresh my presence UI when tasks change
            UI.updateMyPresenceUI(getPresenceState(), getTaskStats(), currentUsername);
        });
        taskInput.disabled = false;
        addTaskBtn.disabled = false;

        initPresence(currentRoomId, (presenceState) => {
            UI.updateMyPresenceUI(presenceState, getTaskStats(), currentUsername);
        });

        initChat(currentRoomId, currentUsername);

        // Helper to extract current local presence for UI refresh
        function getPresenceState() {
            return {
                status: UI.UI.myStatusText.innerText
            };
        }
    } catch {
        cleanupMedia();
        disconnectSocket();
        appContainer.classList.add('hidden');
        openModal('join-modal');
        showLobbyError('Could not open the room. Check your connection and try again.');
    } finally {
        setRoomBusy(false);
    }
};

const ensureVideoWrapper = (userId: string) => {
    let videoEl = document.getElementById(`video-${userId}`) as HTMLVideoElement | null;
    if (!videoEl) {
        const wrapper = document.createElement('div');
        wrapper.className = 'video-wrapper fade-in';
        wrapper.id = `video-wrapper-${userId}`;

        videoEl = document.createElement('video');
        videoEl.id = `video-${userId}`;
        videoEl.autoplay = true;
        videoEl.playsInline = true;

        const overlay = document.createElement('div');
        overlay.innerHTML = `
            <span class="name-tag" id="name-tag-${escapeHTML(userId)}">${escapeHTML(partners[userId]?.username || 'Partner')}</span>
            <div class="dummy-placeholder hidden" id="dummy-${escapeHTML(userId)}">
                <div class="avatar" style="width:64px; height:64px; font-size:2rem; border-radius:50%;">${escapeHTML((partners[userId]?.username || '?').charAt(0).toUpperCase())}</div>
                <div class="text">Camera Unavailable</div>
            </div>
        `;

        wrapper.appendChild(videoEl);
        wrapper.appendChild(overlay);
        videoGrid.appendChild(wrapper);
    } else {
        const nameTag = document.getElementById(`name-tag-${userId}`);
        if (nameTag && partners[userId]) {
            nameTag.innerText = partners[userId].username || 'Partner';
        }
    }
    return videoEl;
};

const onRemoteStream = (userId: string, stream: MediaStream) => {
    const videoEl = ensureVideoWrapper(userId);
    if (videoEl.srcObject !== stream) {
        videoEl.srcObject = stream;
    }
    videoEl.play().catch(e => {
        console.error('Remote video play failed:', e);
        // Fallback: mute the video so Safari/Chrome allows autoplay if interaction was lost
        videoEl.muted = true;
        videoEl.play().catch(err => console.error('Even muted autoplay failed', err));
    });
};

const removeRemoteVideo = (userId: string) => {
    const wrapper = document.getElementById(`video-wrapper-${userId}`);
    if (wrapper) wrapper.remove();
};

const getWrapperForUser = (userId: string) =>
    document.getElementById(userId === getMyUserId() ? 'video-wrapper-local' : `video-wrapper-${userId}`);

const showReaction = (userId: string, emoji: string) => {
    const wrapper = getWrapperForUser(userId);
    if (!wrapper) return;

    const el = document.createElement('div');
    el.className = 'floating-reaction';
    el.textContent = emoji;
    wrapper.appendChild(el);
    setTimeout(() => el.remove(), 1800);
};

const setHandRaised = (userId: string, raised: boolean) => {
    const wrapper = getWrapperForUser(userId);
    if (!wrapper) return;

    let badge = wrapper.querySelector('.hand-raised-badge');
    if (raised) {
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'hand-raised-badge';
            badge.textContent = '✋';
            wrapper.appendChild(badge);
        }
    } else if (badge) {
        badge.remove();
    }
};

const updatePartnerUI = (userId: string) => {
    const partner = partners[userId];
    if (!partner) return;

    // Ensure their video box exists (even if their camera is off)
    ensureVideoWrapper(userId);

    // Raised-hand state rides along with presence (survives a channel
    // reconnect) rather than a one-shot broadcast, so it's kept in sync
    // here alongside everything else presence already drives.
    setHandRaised(userId, !!partner.handRaised);

    // Update presence card
    UI.renderPartnerPresenceCard(userId, partner);

    // Dummy UI
    const dummyEl = document.getElementById(`dummy-${userId}`);
    if (dummyEl) {
        if (partner.isDummyMedia) {
            dummyEl.classList.remove('hidden');
        } else {
            dummyEl.classList.add('hidden');
        }
    }
};

// Start
initApp().catch(() => {
    showLobbyError('Flow could not start. Refresh this page to try again.');
});
