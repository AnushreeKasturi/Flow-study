// First-run setup. Each answer changes the page as it is given and is kept on
// this device, so the first room already feels like the user's own.
import { byId } from './dom';
import { currentTheme, setTheme, type Theme } from './theme';
import supabase from './modules/supabase';
import { saveDisplayName } from './modules/profile';
import { loadUser, markSignedIn } from './modules/session';
import { showLoader, hideLoader, leaveWithLoader } from './loader';
import { playSound, stopSound, setSoundVolume, type Sound } from './modules/soundscape';
import { bindSocialButtons, rememberInvite } from './modules/sign-in';
import { looksLikeEmail, suggestEmail } from './modules/email-check';
import { captchaToken, prepCaptcha, isCaptchaError, CAPTCHA_MSG } from './modules/captcha';

// Read the session before building the steps: someone signed in skips the account step.
const signedIn = await loadUser();
// Someone already signed in is here to redo their setup; they skip the account step.
const steps = ['name', 'sky', 'length', 'sound', ...(signedIn ? [] : ['account'])];
// Where the sun rests on each step (0 = high, 1 = set).
const SUN_REST: Record<string, number> = { name: .5, sky: .32, sound: .26, account: .12 };

const form = byId<HTMLFormElement>('start-form');
const next = byId<HTMLButtonElement>('start-next');
const back = byId<HTMLButtonElement>('start-back');
const dots = byId<HTMLElement>('start-dots');
const message = byId<HTMLElement>('start-message');
const nameInput = byId<HTMLInputElement>('start-name');
const lengthInput = byId<HTMLInputElement>('start-length');
let index = 0;
let busy = false;
let sound = '';

const firstName = () => nameInput.value.trim();
const setSun = (y: number) => document.body.style.setProperty('--sun-y', String(y));
// 90 minutes puts the sun near the top; 10 leaves it just above the horizon.
const sunForMinutes = (minutes: number) => .75 - ((minutes - 10) / 80) * .7;

function say(text: string, ok = false) {
    message.textContent = text;
    message.classList.toggle('ok', ok);
    message.classList.toggle('hidden', !text);
}

function show(to: number) {
    index = to;
    const step = steps[index];
    document.body.dataset.step = step;
    document.querySelectorAll<HTMLElement>('.step').forEach(section => { section.hidden = section.dataset.step !== step; });
    back.hidden = index === 0;
    next.textContent = index < steps.length - 1 ? 'Continue' : signedIn ? 'Open my room' : 'Create my account';
    dots.replaceChildren(...steps.map((_, i) => Object.assign(document.createElement('i'), { className: i === index ? 'on' : '' })));
    dots.setAttribute('aria-label', `Step ${index + 1} of ${steps.length}`);
    document.querySelectorAll('[data-name]').forEach(el => { el.textContent = firstName() ? ', ' + firstName() : ''; });
    setSun(step === 'length' ? sunForMinutes(Number(lengthInput.value)) : SUN_REST[step]);
    if (step !== 'sound') { stopSound(); document.body.classList.remove('sounding'); }
    // The captcha only loads for someone about to make an account.
    if (step === 'account') prepCaptcha();
    say('');
    document.querySelector<HTMLElement>(`.step[data-step="${step}"] :is(input, button[aria-pressed="true"])`)?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
}

// Name: the headline answers as you type.
nameInput.value = localStorage.getItem('flow_pending_name') || '';
const greet = () => { byId<HTMLElement>('start-greeting').textContent = firstName() ? `Hello, ${firstName()}.` : 'What should we call you?'; };
nameInput.addEventListener('input', greet);
greet();

// Sky: the page changes under the pointer.
const swatches = document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]');
const markSky = () => swatches.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === currentTheme())));
swatches.forEach(button => button.addEventListener('click', () => { setTheme(button.dataset.themeChoice as Theme); markSky(); }));
markSky();

// Length: slider, presets, and the sun itself all drive one value.
function setMinutes(minutes: number) {
    minutes = Math.min(90, Math.max(10, Math.round(minutes / 5) * 5));
    lengthInput.value = String(minutes);
    byId<HTMLElement>('start-minutes').textContent = String(minutes);
    document.querySelectorAll<HTMLButtonElement>('[data-minutes]').forEach(button => button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) === minutes)));
    if (steps[index] === 'length') setSun(sunForMinutes(minutes));
}
lengthInput.addEventListener('input', () => setMinutes(Number(lengthInput.value)));
document.querySelectorAll<HTMLButtonElement>('[data-minutes]').forEach(button => button.addEventListener('click', () => setMinutes(Number(button.dataset.minutes))));
setMinutes(Number(localStorage.getItem('flow_focus_minutes')) || 25);

const sun = document.querySelector<HTMLElement>('.sun')!;
const sky = document.querySelector<HTMLElement>('.sky')!;
sun.addEventListener('pointerdown', event => {
    if (steps[index] !== 'length') return;
    sun.setPointerCapture(event.pointerId);
    document.body.classList.add('sun-driven');
    const grab = event.clientY - sun.getBoundingClientRect().top;
    const move = (e: PointerEvent) => {
        const box = sky.getBoundingClientRect();
        // Invert the CSS mapping (top = 10% + y × 90%) to get y from the pointer.
        const y = ((e.clientY - grab - box.top) / box.height - .1) / .9;
        setMinutes(10 + ((.75 - y) / .7) * 80);
    };
    sun.addEventListener('pointermove', move);
    sun.addEventListener('pointerup', () => {
        sun.removeEventListener('pointermove', move);
        document.body.classList.remove('sun-driven');
    }, { once: true });
});

// Sound: tapping a choice plays it straight away.
setSoundVolume(.35);
document.querySelectorAll<HTMLButtonElement>('[data-sound-choice]').forEach(button => button.addEventListener('click', () => {
    sound = button.dataset.soundChoice!;
    document.querySelectorAll<HTMLButtonElement>('[data-sound-choice]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    if (sound) playSound(sound as Sound); else stopSound();
    document.body.classList.toggle('sounding', !!sound);
}));

function savePreferences() {
    localStorage.setItem('flow_pending_name', firstName());
    localStorage.setItem('flow_focus_minutes', lengthInput.value);
    if (sound) localStorage.setItem('flow_sound', sound); else localStorage.removeItem('flow_sound');
}

async function finish(user: { id: string; email?: string }) {
    markSignedIn();
    showLoader('Setting up your space…');
    // If saving the name fails here, the room's lobby asks for it again with this value filled in.
    if (await saveDisplayName(user.id, firstName())) {
        localStorage.setItem('flow_named', '1');
        localStorage.removeItem('flow_pending_name');
    }
    leaveWithLoader('/room.html' + location.search, 'Opening your space…');
}

async function createAccount() {
    const emailInput = byId<HTMLInputElement>('start-email');
    const email = emailInput.value.trim();
    const password = byId<HTMLInputElement>('start-password').value;
    if (!looksLikeEmail(email)) return say('Enter a valid email address.');
    const typo = suggestEmail(email);
    if (typo && emailInput.dataset.checked !== email) {
        // Asked once: pressing the button again with the same address goes ahead.
        emailInput.dataset.checked = email;
        return say(`Did you mean ${typo}? Fix it, or press the button again to use ${email}.`);
    }
    if (password.length < 8) return say('Use a password with at least 8 characters.');
    rememberInvite();
    // The verification email links to /verify.html, which finishes the sign-up (see emails/).
    const { data, error } = await supabase.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + '/verify.html', captchaToken: await captchaToken() } });
    if (isCaptchaError(error)) return say(CAPTCHA_MSG);
    const taken = /already registered|already exists|user already/i.test(error?.message ?? '') || (data?.user && data.user.identities?.length === 0);
    if (taken) return say('An account with this email already exists. Use “Log in” at the top instead.');
    if (error) return say(error.message);
    if (data.session && data.user) return finish(data.user);
    // Projects with "Confirm email" on make no session until the link is opened.
    try { localStorage.setItem('flow_verify_email', email); } catch { /* the inbox page asks for it instead */ }
    leaveWithLoader('/verify.html', 'Sending your link…');
}

form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    if (steps[index] === 'name' && !firstName()) { say('Type a name to continue.'); nameInput.focus(); return; }
    if (index < steps.length - 1) return show(index + 1);
    busy = next.disabled = true;
    savePreferences();
    try {
        if (signedIn) await finish(signedIn); else await createAccount();
    } catch {
        hideLoader();
        say('Could not reach the sign-in service. Check your connection and try again.');
    } finally {
        busy = next.disabled = false;
    }
});
back.addEventListener('click', () => show(index - 1));
// GitHub or Google on the last step: your choices are kept on this device for the round trip.
bindSocialButtons(message => say(message), savePreferences);
if (signedIn) byId<HTMLElement>('start-login').remove();
show(0);
