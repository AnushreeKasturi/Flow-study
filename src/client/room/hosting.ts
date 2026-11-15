// Hosting: the room's listing on the study-groups board, who hosts (and who stands in
// while the host steps away, sql/012), the leave dialog, and removing someone.
import type { GroupDetails } from '../types';
import { byId, on } from '../dom';
import { leaveWithLoader } from '../loader';
import { resolveHost, hostChangeNote, type HostState } from '../modules/host-state';
import { listRoom, refreshListing, unlistRoom, setClosed } from '../modules/board';
import { notify, openModal, closeModal } from '../modules/feedback';
import { pushNote } from '../modules/notifications';
import { cleanupMedia } from '../modules/rtc';
import { currentUser } from '../modules/session';
import { disconnectSocket, getMyUserId, sendRemoved } from '../modules/socket';
import { stopSound } from '../modules/soundscape';
import { setHost } from '../modules/stage';
import supabase from '../modules/supabase';
import { saveFocus, timerSnapshot, setRunsTimer } from '../modules/timer';
import { markListed } from './hide-ip';
import { here, partners, pendingLeaves, peopleHere } from './state';

export async function listOnBoard(details: Omit<GroupDetails, 'host_name'>) {
    const status = byId<HTMLElement>('board-status');
    const result = await listRoom({
        ...details, host_id: getMyUserId(), room_id: here.id, host_name: here.username.slice(0, 40),
        seats_taken: peopleHere(), closed: byId<HTMLInputElement>('board-closed').checked, ...timerSnapshot()
    });
    here.listed = result === 'listed';
    if (here.listed) markListed(); // now on the board: strangers may join
    status.textContent = here.listed ? `Listed as “${details.topic}” with ${details.seats} seats. It comes off the board when you leave.`
        : result === 'locked' ? 'This room can’t go on the board. Only the person who created it can list it, and not if it has a PIN.'
        : 'The room could not be here.listed just now. Check your connection and try again.';
    if (!here.listed) notify(status.textContent, 'error');
    byId<HTMLElement>('board-unlist-btn').classList.toggle('hidden', !here.listed);
    byId<HTMLElement>('board-closed-row').classList.toggle('hidden', !here.listed);
    byId<HTMLButtonElement>('board-list-btn').textContent = here.listed ? 'Update listing' : 'List this room';
    if (here.listed) notify('Your room is on the study-groups board.');
    return here.listed;
}
export const boardForm = () => ({
    topic: byId<HTMLInputElement>('board-topic').value.trim(), seats: Number(byId<HTMLSelectElement>('board-seats').value),
    subject: byId<HTMLSelectElement>('board-subject').value, camera: byId<HTMLSelectElement>('board-camera').value, vibe: byId<HTMLSelectElement>('board-vibe').value
});
// While listed, tell the board who is here and what the clock is doing. A
// listing nobody refreshes disappears from the board within two minutes.
// Timer changes arrive in bursts; one refresh shortly after the last is enough.
let boardSoon: ReturnType<typeof setTimeout> | undefined;
export const refreshBoardSoon = () => { clearTimeout(boardSoon); boardSoon = setTimeout(refreshBoard, 2000); };
export const refreshBoard = () => {
    if (here.listed) refreshListing(getMyUserId(), { seats_taken: peopleHere(), host_name: here.username.slice(0, 40), ...timerSnapshot() }).then(undefined, () => {});
    if (!here.id || !here.hostAway) return;
    // The host stepped away. Whoever stands in checks in for the room (their seat stays
    // counted); if nobody does, or the stand-in has gone quiet, the database lets us take over.
    if (here.isActing) {
        const { timer_mode, timer_ends_at } = timerSnapshot();
        supabase.rpc('room_checkin', { p_room: here.id, p_seats_taken: peopleHere() + 1, p_timer_mode: timer_mode, p_timer_ends_at: timer_ends_at })
            .then(({ data }) => { if (data === false) syncHost(); }, () => {});
    } else if (!here.hostId || !partners[here.hostId]) claimHost();
};
setInterval(refreshBoard, 45000);


// ── Who hosts ──────────────────────────────────────────────────────────────

// One place that decides who the host is, for the tiles, the remove buttons, and the leave dialog.
// While the host is away, whoever stands in is shown as host, but cannot remove people,
// hand the room on, or end it: those stay with the person who made it.
function applyHost(state: HostState) {
    Object.assign(here, { hostId: state.hostId, hostAway: state.hostAway, isHost: state.isHost, isActing: state.isActing });
    document.body.classList.toggle('is-host', here.isHost);
    setHost(here.hostId);
    applyTimerControl();
}

// The timer belongs to whoever hosts right now. Everyone else sees the controls, dimmed,
// with a note saying who runs it.
const TIMER_CONTROLS = '#timer-toggle-btn, #timer-reset-btn, .timer-modes .mode-btn, #setting-focus-duration, #setting-short-break-duration, #setting-long-break-duration, #setting-auto-advance';
export function applyTimerControl() {
    const runs = here.isHost || here.isActing;
    setRunsTimer(runs);
    document.body.classList.toggle('runs-timer', runs);
    document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(TIMER_CONTROLS).forEach(control => { control.disabled = !runs; });
    const host = partners[here.hostId]?.username;
    byId<HTMLElement>('timer-runner').textContent = runs ? '' : here.hostId ? `${host || 'The host'} runs the timer.` : 'The host runs the timer.';
}

// Reads who hosts from the database, the only source trusted, and says what changed.
// `name` comes with the room's message about the change, for the note.
export async function syncHost(name = '', announce = true) {
    const room = () => supabase.from('rooms').select('created_by, host_away, acting_host').eq('room_code', here.code).maybeSingle();
    let { data, error } = await room();
    // Before sql/012 there is no stepping away; fall back to whoever created the room.
    if (error) ({ data } = await supabase.from('rooms').select('created_by').eq('room_code', here.code).maybeSingle());
    const before: HostState = { hostId: here.hostId, hostAway: here.hostAway, isHost: here.isHost, isActing: here.isActing };
    applyHost(resolveHost(data, currentUser()?.id));
    if (here.hostAway && !here.hostId) claimHost(); // nobody is hosting: offer to
    const change = announce ? hostChangeNote(before, { hostId: here.hostId, hostAway: here.hostAway, isHost: here.isHost, isActing: here.isActing }, name || partners[here.hostId]?.username || 'Someone') : null;
    if (!change) return;
    pushNote(change.note);
    if (change.toast) notify(change.toast);
    if (change.becameHost) adoptListing();
    if (!here.isHost && !here.isActing) here.listed = false; // the listing, if any, is the host's
}

// Only one person stands in at a time; the database decides who.
async function claimHost() {
    const { data } = await supabase.rpc('claim_host', { p_room: here.id });
    if (data === true && !here.isActing) await syncHost();
}

// If this room is on the board under our name, keep its listing checked in.
export async function adoptListing() {
    const { data: ours } = await supabase.rpc('lists_room', { p_room: here.id });
    if (ours !== true) return;
    const { data: listing } = await supabase.from('open_rooms').select('topic, subject, camera, vibe, seats, closed').eq('host_id', getMyUserId()).maybeSingle();
    if (!listing) return;
    here.listed = true;
    byId<HTMLInputElement>('board-topic').value = listing.topic;
    for (const [id, value] of [['board-seats', String(listing.seats)], ['board-subject', listing.subject], ['board-camera', listing.camera], ['board-vibe', listing.vibe]]) byId<HTMLSelectElement>(id).value = value;
    byId<HTMLInputElement>('board-closed').checked = listing.closed;
    byId<HTMLElement>('board-unlist-btn').classList.remove('hidden');
    byId<HTMLElement>('board-closed-row').classList.remove('hidden');
    byId<HTMLButtonElement>('board-list-btn').textContent = 'Update listing';
    refreshBoard();
}

// The host ended the room. Leave quietly, with a calm note on Home.
export async function roomEnded() {
    const { error } = await supabase.rpc('join_room', { p_room_code: here.code, p_pin: here.pin });
    if (!error?.message?.includes('Room ended') || here.leaving) return;
    here.leaving = true;
    sessionStorage.setItem('flow_recap', 'The host ended the room. Your focus time from it is saved.');
    sessionStorage.removeItem('flow_last_room');
    await Promise.race([Promise.allSettled([saveFocus('focus-partial'), disconnectSocket()]), new Promise(resolve => setTimeout(resolve, 1500))]);
    cleanupMedia();
    stopSound();
    leaveWithLoader('/room.html', 'The host ended the room', true);
}

// The leave dialog says plainly what happens to the room.
const LEAVE_TEXT = 'Your camera and microphone will disconnect. You can rejoin with the room code; saved shared tasks stay in the room.';
export function prepareLeave() {
    const others = Object.entries(partners).filter(([id]) => !(id in pendingLeaves));
    byId<HTMLElement>('leave-text').textContent = here.isActing
        ? 'You’re hosting for now. When you leave, the next person here takes over until the host is back.' : LEAVE_TEXT;
    byId<HTMLElement>('leave-host').classList.toggle('hidden', !here.isHost);
    if (!here.isHost) return updateLeaveButton();
    const select = byId<HTMLSelectElement>('leave-new-host');
    select.replaceChildren(...others.map(([id, partner]) => Object.assign(document.createElement('option'), { value: id, textContent: partner.username || 'Partner' })));
    byId<HTMLElement>('leave-handover-row').classList.toggle('hidden', !others.length);
    const board = here.listed ? ' and on the board' : '';
    byId<HTMLElement>('leave-away-text').textContent = (others.length
        ? `The room stays open${board}. Someone here hosts for now`
        : `The room stays open${board}. The next person to join hosts for now`) + ', and the role comes back to you when you return.';
    byId<HTMLElement>('leave-end-text').textContent = `Closes the room for good: ${others.length ? 'everyone here is sent Home, ' : ''}the code stops working${here.listed ? ', and it comes off the board' : ''}. Tasks and focus time are kept.`;
    document.querySelector<HTMLInputElement>('input[name="leave-choice"][value="away"]')!.checked = true;
    updateLeaveButton();
}
export function updateLeaveButton() {
    const choice = here.isHost ? document.querySelector<HTMLInputElement>('input[name="leave-choice"]:checked')?.value : 'leave';
    byId<HTMLButtonElement>('confirm-leave-btn').textContent = choice === 'handover' ? 'Hand over and leave' : choice === 'end' ? 'End room for everyone' : choice === 'away' ? 'Step away' : 'Leave room';
}

// ── Host controls ──────────────────────────────────────────────────────────

let removing = '';
function askToRemove(userId: string) {
    if (!here.isHost || !partners[userId]) return;
    removing = userId;
    byId<HTMLElement>('remove-title').textContent = `Remove ${partners[userId].username || 'this person'}?`;
    openModal('remove-modal');
}
async function removeFromRoom() {
    const userId = removing;
    closeModal();
    const { error } = await supabase.rpc('remove_participant', { p_room: here.id, p_user: userId });
    if (error) { notify('They could not be removed. Only the person who created the room can do this.', 'error'); return; }
    // The database has already shut them out; this tells their browser to leave now.
    sendRemoved(userId);
    notify(`${partners[userId]?.username || 'They'} was removed from the room.`);
    refreshBoard();
}
// Anyone could send a "removed" message, so it is only a hint. The database
// decides: if it still lets us in, the message was not real and is ignored.
export async function confirmRemoval() {
    const { error } = await supabase.rpc('join_room', { p_room_code: here.code, p_pin: here.pin });
    if (!error?.message?.includes('Removed')) return;
    here.leaving = true;
    cleanupMedia();
    stopSound();
    sessionStorage.removeItem('flow_last_room');
    sessionStorage.setItem('flow_notice', 'The host removed you from that room.');
    await Promise.race([disconnectSocket(), new Promise(resolve => setTimeout(resolve, 1000))]);
    leaveWithLoader('/room.html', 'Back to your space…', true);
}



// The board panel in the invite dialog, and the remove-someone dialog.
export function bindHosting() {
    byId<HTMLFormElement>('board-form').addEventListener('submit', async event => {
        event.preventDefault();
        const button = byId<HTMLButtonElement>('board-list-btn');
        button.disabled = true;
        try { await listOnBoard(boardForm()); }
        finally { button.disabled = false; }
    });
    on('board-unlist-btn', async () => {
        await unlistRoom(getMyUserId());
        here.listed = false;
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
}
