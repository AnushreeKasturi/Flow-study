// Renders the launch kit's images from the real site: 1600 × 900 stills (the 16:9
// shape X/Twitter and LinkedIn show without cropping) and a short demo GIF.
// Uses the production build with the offline fixture, so nothing here touches real data.
//   npm run build && npm run marketing:images
const { chromium } = require('playwright');
const { once } = require('node:events');
const { mkdirSync, rmSync, readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
process.env.GROQ_API_KEY = process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_AUTH_TOKEN = '';
const app = require('../server');

const OUT = resolve(__dirname, '../marketing/images');
const SKY = process.env.FLOW_MARKETING_SKY || 'warm';

(async () => {
    mkdirSync(OUT, { recursive: true });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch();
    const prepare = async context => {
        await context.addInitScript({ path: resolve(__dirname, 'supabase-fixture.js') });
        await context.addInitScript(sky => {
            localStorage.setItem('flow_theme', sky);
            localStorage.setItem('flow_signed_in', '1');
            localStorage.setItem('fixture-session', '1');
            localStorage.setItem('flow_first_session', 'done');
            sessionStorage.setItem('flow_intro', '1');
            if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error('No camera for stills'); };
        }, SKY);
    };
    try {
        const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
        await prepare(context);
        const page = await context.newPage();
        const shot = name => page.screenshot({ path: resolve(OUT, name + '.png') });

        await page.goto(origin + '/');
        await page.waitForTimeout(600);
        await shot('landing');

        await page.goto(origin + '/start.html');
        await page.getByLabel('Your name').fill('Alex');
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('button', { name: 'Continue', exact: true }).click();
        await page.getByRole('button', { name: '45 min', exact: true }).click();
        await page.waitForTimeout(900);
        await shot('setup-drag-the-sun');

        // Home, where you land after signing in, with the board seeded so it has open groups to show.
        await page.goto(origin + '/room.html?board');
        await page.getByRole('button', { name: /^Take a seat in / }).first().waitFor();
        await page.waitForTimeout(600);
        await shot('home');

        await page.goto(origin + '/room.html');
        await page.getByRole('button', { name: 'Create a room', exact: true }).click();
        await page.waitForFunction(() => !document.getElementById('new-task-input').disabled);
        await page.evaluate(async () => {
            const fixture = window.__fixture;
            for (const [key, username, status] of [['zz-1', 'Riya', 'Deep Focus'], ['ab-2', 'Sam', 'Deep Focus'], ['mn-3', 'Inés', 'Deep Focus']]) {
                fixture.handlers['presence:join']({ key, newPresences: [{ username, status, isDummyMedia: true }] });
            }
            for (const title of ['Review chapter 4', 'Practice set, questions 1–10', 'Outline the essay']) {
                document.getElementById('new-task-input').value = title;
                document.getElementById('add-task-btn').click();
                await new Promise(done => setTimeout(done, 250));
            }
            document.querySelector('.task-checkbox').click();
            fixture.handlers['broadcast:timer-updated']({ payload: { mode: 'focus', timeLeft: 16 * 60 + 40, duration: 25 * 60, isRunning: true } });
        });
        await page.waitForTimeout(1800);
        await shot('room');
        await page.getByRole('button', { name: 'Toggle Focus Mode', exact: true }).click();
        await page.waitForTimeout(1200);
        await shot('focus-mode');

        await page.goto(origin + '/groups.html?board');
        await page.locator('.group').first().waitFor();
        await page.evaluate(() => window.scrollTo(0, 150));
        await shot('study-groups');
        await context.close();

        // Demo GIF: a 25-minute focus block played in ten seconds on the landing page.
        const video = resolve(OUT, 'video');
        rmSync(video, { recursive: true, force: true });
        const recording = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: video, size: { width: 1280, height: 720 } } });
        await prepare(recording);
        const demo = await recording.newPage();
        await demo.goto(origin + '/');
        await demo.waitForTimeout(900);
        await demo.getByRole('button', { name: 'Play the demo', exact: true }).click();
        await demo.waitForTimeout(12200);
        await recording.close();
        const webm = resolve(video, readdirSync(video)[0]);
        const gif = spawnSync('ffmpeg', ['-y', '-ss', '0.6', '-i', webm, '-vf', 'fps=12,scale=800:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', resolve(OUT, 'demo.gif')], { stdio: 'ignore' });
        rmSync(video, { recursive: true, force: true });
        console.log(gif.status === 0 ? 'Wrote stills and demo.gif to marketing/images' : 'Wrote stills. demo.gif needs ffmpeg on the PATH; it was skipped.');
    } finally {
        await browser.close();
        await new Promise(done => server.close(done));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
