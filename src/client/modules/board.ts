// The study-groups board: rooms their hosts have opened to anyone signed in.
// Requires sql/005_open_rooms_and_limits.sql.
import type { OpenRoom } from '../types';
import { getSupabase } from './supabase';

// room_id is not readable by design (see the migration), so it is never selected.
const COLUMNS = 'id, host_id, host_name, topic, seats, seats_taken, last_seen';

export async function fetchOpenRooms(): Promise<OpenRoom[]> {
    const { data, error } = await getSupabase().from('open_rooms').select(COLUMNS).order('last_seen', { ascending: false }).limit(50);
    if (error) throw error;
    return data ?? [];
}

// One listing per host; listing again replaces the previous one.
export async function listRoom(listing: { host_id: string; room_id: string; host_name: string; topic: string; seats: number; seats_taken: number }) {
    const { error } = await getSupabase().from('open_rooms').upsert({ ...listing, last_seen: new Date().toISOString() }, { onConflict: 'host_id' });
    return !error;
}

// Called on a timer while the host is in the room. A listing nobody refreshes
// drops off the board by itself after two minutes.
export const refreshListing = (hostId: string, seatsTaken: number) =>
    getSupabase().from('open_rooms').update({ seats_taken: seatsTaken, last_seen: new Date().toISOString() }).eq('host_id', hostId);

export const unlistRoom = (hostId: string) => getSupabase().from('open_rooms').delete().eq('host_id', hostId);

// Returns the room's code, or says why there is no seat.
export async function takeSeat(listingId: string): Promise<{ code: string } | { reason: string }> {
    const { data, error } = await getSupabase().rpc('join_open_room', { p_listing: listingId });
    if (data) return { code: data };
    return { reason: error?.message?.includes('full') ? 'This group just filled up.' : error?.message?.includes('not found') ? 'This group has closed.' : 'Could not join this group. Check your connection and try again.' };
}
