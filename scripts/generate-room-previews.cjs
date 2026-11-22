// One room still per sky for the landing page, so the preview wears whatever sky you picked.
//   npm run build && npm run previews:rooms
const { chromium } = require('playwright');
const { once } = require('node:events');
const { mkdirSync, readFileSync, rmSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');
process.env.GROQ_API_KEY = process.env.TWILIO_ACCOUNT_SID = process.env.TWILIO_AUTH_TOKEN = '';
const app = require('../server');

const OUT = resolve(__dirname, '../public/rooms');
// The sky list lives in TypeScript; a regex is cheaper than a compiler for fifteen words.
const SKIES = [...readFileSync(resolve(__dirname, '../src/client/theme.ts'), 'utf8').matchAll(/\['([a-z]+)', '[A-Z]/g)].map(match => match[1]);

async function snap(page, name) {
    await page.waitForTimeout(500);
    const png = resolve(OUT, name + '.png');
    await page.screenshot({ path: png });
    const webp = spawnSync('cwebp', ['-quiet', '-q', '72', png, '-o', resolve(OUT, name + '.webp')]);
    rmSync(png);
    if (webp.status !== 0) throw new Error('cwebp is needed on the PATH to write ' + name + '.webp');
}

(async () => {
    mkdirSync(OUT, { recursive: true });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const browser = await chromium.launch();
    try {
        for (const sky of SKIES) {
            const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
            await context.addInitScript({ path: resolve(__dirname, 'supabase-fixture.js') });
            await context.addInitScript(theme => {
                Object.entries({ flow_theme: theme, flow_signed_in: '1', 'fixture-session': '1', flow_first_session: 'done', flow_named: '1', flow_preview: '0' }).forEach(([key, value]) => localStorage.setItem(key, value));
                if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = async () => { throw new Error('Camera shy'); };
            }, sky);
            const page = await context.newPage();
            await page.goto(origin + '/room.html');
            await page.getByRole('button', { name: 'Create a room', exact: true }).click();
            await page.waitForFunction(() => !document.getElementById('new-task-input').disabled && window.__fixture.handlers['presence:join']);
            // Same cast and homework as scripts/generate-marketing.cjs, so every sky shows the same room.
            await page.evaluate(async () => {
                const fixture = window.__fixture;
                for (const [key, username] of [['zz-1', 'Riya'], ['ab-2', 'Sam'], ['mn-3', 'Inés']]) fixture.handlers['presence:join']({ key, newPresences: [{ username, status: 'Deep Focus', isDummyMedia: true }] });
                for (const title of ['Review chapter 4', 'Practice set, questions 1–10', 'Outline the essay']) {
                    document.getElementById('new-task-input').value = title;
                    document.getElementById('add-task-btn').click();
                    await new Promise(done => setTimeout(done, 250));
                }
                document.querySelector('.task-checkbox').click();
                fixture.handlers['broadcast:timer-updated']({ payload: { mode: 'focus', timeLeft: 16 * 60 + 40, duration: 25 * 60, isRunning: true } });
            });
            await page.waitForTimeout(1800);
            await page.addStyleTag({ content: '.toast { display: none !important; }' }); // the welcome toast doesn't need a portrait
            await snap(page, sky);
            // Chat: a study question, the assistant's answer, and the relief that follows.
            await page.evaluate(() => {
                const say = payload => window.__fixture.handlers['broadcast:chat-message']({ payload });
                say({ sender: 'Riya', from: 'zz-1', text: 'Anyone else stuck on SN1 vs SN2?' });
                say({ sender: 'AI Assistant', from: 'ab-2', question: 'when does SN1 win over SN2?', text: 'SN1 wins with a **tertiary carbon** and a **polar protic solvent**: the carbocation is stable and the solvent holds it there. Crowded carbons block the backside attack SN2 needs.' });
                say({ sender: 'Inés', from: 'mn-3', text: 'ok that finally clicked, thank you' });
            });
            await page.getByRole('tab', { name: /^Chat/ }).click();
            await snap(page, sky + '-chat');
            // Sound: rain on, because it is always raining in a good study session.
            await page.getByRole('tab', { name: 'Sound', exact: true }).click();
            await page.locator('[data-sound]').first().click();
            await snap(page, sky + '-sound');
            await context.close();
        }
        console.log(`Wrote ${SKIES.length * 3} room previews to public/rooms`);
    } finally {
        await browser.close();
        await new Promise(done => server.close(done));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
