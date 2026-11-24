// The ways in that leave Flow and come back: GitHub or Google (Supabase OAuth),
// which return to /login.html, and the verification email, whose link opens
// /verify.html. Both finish through completeSignIn(): a new account gets the name
// typed during setup, and an invite carries on to its room.
import defaults from '../../../supabase.config.json';
import supabase from './supabase';
import { markSignedIn } from './session';
import { saveDisplayName } from './profile';
import { read, write } from './storage';

type Provider = 'github' | 'google';
const KNOWN: readonly string[] = ['github', 'google'];
// Only the providers switched on for this Supabase project (Authentication → Sign In / Providers).
export const PROVIDERS = ((defaults as { oauthProviders?: string[] }).oauthProviders ?? []).filter((p): p is Provider => KNOWN.includes(p));

// An invite survives a sign-up that finishes elsewhere (the email may be opened in another tab).
const INVITE = 'flow_invite_room';
const validRoom = (room: string | null) => room && /^[A-Za-z0-9]{6}$/.test(room) ? room.toUpperCase() : null;
export function rememberInvite() {
    const room = validRoom(new URLSearchParams(location.search).get('room'));
    write(INVITE, room || null); // storage blocked: the invite is lost, Home still works
}

export async function continueWith(provider: Provider) {
    // Only the invite survives the round trip; nothing else rides along in the address.
    const room = new URLSearchParams(location.search).get('room');
    const back = new URL('/login.html', location.origin);
    if (room && /^[A-Za-z0-9]{6}$/.test(room)) back.searchParams.set('room', room.toUpperCase());
    const { error } = await supabase.auth.signInWithOAuth({ provider, options: { redirectTo: back.href } });
    return error;
}

// On /login.html: if the provider has just signed someone in, finish and say where to go.
export async function finishOAuth(): Promise<string | null> {
    const { data } = await supabase.auth.getSession();
    const user = data.session?.user;
    return user ? completeSignIn(user) : null;
}

// Someone is now signed in: note it, save the name from setup, and return where to go next.
// `keepName` is false when this browser can't tell the account is the one it set up.
export async function completeSignIn(user: { id: string }, keepName = true): Promise<string> {
    markSignedIn();
    const pendingName = keepName ? read('flow_pending_name') : null;
    if (pendingName && await saveDisplayName(user.id, pendingName)) {
        write('flow_named', '1');
        write('flow_pending_name', null);
    }
    let room = validRoom(new URLSearchParams(location.search).get('room'));
    room ||= validRoom(read(INVITE));
    write(INVITE, null);
    return '/room.html' + (room ? '?room=' + room : '');
}

// Wires the buttons from SocialSignIn.astro. `before` runs first (setup saves its choices).
export function bindSocialButtons(onError: (message: string) => void, before?: () => void) {
    document.querySelectorAll<HTMLButtonElement>('[data-provider]').forEach(button => button.addEventListener('click', async () => {
        before?.();
        button.disabled = true;
        const error = await continueWith(button.dataset.provider as Provider).catch(() => new Error('unreachable'));
        // On success the browser is already leaving for the provider.
        if (error) { button.disabled = false; onError('That sign-in option isn’t available right now. Use your email instead, or try again later.'); }
    }));
}
