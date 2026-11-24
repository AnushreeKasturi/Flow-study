// The weather in setup's window: whatever soundscape you pick, played in the sky. Drawn on a canvas so it can
// look like the real thing (depth, glow, splashes) rather than stripes. Runs only while a sound is picked and the
// tab is visible; with reduced motion it draws one still frame.
type Kind = '' | 'rain' | 'ocean' | 'fire' | 'wind' | 'night' | 'deep';
type P = { x: number; y: number; vx: number; vy: number; size: number; life: number; age: number; depth: number; phase: number };

const rand = (min: number, max: number) => min + Math.random() * (max - min);

export function weather(canvas: HTMLCanvasElement, sun: HTMLElement) {
    const ctx = canvas.getContext('2d')!;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let kind: Kind = '';
    let w = 0, h = 0, frame = 0, last = 0, time = 0;
    let parts: P[] = [], splashes: P[] = [], fireflies: P[] = [];

    const resize = () => {
        const dpr = Math.min(2, devicePixelRatio || 1);
        w = canvas.clientWidth; h = canvas.clientHeight;
        canvas.width = w * dpr; canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        seed();
    };
    const sunCentre = () => {
        const a = sun.getBoundingClientRect(), b = canvas.getBoundingClientRect();
        return { x: a.left + a.width / 2 - b.left, y: a.top + a.height / 2 - b.top, r: a.width / 2 };
    };

    // Each kind starts with a scattering of particles, so it appears already under way rather than starting empty.
    const make = (): P => {
        const depth = Math.random();
        switch (kind) {
            case 'rain': return { x: rand(-40, w + 40), y: rand(-h, h), vx: -60 - depth * 50, vy: 700 + depth * 700, size: 10 + depth * 22, life: 0, age: 0, depth, phase: 0 };
            case 'fire': return { x: rand(w * .1, w * .9), y: h + rand(0, h * .6), vx: rand(-12, 12), vy: -rand(26, 70), size: rand(.7, 2.4), life: rand(3, 7), age: 0, depth, phase: rand(0, 6.28) };
            case 'wind': return { x: rand(-w, w), y: rand(h * .08, h * .92), vx: 260 + depth * 380, vy: 0, size: 80 + depth * 180, life: 0, age: 0, depth, phase: rand(0, 6.28) };
            case 'night': return { x: rand(0, w), y: rand(0, h * .8), vx: 0, vy: 0, size: rand(.4, 1.5), life: 0, age: 0, depth, phase: rand(0, 6.28) };
            default: return { x: 0, y: 0, vx: 0, vy: 0, size: 0, life: 0, age: 0, depth, phase: 0 };
        }
    };
    const count = () => ({ rain: Math.round(w * h / 900), fire: Math.round(w / 9), wind: 26, night: Math.round(w * h / 2600) } as Record<string, number>)[kind] ?? 0;
    function seed() {
        parts = Array.from({ length: count() }, make);
        if (kind === 'fire') parts.forEach(p => { p.age = rand(0, p.life); p.y = h - p.age * -p.vy * .8; });
        if (kind === 'night') fireflies = Array.from({ length: 9 }, () => ({ ...make(), y: rand(h * .7, h * .98), size: rand(1.2, 2.2), vx: rand(-8, 8), vy: rand(-4, 4) }));
        splashes = [];
    }

    function draw(dt: number) {
        ctx.clearRect(0, 0, w, h);
        if (kind === 'rain') {
            // A grey veil, then three depths of streaks: far ones short and faint, near ones long and bright.
            ctx.fillStyle = 'rgba(40, 48, 60, .18)'; ctx.fillRect(0, 0, w, h);
            ctx.lineCap = 'round';
            for (const p of parts) {
                p.x += p.vx * dt; p.y += p.vy * dt;
                if (p.y > h) {
                    if (p.depth > .8 && splashes.length < 24) splashes.push({ ...p, y: h - rand(1, 6), age: 0, life: .35 });
                    Object.assign(p, make(), { y: rand(-60, -10) });
                }
                const len = p.size, dx = p.vx / p.vy * len;
                const g = ctx.createLinearGradient(p.x, p.y - len, p.x + dx, p.y);
                g.addColorStop(0, 'rgba(220, 230, 245, 0)');
                g.addColorStop(1, `rgba(220, 230, 245, ${.12 + p.depth * .38})`);
                ctx.strokeStyle = g; ctx.lineWidth = .6 + p.depth * 1.1;
                ctx.beginPath(); ctx.moveTo(p.x - dx, p.y - len); ctx.lineTo(p.x, p.y); ctx.stroke();
            }
            // Splashes on the horizon: a small widening arc for each near drop that lands.
            for (const s of splashes) {
                s.age += dt;
                const t = s.age / s.life;
                ctx.strokeStyle = `rgba(225, 235, 250, ${(1 - t) * .3})`; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.ellipse(s.x, s.y, 2 + t * 9, 1 + t * 2.5, 0, Math.PI, 0); ctx.stroke();
            }
            splashes = splashes.filter(s => s.age < s.life);
        } else if (kind === 'ocean') {
            // Three swells, far to near: each a sum of slow waves, filled darker toward the viewer, with foam on the crest.
            for (let layer = 0; layer < 3; layer++) {
                const base = h - (3 - layer) * Math.max(8, h * .035), amp = 3 + layer * 3.5, speed = .35 + layer * .25;
                ctx.beginPath(); ctx.moveTo(0, h);
                const crest: [number, number][] = [];
                for (let x = 0; x <= w + 8; x += 8) {
                    const y = base + Math.sin(x * .012 + time * speed + layer) * amp + Math.sin(x * .031 - time * speed * 1.7) * amp * .45;
                    crest.push([x, y]); ctx.lineTo(x, y);
                }
                ctx.lineTo(w, h); ctx.closePath();
                ctx.fillStyle = `rgba(${8 + layer * 4}, ${22 + layer * 8}, ${38 + layer * 10}, ${.32 + layer * .16})`; ctx.fill();
                ctx.beginPath(); crest.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
                ctx.strokeStyle = `rgba(235, 245, 255, ${.1 + layer * .1})`; ctx.lineWidth = 1 + layer * .5; ctx.stroke();
            }
        } else if (kind === 'fire') {
            // A low warm glow, and embers that rise, sway, flicker and burn out.
            const glow = ctx.createLinearGradient(0, h, 0, h * .45);
            glow.addColorStop(0, 'rgba(255, 120, 40, .28)'); glow.addColorStop(1, 'rgba(255, 120, 40, 0)');
            ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'lighter';
            for (const p of parts) {
                p.age += dt;
                if (p.age > p.life || p.y < -10) { Object.assign(p, make(), { y: h + rand(0, 20) }); continue; }
                p.x += (p.vx + Math.sin(time * 2 + p.phase) * 14) * dt; p.y += p.vy * dt;
                const t = p.age / p.life, flicker = .65 + Math.sin(time * 18 + p.phase) * .35;
                const a = (t < .15 ? t / .15 : 1 - (t - .15) / .85) * flicker;
                const r = p.size * (1 - t * .5);
                const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 5);
                g.addColorStop(0, `rgba(255, 236, 190, ${a})`); g.addColorStop(.25, `rgba(255, 160, 60, ${a * .7})`); g.addColorStop(1, 'rgba(255, 90, 20, 0)');
                ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, r * 5, 0, 6.29); ctx.fill();
            }
            ctx.globalCompositeOperation = 'source-over';
        } else if (kind === 'wind') {
            // Faint wisps: long curves that taper at both ends, blown across at different depths.
            for (const p of parts) {
                p.x += p.vx * dt;
                if (p.x - p.size > w) Object.assign(p, make(), { x: -p.size - rand(0, w * .5) });
                const lift = Math.sin(time * 1.3 + p.phase) * 10;
                const g = ctx.createLinearGradient(p.x - p.size, 0, p.x, 0);
                g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(.6, `rgba(255,255,255,${.05 + p.depth * .16})`); g.addColorStop(1, 'rgba(255,255,255,0)');
                ctx.strokeStyle = g; ctx.lineWidth = .7 + p.depth;
                ctx.beginPath(); ctx.moveTo(p.x - p.size, p.y);
                ctx.bezierCurveTo(p.x - p.size * .6, p.y - 8 + lift, p.x - p.size * .3, p.y + 8 - lift, p.x, p.y + lift * .4); ctx.stroke();
            }
        } else if (kind === 'night') {
            // A darker sky, stars that twinkle at their own pace, and fireflies drifting low over the ground.
            ctx.fillStyle = 'rgba(2, 4, 14, .42)'; ctx.fillRect(0, 0, w, h);
            for (const p of parts) {
                const a = .35 + .65 * (.5 + .5 * Math.sin(time * (.8 + p.depth * 2.2) + p.phase));
                ctx.fillStyle = `rgba(255, 255, 255, ${a * (.4 + p.depth * .6)})`;
                ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 6.29); ctx.fill();
            }
            ctx.globalCompositeOperation = 'lighter';
            for (const f of fireflies) {
                f.x += (f.vx + Math.sin(time + f.phase) * 6) * dt; f.y += (f.vy + Math.cos(time * .7 + f.phase) * 4) * dt;
                if (f.x < 0 || f.x > w) f.vx *= -1;
                f.y = Math.min(h - 2, Math.max(h * .62, f.y));
                const a = Math.max(0, Math.sin(time * 1.4 + f.phase));
                const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.size * 7);
                g.addColorStop(0, `rgba(230, 255, 150, ${a})`); g.addColorStop(1, 'rgba(160, 255, 90, 0)');
                ctx.fillStyle = g; ctx.beginPath(); ctx.arc(f.x, f.y, f.size * 7, 0, 6.29); ctx.fill();
            }
            ctx.globalCompositeOperation = 'source-over';
        } else if (kind === 'deep') {
            // A low drone: faint rings leaving the sun, slowly, one after another, and a soft halo that breathes.
            const { x, y, r } = sunCentre();
            for (let i = 0; i < 4; i++) {
                const t = ((time * .22 + i / 4) % 1);
                ctx.strokeStyle = `rgba(255, 255, 255, ${(1 - t) * .28})`; ctx.lineWidth = 1.2 + (1 - t) * 1.2;
                ctx.beginPath(); ctx.arc(x, y, r * (1.05 + t * 2.2), 0, 6.29); ctx.stroke();
            }
            const halo = ctx.createRadialGradient(x, y, r, x, y, r * (2.2 + Math.sin(time * .9) * .2));
            halo.addColorStop(0, 'rgba(255,255,255,.14)'); halo.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, 6.29); ctx.fill();
        }
    }

    function tick(now: number) {
        const dt = Math.min(.05, (now - last) / 1000 || 0);
        last = now; time += dt;
        draw(dt);
        frame = requestAnimationFrame(tick);
    }
    const run = () => {
        cancelAnimationFrame(frame);
        if (!kind || document.hidden) return ctx.clearRect(0, 0, w, h);
        if (still) { time = 2; return draw(0); }
        last = performance.now(); frame = requestAnimationFrame(tick);
    };

    new ResizeObserver(() => { resize(); run(); }).observe(canvas);
    document.addEventListener('visibilitychange', run);
    return (next: string) => { kind = next as Kind; seed(); run(); };
}
