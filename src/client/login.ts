import { byId } from './dom';
import { bindThemePicker } from './theme';
import { markSignedIn } from './modules/session';
import { leaveWithLoader } from './loader';
import supabase from './modules/supabase';

// DOM Elements
const emailInput = byId<HTMLInputElement>('email-input');
const passwordInput = byId<HTMLInputElement>('password-input');
const loginBtn = byId<HTMLButtonElement>('login-btn');
const errorMsg = byId<HTMLElement>('error-message');
const successMsg = byId<HTMLElement>('success-message');
let authBusy = false;
let redirectPending = false;

bindThemePicker(byId<HTMLSelectElement>('theme-picker'));

// An invite link survives the trip through sign-in.
const invitedRoom = new URLSearchParams(location.search).get('room');
if (invitedRoom && /^[A-Za-z0-9]{6}$/.test(invitedRoom)) {
    byId<HTMLElement>('invite-code').textContent = invitedRoom.toUpperCase();
    byId<HTMLElement>('invite-note').classList.remove('hidden');
}

// Helper to show errors
const showError = (msg: string) => {
    errorMsg.innerText = msg;
    errorMsg.style.display = 'block';
    successMsg.style.display = 'none';
};

const showSuccess = (msg: string) => {
    successMsg.innerText = msg;
    successMsg.style.display = 'block';
    errorMsg.style.display = 'none';
};

const clearMessages = () => {
    errorMsg.style.display = 'none';
    successMsg.style.display = 'none';
};

const persistAndRedirect = (_user: { id: string; email?: string }, action: string) => {
    redirectPending = true;
    // Supabase keeps the session; Flow only notes that someone is signed in.
    markSignedIn();
    showSuccess(action === 'login' ? 'Logged in.' : 'Account created.');
    leaveWithLoader('/room.html' + location.search, 'Opening your space…');
};

// Logging in only. New accounts are made at the end of setup (/start.html), so
// there is one way in for new people, and it gives them a name and a sky first.
const logIn = async () => {
    if (authBusy) return;
    clearMessages();
    if (!byId<HTMLFormElement>('auth-form').reportValidity()) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email.includes('@')) { showError('Enter the email address you signed up with.'); return; }
    if (password.length < 6) { showError('Password must be at least 6 characters.'); return; }

    authBusy = loginBtn.disabled = true;
    loginBtn.innerText = 'Logging in…';
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            showError(/confirm|verif/i.test(error.message) ? 'Confirm your email first: open the link we sent you, then log in.'
                : /invalid/i.test(error.message) ? 'That email and password don’t match an account. Check them, or set up a new space.'
                : error.message);
            return;
        }
        if (data?.session && data.user) { persistAndRedirect(data.user, 'login'); return; }
        showError('Logging in did not complete. Try again.');
    } catch {
        showError('Could not reach the sign-in service. Check your connection and try again.');
    } finally {
        authBusy = false;
        loginBtn.innerText = 'Log in';
        loginBtn.disabled = redirectPending;
    }
};

byId<HTMLFormElement>('auth-form').addEventListener('submit', event => {
    event.preventDefault();
    logIn();
});
// Setup keeps an invite: someone invited who has no account still lands in that room.
byId<HTMLAnchorElement>('signup-link').href = '/start.html' + location.search;

byId<HTMLButtonElement>('toggle-password').addEventListener('click', event => {
    const visible = passwordInput.type === 'password';
    passwordInput.type = visible ? 'text' : 'password';
    (event.currentTarget as HTMLButtonElement).textContent = visible ? 'Hide' : 'Show';
    (event.currentTarget as HTMLButtonElement).setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    (event.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(visible));
});
