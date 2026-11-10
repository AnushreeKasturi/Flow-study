// Generated noise for masking distractions. Local only: nothing is streamed
// or shared, and no audio files ship with the site.
export type Sound = 'brown' | 'pink' | 'white';

let context: AudioContext | null = null;
let gain: GainNode | null = null;
let source: AudioBufferSourceNode | null = null;
let volume = .4;

// Ten seconds of looped noise; long enough that the loop point isn't audible.
function noiseBuffer(ctx: AudioContext, kind: Sound) {
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 10, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1;
        if (kind === 'white') data[i] = white * .25;
        else if (kind === 'brown') { last = (last + .02 * white) / 1.02; data[i] = last * 3.5; }
        else { // Pink: Paul Kellet's economy filter.
            b0 = .99765 * b0 + white * .099046; b1 = .963 * b1 + white * .2965164; b2 = .57 * b2 + white * 1.0526913;
            data[i] = (b0 + b1 + b2 + white * .1848) * .12;
        }
    }
    return buffer;
}

export function stopSound() {
    source?.stop();
    source = null;
}

export function playSound(kind: Sound) {
    stopSound();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    context ??= new AudioCtx();
    if (context.state === 'suspended') context.resume();
    if (!gain) { gain = context.createGain(); gain.connect(context.destination); }
    gain.gain.value = volume;
    source = context.createBufferSource();
    source.buffer = noiseBuffer(context, kind);
    source.loop = true;
    source.connect(gain);
    source.start();
    return true;
}

export function setSoundVolume(value: number) {
    volume = Math.min(1, Math.max(0, value));
    // A short ramp avoids the click of an instant gain change.
    if (gain && context) gain.gain.setTargetAtTime(volume, context.currentTime, .05);
}
