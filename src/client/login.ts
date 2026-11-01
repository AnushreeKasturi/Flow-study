import { enterPage } from './motion';
import { byId } from './dom';
import supabase from './modules/supabase';

// DOM Elements
const emailInput = byId<HTMLInputElement>('email-input');
const passwordInput = byId<HTMLInputElement>('password-input');
const loginBtn = byId<HTMLButtonElement>('login-btn');
const signupBtn = byId<HTMLButtonElement>('signup-btn');
const errorMsg = byId<HTMLElement>('error-message');
const successMsg = byId<HTMLElement>('success-message');
const themePicker = byId<HTMLSelectElement>('theme-picker');

let authBusy = false;
let redirectPending = false;

const supportedThemes = new Set(['forest', 'midnight', 'warm', 'aqua', 'amethyst']);
const savedTheme = localStorage.getItem('flow_theme') || 'forest';
const activeTheme = supportedThemes.has(savedTheme) ? savedTheme : 'forest';
document.documentElement.setAttribute('data-theme', activeTheme);
if (themePicker) {
    themePicker.value = activeTheme;
    themePicker.addEventListener('change', (e) => {
        const theme = (e.target as HTMLSelectElement).value;
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('flow_theme', theme);
    });
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
    showSuccess(action === 'login' ? 'Logged in successfully! Redirecting...' : 'Account created successfully! Redirecting...');
    setTimeout(() => {
        window.location.href = '/';
    }, 1000);
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
    if (password.length < 6) {
        showError('Password must be at least 6 characters.');
        return;
    }
    if (!supabase) {
        showError('Sign-in is temporarily unavailable. Refresh the page and try again.');
        return;
    }

    const btn = action === 'login' ? loginBtn : signupBtn;
    const originalText = btn.innerText;
    btn.innerText = 'Processing...';
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
document.querySelectorAll<HTMLButtonElement>('[data-preview-minutes]').forEach(button => button.addEventListener('click', () => {
    byId<HTMLElement>('preview-time').textContent = button.dataset.previewMinutes!.padStart(2, '0') + ':00';
    document.querySelectorAll<HTMLButtonElement>('[data-preview-minutes]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
}));

enterPage();
