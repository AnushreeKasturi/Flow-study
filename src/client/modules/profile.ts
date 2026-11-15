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

// False only when the account demonstrably has no name yet. A failed read
// counts as "has one", so a network blip never re-runs first-run setup.
export const hasDisplayName = async (userId: string) => {
    try {
        const { data, error } = await getSupabase().from('profiles').select('display_name').eq('id', userId).maybeSingle();
        return error ? true : !!data?.display_name;
    } catch { return true; }
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

// A local calendar day as YYYY-MM-DD, the way focus_days (sql/019) names it.
export const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

// Saved focus per local day. The database adds it up (sql/019), one row per day: fetching
// every session instead stops at the API's 1,000-row limit and quietly undercounts.
async function focusByDay(userId: string): Promise<{ days: Record<string, number>; completed: number; recentIds: string[] }> {
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const since = new Date(Date.now() - 2 * 864e5).toISOString();
    // Blocks saved in the last two days, so time still being tracked on this page isn't counted twice.
    const recent = getSupabase().from('sessions').select('id').eq('user_id', userId).gte('completed_at', since);
    const [{ data, error }, { data: recentRows }] = await Promise.all([getSupabase().rpc('focus_days', { p_tz: timezone }), recent]);
    const recentIds = (recentRows || []).map((row: { id: string }) => row.id);
    if (!error && Array.isArray(data)) {
        const days: Record<string, number> = {};
        let completed = 0;
        for (const row of data as { day: string; seconds: number; completed: number }[]) { days[row.day] = Number(row.seconds); completed += row.completed; }
        return { days, completed, recentIds };
    }
    // Before sql/019: add up the rows here (capped by the API as before).
    const { data: sessions, error: sessionError } = await getSupabase().from('sessions').select('id, mode, duration_seconds, completed_at').eq('user_id', userId);
    if (sessionError) throw new Error('Profile stats are unavailable');
    const days: Record<string, number> = {};
    for (const row of sessions || []) { const key = dayKey(new Date(row.completed_at)); days[key] = (days[key] || 0) + row.duration_seconds; }
    return { days, completed: (sessions || []).filter(row => row.mode === 'focus').length, recentIds: (sessions || []).map(row => row.id) };
}

export const getStats = async (userId: string) => {
    const [focus, { count: tasksCompleted, error: taskError }] = await Promise.all([
        focusByDay(userId),
        getSupabase().from('tasks').select('id', { count: 'exact', head: true }).eq('created_by', userId).eq('completed', true)
    ]);
    if (taskError) throw new Error('Profile stats are unavailable');
    const { days } = focus;
    const savedTotalSeconds = Object.values(days).reduce((acc, seconds) => acc + seconds, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const savedTodaySeconds = days[dayKey(today)] || 0;

    // Saved seconds for each of the last seven local calendar days, oldest first.
    const weekSeconds = Array.from({ length: 7 }, (_, index) => {
        const day = new Date(today);
        day.setDate(day.getDate() - (6 - index));
        return days[dayKey(day)] || 0;
    });

    const streak = computeStreak(Object.keys(days).filter(key => days[key] > 0).map(key => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).toDateString(); }));

    return withLiveFocus({
        savedTotalSeconds,
        savedTodaySeconds,
        weekSeconds,
        daySeconds: days,
        persistedIds: focus.recentIds,
        streak,
        // Only blocks that ran to the end are sessions; partial focus still counts toward time and streaks.
        sessionsCompleted: focus.completed,
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
