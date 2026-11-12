// Who is signed in. Supabase keeps the session; Flow keeps no copy of the
// account's id or email. The only thing stored is a plain "signed in" flag,
// which public/js/boot.js reads before first paint to redirect between pages.
import { getSupabase } from './supabase';

export interface User { id: string; email: string; }
const FLAG = 'flow_signed_in';
let current: User | null = null;

const setFlag = (on: boolean) => {
    try {
        if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG);
        // Earlier versions kept the id and email here; clear any copy left behind.
        localStorage.removeItem('flow_user');
    } catch { /* Storage blocked: redirects fall back to the page scripts. */ }
};

// Reads the session once per page. Call before anything that needs the user.
export async function loadUser(): Promise<User | null> {
    try {
        const { data } = await getSupabase().auth.getSession();
        const user = data.session?.user;
        current = user?.id && user.email ? { id: user.id, email: user.email } : null;
    } catch { current = null; }
    setFlag(!!current);
    return current;
}

export const currentUser = () => current;
export const markSignedIn = () => setFlag(true);
export const markSignedOut = () => { current = null; setFlag(false); };
