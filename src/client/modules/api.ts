import { getSupabase } from './supabase';

// Flow's own endpoints spend provider credit, so the server only answers signed-in users.
export async function api(path: string, body: unknown, timeoutMs: number) {
    const { data } = await getSupabase().auth.getSession();
    return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (data.session?.access_token ?? '') },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    });
}
