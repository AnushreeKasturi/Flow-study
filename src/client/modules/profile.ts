import type { ProfileStats } from '../types';
import { getSupabase } from './supabase';
import { getLiveFocus } from './focus-progress';

export const getMyProfile = async (userId: string) => {
    const { data, error } = await getSupabase().from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) {
        console.error('Failed to load profile:', error.message);
        return null;
    }
    return data;
};

export const saveDisplayName = async (userId: string, displayName: string) => {
    try {
        const { error } = await getSupabase().from('profiles').upsert({
            id: userId,
            display_name: displayName,
            updated_at: new Date().toISOString()
        });
        if (error) {
            console.error('Failed to save profile:', error.message);
            return false;
        }
        return true;
    } catch { return false; }
};

// Consecutive calendar days (local time) with at least one completed
// session, counting back from today. A day with no session yet is only a
// streak-breaker once "today" has fully passed, so an active streak still
// shows correctly before the user's first session of the day.
const computeStreak = (localDateStrings: string[]) => {
    const days = new Set(localDateStrings);
    const cursor = new Date();
    cursor.setHours(0, 0, 0, 0);

    if (!days.has(cursor.toDateString())) {
        cursor.setDate(cursor.getDate() - 1);
    }

    let streak = 0;
    while (days.has(cursor.toDateString())) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
};

export const getStats = async (userId: string) => {
    const [{ data: sessions, error: sessionError }, { count: tasksCompleted, error: taskError }] = await Promise.all([
        getSupabase().from('sessions').select('id, duration_seconds, completed_at').eq('user_id', userId),
        getSupabase().from('tasks').select('id', { count: 'exact', head: true }).eq('created_by', userId).eq('completed', true)
    ]);
    if (sessionError || taskError) throw new Error('Profile stats are unavailable');

    const rows = sessions || [];
    const savedTotalSeconds = rows.reduce((acc, r) => acc + r.duration_seconds, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const savedTodaySeconds = rows.filter(r => new Date(r.completed_at).getTime() >= today.getTime()).reduce((acc, r) => acc + r.duration_seconds, 0);

    const streak = computeStreak(rows.map(r => new Date(r.completed_at).toDateString()));

    return withLiveFocus({
        savedTotalSeconds,
        savedTodaySeconds,
        persistedIds: rows.map(row => row.id),
        streak,
        sessionsCompleted: rows.length,
        tasksCompleted: tasksCompleted || 0
    });
};

export function withLiveFocus(stats: Omit<ProfileStats, 'totalMinutes' | 'todayMinutes' | 'liveMinutes'>): ProfileStats {
    const live = getLiveFocus({ persistedIds: stats.persistedIds });
    return {
        ...stats,
        totalMinutes: Math.floor((stats.savedTotalSeconds + live.totalSeconds) / 60),
        todayMinutes: Math.floor((stats.savedTodaySeconds + live.todaySeconds) / 60),
        liveMinutes: Math.floor(live.totalSeconds / 60)
    };
}
