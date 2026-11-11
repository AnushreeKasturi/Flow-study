// Ambient soundscapes, synthesized in the browser: no audio files, nothing
// streamed, nothing shared. Each scene shapes looping noise with filters and
// slow modulation so it moves like the real thing instead of sitting as hiss.
export const SOUNDS = [
    ['rain', 'Rain', 'Steady rain with a low rumble behind it.'],
    ['ocean', 'Ocean', 'Waves that swell and pull back every few seconds.'],
    ['fire', 'Fireplace', 'A warm low burn with small crackles.'],
    ['wind', 'Wind', 'Soft gusts that rise and fall.'],
    ['night', 'Night', 'Crickets over a quiet, still evening.'],
    ['deep', 'Deep hum', 'A smooth low drone, like a far-off engine.']
] as const;
export type Sound = typeof SOUNDS[number][0];
export const isSound = (value: string | null): value is Sound => SOUNDS.some(([id]) => id === value);

let context: AudioContext | null = null;
let master: GainNode | null = null;
let stopCurrent: (() => void) | null = null;
let sceneOut: GainNode | null = null;
let volume = .4;

const buffers: Partial<Record<'white' | 'pink' | 'brown', AudioBuffer>> = {};
// Eight seconds of looped noise; long enough that the loop point isn't audible.
function noise(ctx: AudioContext, colour: 'white' | 'pink' | 'brown') {
    if (buffers[colour]) return buffers[colour]!;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * 8, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (let i = 0; i < data.length; i++) {
        const white = Math.random() * 2 - 1;
        if (colour === 'white') data[i] = white * .5;
        else if (colour === 'brown') { last = (last + .02 * white) / 1.02; data[i] = last * 3.5; }
        else { // Pink: Paul Kellet's economy filter.
            b0 = .99765 * b0 + white * .099046; b1 = .963 * b1 + white * .2965164; b2 = .57 * b2 + white * 1.0526913;
            data[i] = (b0 + b1 + b2 + white * .1848) * .14;
        }
    }
    return buffers[colour] = buffer;
}

// Builds one scene into `out` and returns everything that has to be stopped later.
function build(ctx: AudioContext, kind: Sound, out: AudioNode) {
    const running: AudioScheduledSourceNode[] = [];
    const timers: ReturnType<typeof setInterval>[] = [];
    const source = (colour: 'white' | 'pink' | 'brown') => {
        const node = ctx.createBufferSource();
        node.buffer = noise(ctx, colour);
        node.loop = true;
        node.start(0, Math.random() * 6); // layers start at different points so they never line up
        running.push(node);
        return node;
    };
    const filter = (type: BiquadFilterType, frequency: number, q = .7) => {
        const node = ctx.createBiquadFilter();
        node.type = type; node.frequency.value = frequency; node.Q.value = q;
        return node;
    };
    const gain = (value: number) => { const node = ctx.createGain(); node.gain.value = value; return node; };
    // A slow oscillator nudging a parameter up and down around its resting value.
    const sway = (target: AudioParam, rate: number, depth: number) => {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = rate;
        lfo.connect(gain(depth)).connect(target);
        lfo.start();
        running.push(lfo);
    };
    // A short burst of noise with a fast decay: a raindrop, a crackle, a cricket pulse.
    const burst = (colour: 'white' | 'pink', frequency: number, q: number, level: number, length: number) => {
        const node = ctx.createBufferSource();
        node.buffer = noise(ctx, colour);
        const envelope = gain(0);
        const now = ctx.currentTime;
        envelope.gain.setValueAtTime(level, now);
        envelope.gain.exponentialRampToValueAtTime(.0001, now + length);
        node.connect(filter('bandpass', frequency, q)).connect(envelope).connect(out);
        node.start(now, Math.random() * 7, length + .02);
    };

    if (kind === 'rain') {
        const body = gain(.55);
        source('pink').connect(filter('highpass', 700)).connect(filter('lowpass', 7500)).connect(body).connect(out);
        sway(body.gain, .13, .12); // the shower thickens and thins
        source('brown').connect(filter('lowpass', 260)).connect(gain(.5)).connect(out);
        timers.push(setInterval(() => { if (Math.random() < .7) burst('white', 3000 + Math.random() * 4000, 6, .05 + Math.random() * .08, .05); }, 90));
    } else if (kind === 'ocean') {
        const swell = gain(.4);
        source('brown').connect(filter('lowpass', 520)).connect(swell).connect(out);
        sway(swell.gain, .085, .34); // one wave roughly every twelve seconds
        const foam = gain(.08);
        const wash = filter('bandpass', 1400, .5);
        source('pink').connect(wash).connect(foam).connect(out);
        sway(foam.gain, .085, .07);
        sway(wash.frequency, .085, 600); // the hiss brightens as each wave breaks
    } else if (kind === 'fire') {
        const burn = gain(.5);
        source('brown').connect(filter('lowpass', 240)).connect(burn).connect(out);
        sway(burn.gain, .21, .1);
        source('pink').connect(filter('bandpass', 900, .6)).connect(gain(.05)).connect(out);
        timers.push(setInterval(() => { if (Math.random() < .35) burst('white', 1800 + Math.random() * 3500, 3, .12 + Math.random() * .3, .03 + Math.random() * .06); }, 70));
    } else if (kind === 'wind') {
        const gust = gain(.3);
        const howl = filter('bandpass', 520, 1.4);
        source('pink').connect(howl).connect(gust).connect(out);
        sway(howl.frequency, .06, 260);
        sway(gust.gain, .11, .2);
        source('brown').connect(filter('lowpass', 180)).connect(gain(.3)).connect(out);
    } else if (kind === 'night') {
        source('brown').connect(filter('lowpass', 200)).connect(gain(.22)).connect(out);
        source('pink').connect(filter('highpass', 3000)).connect(gain(.012)).connect(out);
        // Two crickets at slightly different pitches, each chirping in bursts of three pulses.
        for (const pitch of [4300, 4800]) {
            timers.push(setInterval(() => {
                if (Math.random() < .45) return;
                for (let pulse = 0; pulse < 3; pulse++) setTimeout(() => burst('white', pitch, 40, .16, .045), pulse * 62);
            }, 620 + Math.random() * 300));
        }
    } else {
        const hum = gain(.6);
        source('brown').connect(filter('lowpass', 420)).connect(hum).connect(out);
        sway(hum.gain, .05, .08);
    }
    return () => {
        timers.forEach(clearInterval);
        running.forEach(node => { try { node.stop(); } catch { /* already stopped */ } });
    };
}

export function stopSound() {
    if (!stopCurrent || !context) return;
    const stop = stopCurrent, scene = sceneOut!;
    stopCurrent = null;
    // Fade out rather than cut, then tear the scene down.
    scene.gain.setTargetAtTime(0, context.currentTime, .12);
    setTimeout(() => { stop(); scene.disconnect(); }, 600);
}

export function playSound(kind: Sound) {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return false;
    context ??= new AudioCtx();
    if (context.state === 'suspended') context.resume();
    stopSound();
    if (!master) { master = context.createGain(); master.connect(context.destination); }
    master.gain.value = volume;
    sceneOut = context.createGain();
    sceneOut.gain.value = 0;
    sceneOut.gain.setTargetAtTime(1, context.currentTime, .25); // fade in
    sceneOut.connect(master);
    stopCurrent = build(context, kind, sceneOut);
    return true;
}

export function setSoundVolume(value: number) {
    volume = Math.min(1, Math.max(0, value));
    // A short ramp avoids the click of an instant gain change.
    if (master && context) master.gain.setTargetAtTime(volume, context.currentTime, .05);
}

