// The study-groups board: rooms open right now, and groups planned for later.
// Requires sql/005 and sql/006.
import type { GroupDetails, OpenRoom, PlannedGroup } from '../types';
import { getSupabase } from './supabase';

export * from './board-options';

// room_id is not readable by design (see sql/005), so it is never selected.
const OPEN = 'id, host_id, host_name, topic, subject, camera, vibe, seats, seats_taken, closed, timer_mode, timer_ends_at, last_seen, away_until, acting_name';
const PLANNED = 'id, host_id, host_name, topic, subject, camera, vibe, seats, starts_at, going';

// A listing is live while its host's room checks in (every 45 s), or while its
// host has stepped away (sql/012). The database stops handing out seats after
// that, but still shows a host their own expired listing, so those go here too.
const LIVE_FOR_MS = 2 * 60 * 1000;
export const isLive = (room: Pick<OpenRoom, 'last_seen' | 'away_until'>, now = Date.now()) =>
    now - new Date(room.last_seen).getTime() < LIVE_FOR_MS || (!!room.away_until && new Date(room.away_until).getTime() > now);

// Who is hosting, for the board: the host, someone standing in, or nobody yet.
export const hostedBy = (room: Pick<OpenRoom, 'host_name' | 'away_until' | 'acting_name'>) =>
    room.acting_name ? `Hosted by ${room.acting_name} for now` : room.away_until ? `${room.host_name} stepped away` : `Hosted by ${room.host_name}`;

export async function fetchOpenRooms(): Promise<OpenRoom[]> {
    const { data, error } = await getSupabase().from('open_rooms').select(OPEN).order('last_seen', { ascending: false }).limit(60);
    if (error) throw error;
    const rooms = data ?? [];
    // Your own expired listing (you left, or the tab closed): take it off the board.
    const { data: session } = await getSupabase().auth.getSession();
    const me = session.session?.user?.id;
    if (me && rooms.some(room => room.host_id === me && !isLive(room))) unlistRoom(me).then(undefined, () => {});
    return rooms.filter(room => isLive(room));
}

export async function fetchPlanned(): Promise<PlannedGroup[]> {
    const { data, error } = await getSupabase().from('planned_groups').select(PLANNED).order('starts_at', { ascending: true }).limit(60);
    if (error) throw error;
    return data ?? [];
}

// Ids of the planned groups the signed-in user has said they're in for.
export async function fetchMyPlans(): Promise<Set<string>> {
    const { data } = await getSupabase().from('planned_group_members').select('group_id');
    return new Set((data ?? []).map(row => row.group_id));
}

export const planGroup = async (plan: GroupDetails & { host_id: string; starts_at: string }) =>
    !(await getSupabase().from('planned_groups').insert(plan)).error;
export const cancelPlan = (id: string) => getSupabase().from('planned_groups').delete().eq('id', id);
export const setGoing = (groupId: string, userId: string, going: boolean) => going
    ? getSupabase().from('planned_group_members').insert({ group_id: groupId })
    : getSupabase().from('planned_group_members').delete().eq('group_id', groupId).eq('user_id', userId);

export const report = async (kind: 'open' | 'planned', target: string, topic: string) =>
    !(await getSupabase().from('reports').insert({ kind, target, topic, reason: null })).error;

// One listing per host; listing again replaces the previous one.
// Deliberately delete-then-insert, not upsert: an upsert has to read the columns
// it overwrites, and room_id is not readable by anyone (see sql/005), so the
// database refuses it. A plain insert only needs permission to write.
export async function listRoom(listing: GroupDetails & { host_id: string; room_id: string; seats_taken: number; closed: boolean; timer_mode: string | null; timer_ends_at: string | null }) {
    await getSupabase().from('open_rooms').delete().eq('host_id', listing.host_id);
    const { error } = await getSupabase().from('open_rooms').insert(listing);
    if (error) console.error('Listing failed:', error.message);
    return error ? (error.message.includes('row-level security') ? 'locked' : 'failed') : 'listed';
}

// Called on a timer while the host is in the room: who is here, and what the
// clock is doing. The database stamps last_seen itself, and a listing nobody
// refreshes drops off the board after two minutes.
export const refreshListing = (hostId: string, live: { seats_taken: number; timer_mode: string | null; timer_ends_at: string | null; host_name?: string }) =>
    getSupabase().from('open_rooms').update(live).eq('host_id', hostId);
export const setClosed = (hostId: string, closed: boolean) => getSupabase().from('open_rooms').update({ closed }).eq('host_id', hostId);
export function unlistRoom(hostId: string) { return getSupabase().from('open_rooms').delete().eq('host_id', hostId); }

// Returns the room's code, or says why there is no seat.
export async function takeSeat(listingId: string): Promise<{ code: string } | { reason: string }> {
    const { data, error } = await getSupabase().rpc('join_open_room', { p_listing: listingId });
    if (data) return { code: data };
    const message = error?.message ?? '';
    return { reason: message.includes('full') ? 'This group just filled up.' : message.includes('not found') ? 'This group has just closed.' : message.includes('Removed') ? 'The host removed you from this group.' : 'Could not join this group. Check your connection and try again.' };
}

// What a room is doing right now, in a few words.
export function statusOf(room: Pick<OpenRoom, 'timer_mode' | 'timer_ends_at'>, now = Date.now()) {
    if (!room.timer_mode) return 'Just opened';
    const minutes = room.timer_ends_at ? Math.ceil((new Date(room.timer_ends_at).getTime() - now) / 60000) : 0;
    const focus = room.timer_mode === 'focus';
    if (minutes <= 0) return focus ? 'Between focus blocks' : 'On a break';
    return `${focus ? 'Focusing' : 'On a break'}, ${minutes} min left`;
}

// Calls back whenever a listing or plan changes, so open boards stay current without polling.
// The database pings the private "board" channel whenever a listing or plan
// changes (sql/010), and the page fetches the board again. Pings arrive in
// bursts, so they are gathered for a moment. The database sends at most two a
// second, so a second look a second later catches a change that was held back.
export function watchBoard(onChange: () => void) {
    let soon: ReturnType<typeof setTimeout> | undefined, again: ReturnType<typeof setTimeout> | undefined;
    return getSupabase().channel('board', { config: { private: true } })
        .on('broadcast', { event: 'changed' }, () => {
            clearTimeout(soon); clearTimeout(again);
            soon = setTimeout(onChange, 400);
            again = setTimeout(onChange, 1400);
        })
        .subscribe(() => {});
}
