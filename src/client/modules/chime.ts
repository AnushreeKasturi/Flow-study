// Short synthesized tones for room events. One shared context; every call is a
// courtesy, so failures (autoplay policy, no audio device) are swallowed.
let context: AudioContext | null = null;

const TUNES = {
    join: [523.25, 659.25],             // C5 up to E5: someone arrived
    leave: [659.25, 493.88],            // E5 down to B4: someone left
    done: [659.25, 783.99, 1046.5]      // E5, G5, C6: a session finished
} as const;

export function chime(kind: keyof typeof TUNES) {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        context ??= new AudioCtx();
        if (context.state === 'suspended') context.resume();
        const ctx = context;
        TUNES[kind].forEach((frequency, index) => {
            const start = ctx.currentTime + index * .16;
            const tone = ctx.createOscillator();
            const envelope = ctx.createGain();
            tone.type = 'sine';
            tone.frequency.value = frequency;
            envelope.gain.setValueAtTime(0, start);
            envelope.gain.linearRampToValueAtTime(kind === 'done' ? .28 : .14, start + .02);
            envelope.gain.exponentialRampToValueAtTime(.001, start + .9);
            tone.connect(envelope).connect(ctx.destination);
            tone.start(start);
            tone.stop(start + .95);
        });
    } catch { /* No sound is fine. */ }
}
