// "Ready to join?": your camera before anyone in the room can see you, with switches
// for the camera and microphone. It starts the room's own stream (initMedia), so the
// browser asks for permission once and the choice carries straight into the room.
import { byId, on } from '../dom';
import { hideLoader } from '../loader';
import { openModal, closeModal } from '../modules/feedback';
import { initMedia, cleanupMedia, hasCamera, hasAudioTrack, setCameraOn, setMicOn } from '../modules/rtc';
import * as UI from '../modules/ui';

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: boolean) => { try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* this visit only */ } };
// Shown unless turned off in room settings.
export const previewWanted = () => read('flow_preview') !== '0';
export const setPreviewWanted = (yes: boolean) => write('flow_preview', yes);

let answer: ((join: boolean) => void) | null = null;
const finish = (join: boolean) => { const done = answer; answer = null; done?.(join); };

let camera = true, mic = true;
function render() {
    const cam = byId<HTMLButtonElement>('preview-cam'), micBtn = byId<HTMLButtonElement>('preview-mic');
    const canCam = hasCamera(), canMic = hasAudioTrack();
    cam.disabled = !canCam;
    micBtn.disabled = !canMic;
    const camOn = canCam && camera, micOn = canMic && mic;
    for (const [button, state, label] of [[cam, camOn, 'Camera'], [micBtn, micOn, 'Microphone']] as const) {
        button.classList.toggle('active', state);
        button.setAttribute('aria-pressed', String(state));
        button.querySelector('span')!.textContent = `${label} ${state ? 'on' : 'off'}`;
    }
    byId('preview-video').classList.toggle('hidden', !camOn);
    byId('preview-off').classList.toggle('hidden', camOn);
    byId('preview-off-text').textContent = canCam ? 'Your camera is off' : 'No camera available';
    byId('preview-note').textContent = !canCam && !canMic ? 'Flow can’t use your camera or microphone. You can still join and study; allow them in your browser settings to change that.'
        : camOn ? 'This is what the room will see.' : 'The room will see your initial, not your camera.';
    setCameraOn(camOn);
    setMicOn(micOn);
}

let bound = false;
function bind() {
    if (bound) return;
    bound = true;
    on('preview-cam', () => { camera = !camera; write('flow_join_camera', camera); render(); });
    on('preview-mic', () => { mic = !mic; write('flow_join_mic', mic); render(); });
    on('preview-join', () => finish(true));
    on('preview-back', () => finish(false));
    // Escape closes dialogs everywhere in Flow; here it means "not now".
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && answer) finish(false); });
}

// Resolves true to join, false to go back. Either way the camera is already set up.
export async function preview(roomCode: string, name: string): Promise<boolean> {
    bind();
    camera = read('flow_join_camera') !== '0';
    mic = read('flow_join_mic') !== '0';
    byId('preview-room').textContent = roomCode;
    byId('preview-avatar').textContent = UI.initial(name);
    const join = byId<HTMLButtonElement>('preview-join');
    join.disabled = true;
    hideLoader();
    openModal('preview-modal');
    const waiting = new Promise<boolean>(resolve => { answer = resolve; });
    byId('preview-note').textContent = 'Starting your camera…';
    // A long wait here is the browser asking for permission.
    const asking = setTimeout(() => { if (answer) byId('preview-note').textContent = 'Allow the camera and microphone in your browser to see yourself here.'; }, 1200);
    await initMedia(byId<HTMLVideoElement>('preview-video'));
    clearTimeout(asking);
    if (answer) { render(); join.disabled = false; join.focus(); }
    const joining = await waiting;
    if (!joining) { cleanupMedia(); closeModal(); }
    return joining;
}
