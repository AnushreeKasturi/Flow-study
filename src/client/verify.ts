// Email verification. Arriving from sign-up, the page says where the link went and
// can send it again. Arriving from the link in the email (?token_hash=…), it asks
// for one tap before confirming: email scanners that open links can't use up the
// token, and a link someone else sent can't quietly sign this browser into their
// account. The account is named once confirmed, and the name typed during setup is
// only saved to it when it is the address this browser signed up with.
// Forgot password runs through the same page: ?forgot asks for the address, and
// the reset email's link (?token_hash=…&type=recovery) gets the same one tap
// before the person chooses a new password.
import type { User } from '@supabase/supabase-js';
import { byId } from './dom';
import supabase from './modules/supabase';
import { completeSignIn } from './modules/sign-in';
import { markSignedOut } from './modules/session';
import { looksLikeEmail, suggestEmail } from './modules/email-check';
import { captchaToken, prepCaptcha, isCaptchaError, CAPTCHA_MSG } from './modules/captcha';

type State = 'sent' | 'confirm' | 'checking' | 'done' | 'failed' | 'forgot' | 'reset-sent' | 'reset' | 'new-pw' | 'changed';
const status = byId<HTMLElement>('verify-status');
const show = (state: State) =>
    document.querySelectorAll<HTMLElement>('[data-state]').forEach(section => { section.hidden = section.dataset.state !== state; });
const pendingEmail = () => { try { return localStorage.getItem('flow_verify_email'); } catch { return null; } };

// Links can be resent once a minute (Supabase limits them too).
let cooldown: ReturnType<typeof setInterval> | undefined;
async function resend(email: string, button: HTMLButtonElement, kind: 'signup' | 'reset' = 'signup') {
    button.disabled = true;
    const back = location.origin + '/verify.html';
    const token = await captchaToken();
    const { error } = await (kind === 'reset'
        ? supabase.auth.resetPasswordForEmail(email, { redirectTo: back, captchaToken: token })
        : supabase.auth.resend({ type: 'signup', email, options: { emailRedirectTo: back, captchaToken: token } })
    ).catch(() => ({ error: { message: 'unreachable' } }));
    if (error) {
        status.textContent = isCaptchaError(error) ? CAPTCHA_MSG : /rate|seconds|many/i.test(error.message) ? 'A link was sent a moment ago. Give it a minute, then try again.' : 'The email could not be sent just now. Try again in a minute.';
        button.disabled = false;
        return false;
    }
    let left = 60;
    status.textContent = `Sent. You can send another in ${left} s.`;
    clearInterval(cooldown);
    cooldown = setInterval(() => {
        left -= 1;
        status.textContent = left > 0 ? `Sent. You can send another in ${left} s.` : '';
        if (left <= 0) { clearInterval(cooldown); button.disabled = false; }
    }, 1000);
    return true;
}

// Uses a link's single-use token. A dropped connection is not an expired link: the
// token is still good, so the page says so and the same tap works again.
const OFFLINE = 'Flow couldn’t be reached. Check your connection, then tap again: your link still works.';
async function useToken(tokenHash: string, type: 'email' | 'signup' | 'recovery'): Promise<User | 'offline' | null> {
    try {
        const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
        if (error?.name === 'AuthRetryableFetchError') return 'offline';
        return error ? null : data.user;
    } catch { return 'offline'; }
}

async function confirm(tokenHash: string, type: 'email' | 'signup') {
    show('checking');
    const user = await useToken(tokenHash, type);
    if (user === 'offline') { show('confirm'); status.textContent = OFFLINE; return; }
    if (!user) { show('failed'); return; }
    status.textContent = '';
    const email = user.email ?? '';
    const ours = !!email && email.toLowerCase() === (pendingEmail() ?? '').toLowerCase();
    try { localStorage.removeItem('flow_verify_email'); } catch { /* nothing to clear */ }
    byId<HTMLElement>('verify-account').textContent = email || 'your account';
    byId<HTMLAnchorElement>('verify-continue').href = await completeSignIn(user, ours);
    show('done');
}

// The reset link: one tap signs in with the token, then a new password is chosen.
async function recover(tokenHash: string, button: HTMLButtonElement) {
    button.disabled = true;
    const user = await useToken(tokenHash, 'recovery');
    button.disabled = false;
    if (user === 'offline') { status.textContent = OFFLINE; return; }
    if (!user) {
        show('forgot');
        status.textContent = 'That reset link has expired or was already used. Send a new one below.';
        return;
    }
    status.textContent = '';
    byId<HTMLElement>('pw-account').textContent = user.email || 'your account';
    show('new-pw');
    byId<HTMLInputElement>('pw-input').focus();
}

const forgotEmail = byId<HTMLInputElement>('forgot-email');
const params = new URLSearchParams(location.search);
const tokenHash = params.get('token_hash');
if (tokenHash && params.get('type') === 'recovery') {
    history.replaceState(null, '', '/verify.html');
    show('reset');
    byId<HTMLButtonElement>('reset-go').addEventListener('click', event => recover(tokenHash, event.currentTarget as HTMLButtonElement));
}
else if (params.has('forgot')) {
    try { forgotEmail.value = sessionStorage.getItem('flow_reset_email') ?? ''; } catch { /* typed again instead */ }
    show('forgot');
    prepCaptcha();
}
else if (tokenHash) {
    // The token is single-use: out of the address at once, and used only on a tap.
    const type = params.get('type') === 'signup' ? 'signup' : 'email';
    history.replaceState(null, '', '/verify.html');
    show('confirm');
    byId<HTMLButtonElement>('verify-confirm').addEventListener('click', () => confirm(tokenHash, type));
}
else if (params.has('error') || params.has('error_description') || !pendingEmail()) { show('failed'); prepCaptcha(); }
else {
    byId<HTMLElement>('verify-email').textContent = pendingEmail()!;
    show('sent');
    prepCaptcha();
}

byId<HTMLButtonElement>('verify-resend').addEventListener('click', event => {
    const email = pendingEmail();
    if (email) resend(email, event.currentTarget as HTMLButtonElement);
});
byId<HTMLFormElement>('verify-form').addEventListener('submit', async event => {
    event.preventDefault();
    const email = byId<HTMLInputElement>('verify-email-input').value.trim();
    if (!email.includes('@')) return;
    const button = (event.currentTarget as HTMLFormElement).querySelector('button')!;
    if (await resend(email, button)) {
        try { localStorage.setItem('flow_verify_email', email); } catch { /* shown below instead */ }
        byId<HTMLElement>('verify-email').textContent = email;
        show('sent');
    }
});

byId<HTMLFormElement>('forgot-form').addEventListener('submit', async event => {
    event.preventDefault();
    const email = forgotEmail.value.trim();
    if (!looksLikeEmail(email)) { status.textContent = 'Enter the email address you signed up with.'; return; }
    const typo = suggestEmail(email);
    if (typo && forgotEmail.dataset.checked !== email) {
        // Asked once: sending again with the same address goes ahead.
        forgotEmail.dataset.checked = email;
        status.textContent = `Did you mean ${typo}? Fix it, or send again to use ${email}.`;
        return;
    }
    // The "Send it again" button carries the one-minute wait.
    const button = (event.currentTarget as HTMLFormElement).querySelector('button')!;
    button.disabled = true;
    const sent = await resend(email, byId<HTMLButtonElement>('reset-again'), 'reset');
    button.disabled = false;
    if (!sent) return;
    byId<HTMLElement>('reset-to').textContent = email;
    show('reset-sent');
});
byId<HTMLButtonElement>('reset-again').addEventListener('click', event => {
    resend(byId<HTMLElement>('reset-to').textContent ?? '', event.currentTarget as HTMLButtonElement, 'reset');
});
byId<HTMLButtonElement>('reset-other').addEventListener('click', () => { status.textContent = ''; show('forgot'); forgotEmail.select(); });

const pwInput = byId<HTMLInputElement>('pw-input');
byId<HTMLButtonElement>('pw-toggle').addEventListener('click', event => {
    const button = event.currentTarget as HTMLButtonElement;
    const visible = pwInput.type === 'password';
    pwInput.type = visible ? 'text' : 'password';
    button.textContent = visible ? 'Hide' : 'Show';
    button.setAttribute('aria-label', visible ? 'Hide password' : 'Show password');
    button.setAttribute('aria-pressed', String(visible));
});
byId<HTMLFormElement>('pw-form').addEventListener('submit', async event => {
    event.preventDefault();
    const password = pwInput.value;
    if (password.length < 8) { status.textContent = 'Use a password with at least 8 characters.'; return; }
    const button = (event.currentTarget as HTMLFormElement).querySelector('button')!;
    button.disabled = true;
    status.textContent = 'Saving…';
    const { data, error } = await supabase.auth.updateUser({ password })
        .catch(() => ({ data: { user: null }, error: { message: 'unreachable' } }));
    button.disabled = false;
    if (error || !data.user) {
        const message = error?.message ?? '';
        status.textContent = /different|same/i.test(message) ? 'That’s your current password. Choose a different one.'
            : /weak|short|least|characters/i.test(message) ? 'That password is too easy to guess. Try a longer one.'
            : /session|expired|jwt|auth/i.test(message) ? 'This reset has timed out. Ask for a new link from the login page.'
            : 'The password could not be saved. Check your connection and try again.';
        return;
    }
    byId<HTMLElement>('changed-account').textContent = data.user.email || 'your account';
    byId<HTMLAnchorElement>('changed-go').href = await completeSignIn(data.user, false);
    status.textContent = '';
    show('changed');
});

byId<HTMLButtonElement>('verify-sign-out').addEventListener('click', async () => {
    await supabase.auth.signOut().catch(() => {});
    markSignedOut();
    location.replace('/login.html');
});
