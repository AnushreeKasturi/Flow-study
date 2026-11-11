import { byId } from './dom';
import { bindThemePicker } from './theme';
import supabase from './modules/supabase';

// DOM Elements
const emailInput = byId<HTMLInputElement>('email-input');
const passwordInput = byId<HTMLInputElement>('password-input');
const loginBtn = byId<HTMLButtonElement>('login-btn');
const signupBtn = byId<HTMLButtonElement>('signup-btn');
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

const persistAndRedirect = (user: { id: string; email?: string }, action: string) => {
    redirectPending = true;
    localStorage.setItem('flow_user', JSON.stringify({
        id: user.id,
        email: user.email
    }));
    showSuccess(action === 'login' ? 'Logged in. Opening your room…' : 'Account created. Opening your room…');
    setTimeout(() => { window.location.href = '/room.html' + location.search; }, 500);
};

const handleAuth = async (action: 'login' | 'signup') => {
    if (authBusy) return;
    clearMessages();
    if (!byId<HTMLFormElement>('auth-form').reportValidity()) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !email.includes('@')) {
        showError('Please enter a valid email address.');
        return;
    }
    if (password.length < (action === 'signup' ? 8 : 6)) {
        showError(action === 'signup' ? 'Choose a password with at least 8 characters.' : 'Password must be at least 6 characters.');
        return;
    }
    const btn = action === 'login' ? loginBtn : signupBtn;
    const originalText = btn.innerText;
    btn.innerText = action === 'login' ? 'Logging in…' : 'Creating account…';
    authBusy = true;
    loginBtn.disabled = signupBtn.disabled = true;
    try {

        let result;
        if (action === 'login') {
            result = await supabase.auth.signInWithPassword({ email, password });
        } else {
            result = await supabase.auth.signUp({ email, password });
        }


        if (result.error) {
            if (action === 'signup' && /already registered|already exists|user already/i.test(result.error.message)) {
                showError('An account with this email already exists. Please log in.');
                return;
            }
            showError(result.error.message);
            return;
        }

        if (result.data?.session && result.data?.user) {
            persistAndRedirect(result.data.user, action);
            return;
        }

        if (action === 'signup') {
            // Some Supabase configs create the user but don't return a session immediately.
            // Try signing in directly so "Confirm email OFF" works without any extra steps.
            const signInResult = await supabase.auth.signInWithPassword({ email, password });
            if (!signInResult.error && signInResult.data?.session && signInResult.data?.user) {
                persistAndRedirect(signInResult.data.user, 'signup');
                return;
            }

            if (signInResult.error && /confirm|confirmed|verification/i.test(signInResult.error.message)) {
                showSuccess('Check your email for a confirmation link, then return here to log in.');
                return;
            }
        }

        showError('Authentication failed. Please try again.');
    } catch {
        showError('Could not reach the sign-in service. Check your connection and try again.');
    } finally {
        authBusy = false;
        btn.innerText = originalText;
        loginBtn.disabled = signupBtn.disabled = redirectPending;
    }
};

byId<HTMLFormElement>('auth-form').addEventListener('submit', (e) => {
    e.preventDefault();
    handleAuth('login');
});
signupBtn.addEventListener('click', () => handleAuth('signup'));

byId<HTMLButtonElement>('toggle-password').addEventListener('click', event => {
    const visible = passwordInput.type === 'password';
    passwordInput.type = visible ? 'text' : 'password';
    (event.currentTarget as HTMLButtonElement).textContent = visible ? 'Hide' : 'Show';
    (event.currentTarget as HTMLButtonElement).setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    (event.currentTarget as HTMLButtonElement).setAttribute('aria-pressed', String(visible));
});
