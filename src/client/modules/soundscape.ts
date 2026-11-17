// Ambient soundscapes, synthesized in the browser: no audio files, nothing
// streamed, nothing shared. Each scene shapes looping noise with filters and
// slow modulation so it moves like the real thing instead of sitting as hiss.
export const SOUNDS = [
    ['rain', 'Rain', 'Steady rain with a low rumble behind it.'],
    ['ocean', 'Ocean', 'Waves that swell and pull back every few seconds.'],
    ['fire', 'Fireplace', 'Flickering flames with crackles and the odd pop.'],
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
    // A parameter wandering to a new random level now and then, so it moves like weather or
    // flame rather than a smooth, regular wave.
    const wander = (target: AudioParam, base: number, depth: number, perSecond: number) => {
        target.value = base;
        scatter(perSecond, at => target.setTargetAtTime(base + (Math.random() * 2 - 1) * depth, at, .3 / perSecond));
    };
    // Short sounds at random moments, about `perSecond` of them. They're scheduled on the audio
    // clock up to 1.5 s ahead, so they stay even when the browser slows timers in a background tab.
    const scatter = (perSecond: number, play: (at: number) => void) => {
        let next = ctx.currentTime + .05;
        const fill = () => {
            for (next = Math.max(next, ctx.currentTime); next < ctx.currentTime + 1.5; next += -Math.log(1 - Math.random()) / perSecond) play(next);
        };
        fill();
        timers.push(setInterval(fill, 250));
    };
    // A burst of noise with a sharp start and a fast decay, through a band-pass: a 3 ms burst
    // is a crackle, 20 ms a raindrop, 45 ms at a narrow band a cricket pulse.
    const burst = (at: number, seconds: number, level: number, frequency: number, q: number) => {
        const length = Math.max(16, Math.round(ctx.sampleRate * seconds));
        const buffer = ctx.createBuffer(1, length, ctx.sampleRate), data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-6 * i / length);
        const node = ctx.createBufferSource();
        node.buffer = buffer;
        node.connect(filter('bandpass', frequency, q)).connect(gain(level)).connect(out);
        node.start(at);
    };

    if (kind === 'rain') {
        const body = gain(.8);
        source('pink').connect(filter('highpass', 700)).connect(filter('lowpass', 7500)).connect(body).connect(out);
        wander(body.gain, .8, .17, .4); // the shower thickens and thins
        source('brown').connect(filter('lowpass', 260)).connect(gain(.12)).connect(out);
        scatter(14, at => burst(at, .012 + Math.random() * .02, .3 + Math.random() * .4, 2500 + Math.random() * 4500, 1.5));
    } else if (kind === 'ocean') {
        const swell = gain(.4);
        source('brown').connect(filter('lowpass', 520)).connect(swell).connect(out);
        sway(swell.gain, .085, .3); // one wave roughly every twelve seconds
        const foam = gain(.2);
        const wash = filter('bandpass', 1400, .5);
        source('pink').connect(wash).connect(foam).connect(out);
        sway(foam.gain, .085, .16);
        sway(wash.frequency, .085, 600); // the hiss brightens as each wave breaks
    } else if (kind === 'fire') {
        // The flames: a rushing, mostly mid-range roar that flickers.
        const roar = gain(.5);
        source('pink').connect(filter('highpass', 180)).connect(filter('lowpass', 2400)).connect(roar).connect(out);
        wander(roar.gain, .5, .22, 5);
        // Only a little low warmth, and a faint sizzle on top.
        source('brown').connect(filter('lowpass', 150)).connect(gain(.08)).connect(out);
        const sizzle = gain(.05);
        source('white').connect(filter('highpass', 5000)).connect(sizzle).connect(out);
        wander(sizzle.gain, .05, .03, 6);
        // Crackles: tiny sharp snaps, often in quick clusters.
        scatter(7, at => {
            const count = Math.random() < .35 ? 2 + Math.floor(Math.random() * 4) : 1;
            for (let k = 0, t = at; k < count; k++, t += .004 + Math.random() * .03) burst(t, .002 + Math.random() * .004, .5 + Math.random() * .8, 2000 + Math.random() * 5000, .7);
        });
        // Pops: now and then a louder, lower snap from a knot in the wood.
        scatter(.3, at => burst(at, .012 + Math.random() * .01, 1 + Math.random() * .5, 700 + Math.random() * 600, .9));
    } else if (kind === 'wind') {
        const gust = gain(.55);
        const howl = filter('bandpass', 520, 1.4);
        source('pink').connect(howl).connect(gust).connect(out);
        wander(howl.frequency, 520, 260, .3);
        wander(gust.gain, .55, .3, .35);
        source('brown').connect(filter('lowpass', 180)).connect(gain(.2)).connect(out);
    } else if (kind === 'night') {
        source('brown').connect(filter('lowpass', 200)).connect(gain(.1)).connect(out);
        source('pink').connect(filter('highpass', 3000)).connect(gain(.03)).connect(out);
        // Two crickets at slightly different pitches, each chirping in bursts of three pulses.
        for (const pitch of [4300, 4800]) {
            scatter(.9, at => { for (let pulse = 0; pulse < 3; pulse++) burst(at + pulse * .062, .045, 1, pitch, 40); });
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

