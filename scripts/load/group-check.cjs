// A real group session, end to end: real browsers (fake cameras), real Supabase Realtime,
// the real database. Run against the load-test project only (see README.md), with a build
// of the site pointed at it:
//
//   node scripts/load/group-check.cjs
//
// One host starts the timer, two people join mid-block, tasks and statuses change, a short
// block ends with everyone there, and the host steps away. It reports whether every clock
// agreed and kept running, any false "left" notes, and how long newcomers took to appear.
const { chromium } = require('playwright');
const config = require('../../supabase.config.json');

const URL = config.url;
const KEY = config.publishableKey;
const PASSWORD = process.env.LOAD_PASSWORD;
if (!PASSWORD) throw new Error('Set LOAD_PASSWORD (see README.md)');
if (/mrjtkxwenqswbjplmzko/.test(URL)) throw new Error('supabase.config.json points at production. Build against the load-test project for this check.');
const ref = new globalThis.URL(URL).hostname.split('.')[0];

const report = { steps: [], problems: [] };
const step = (text, ok, detail) => { report.steps.push({ ok, text, ...(detail !== undefined ? { detail } : {}) }); if (!ok) report.problems.push(text); console.log(`${ok ? '✅' : '❌'} ${text}${detail !== undefined ? ' ' + JSON.stringify(detail) : ''}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function signIn(n) {
    const response = await fetch(`${URL}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `load${String(n).padStart(4, '0')}@example.test`, password: PASSWORD }) });
    if (!response.ok) throw new Error(`Sign-in failed for load${n}: ${response.status}`);
    return response.json();
}

async function person(browser, origin, n, name) {
    const session = await signIn(n);
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera', 'microphone'] });
    // Signed in the way the site stores it, so the check skips the login page (and its captcha).
    await context.addInitScript(({ key, value }) => { try { localStorage.setItem(key, value); localStorage.setItem('flow_named', '1'); localStorage.setItem('flow_signed_in', '1'); } catch { /* about:blank */ } },
        { key: `sb-${ref}-auth-token`, value: JSON.stringify({ ...session, expires_at: Math.floor(Date.now() / 1000) + session.expires_in }) });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/room.html');
    await page.locator('#room-code-input').waitFor();
    return { page, name, id: session.user.id, errors };
}

// The clock as each person sees it, in seconds, plus whether it's running.
const clock = page => page.evaluate(() => {
    const [m, s] = document.getElementById('time-display').textContent.trim().split(':').map(Number);
    return { left: m * 60 + s, running: document.getElementById('timer-toggle-btn').getAttribute('aria-pressed') === 'true', mode: document.body.dataset.timer || '' };
});
const notes = page => page.evaluate(() => document.getElementById('notify')?.textContent ?? document.body.textContent);

// Watches everyone's clock once a second: they should agree, keep running, and only count down.
async function watch(people, seconds, label) {
    let worstGap = 0, stops = 0, jumps = 0;
    let previous = null;
    for (let i = 0; i < seconds; i++) {
        const now = await Promise.all(people.map(p => clock(p.page)));
        const lefts = now.map(c => c.left);
        worstGap = Math.max(worstGap, Math.max(...lefts) - Math.min(...lefts));
        stops += now.filter(c => !c.running).length;
        if (previous) now.forEach((c, k) => { const step = previous[k].left - c.left; if (c.mode === previous[k].mode && (step < 0 || step > 3)) jumps++; });
        previous = now;
        await sleep(1000);
    }
    step(`${label}: every clock agreed, ran and counted down for ${seconds} s`, worstGap <= 2 && stops === 0 && jumps === 0, { worstGapSeconds: worstGap, stoppedReadings: stops, jumps });
}

// Blocks here are a minute long, so an end-of-block note can open at any moment; close it first.
const dismiss = page => page.evaluate(() => { const modal = document.getElementById('timer-alert-modal'); if (modal && !modal.classList.contains('hidden')) document.getElementById('close-timer-alert-btn').click(); });

async function join(p, code) {
    const began = Date.now();
    await p.page.locator('#room-code-input').fill(code);
    await p.page.getByRole('button', { name: 'Join room', exact: true }).click();
    // Whichever comes first: the camera preview, or the room itself.
    await p.page.waitForFunction(() => !document.getElementById('preview-modal').classList.contains('hidden') || !document.getElementById('app').classList.contains('hidden'), undefined, { timeout: 20000 });
    if (await p.page.getByRole('heading', { name: 'Ready to join?' }).isVisible()) {
        await p.page.waitForFunction(() => !document.getElementById('preview-join').disabled);
        await p.page.getByRole('button', { name: 'Join now', exact: true }).click();
    }
    await p.page.locator('#new-task-input').waitFor({ state: 'visible' });
    return began;
}
// How long until `who` sees `whom`'s tile, and their video playing.
async function appears(who, whom, since) {
    await who.page.waitForFunction(id => document.getElementById('video-wrapper-' + id), whom.id, { timeout: 30000 });
    const tile = Date.now() - since;
    const video = await who.page.waitForFunction(id => { const v = document.querySelector(`#video-wrapper-${id} video`); return v && v.videoWidth > 0 && !v.paused; }, whom.id, { timeout: 30000 }).then(() => Date.now() - since, () => null);
    return { tileMs: tile, videoMs: video };
}

(async () => {
    let server, origin = process.env.FLOW_SITE;
    if (!origin) {
        const app = require('../../server');
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        origin = `http://127.0.0.1:${server.address().port}`;
    }
    const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    try {
        var host = await person(browser, origin, 1, 'Host');
        var b = await person(browser, origin, 2, 'B');
        var c = await person(browser, origin, 3, 'C');
        await host.page.evaluate(() => localStorage.setItem('flow_preview', '0'));

        // The host opens a private room and starts a 1-minute focus block, with 1-minute breaks.
        await host.page.getByRole('button', { name: 'Create a room', exact: true }).click();
        await host.page.locator('#new-task-input').waitFor({ state: 'visible' });
        const code = (await host.page.locator('#header-room-code').innerText()).trim().slice(-6);
        await host.page.getByRole('button', { name: 'Timer settings', exact: true }).click();
        await host.page.getByLabel('Focus (minutes)', { exact: true }).fill('1');
        await host.page.getByLabel('Short break (minutes)', { exact: true }).fill('1');
        await host.page.getByRole('button', { name: 'Save Changes', exact: true }).click();
        await host.page.getByRole('button', { name: 'Start timer', exact: true }).click();
        step('The host can start the timer', await host.page.locator('#timer-toggle-btn').getAttribute('aria-pressed') === 'true');
        await sleep(12000);

        // B joins mid-block, through the camera preview.
        const bJoined = await join(b, code);
        const [hostSeesB, bSeesHost] = await Promise.all([appears(host, b, bJoined), appears(b, host, bJoined)]);
        step('B appears to the host, and the host to B', hostSeesB.tileMs < 10000 && bSeesHost.tileMs < 10000, { hostSeesB, bSeesHost });
        const [hc, bc] = await Promise.all([clock(host.page), clock(b.page)]);
        step('B arrives in step with the room\'s running block', bc.running && Math.abs(hc.left - bc.left) <= 2, { host: hc, b: bc });
        step('B is a guest: the timer controls are dimmed, and it says who runs them', await b.page.locator('#timer-toggle-btn').isDisabled() && (await b.page.locator('#timer-runner').innerText()).includes('runs the timer'));

        // B changes tasks and status while the clock runs: each re-sends presence.
        const churn = (async () => {
            for (let i = 0; i < 3; i++) {
                await b.page.locator('#new-task-input').fill(`Task ${i}`);
                await b.page.locator('#new-task-input').press('Enter');
                await sleep(1500);
            }
            await b.page.getByRole('button', { name: 'Be right back', exact: true }).click();
            await sleep(3000);
            await b.page.getByRole('button', { name: 'I’m back', exact: true }).click();
        })();
        await watch([host, b], 12, 'Two people while B changes tasks and steps away');
        await churn;

        // C joins too.
        const cJoined = await join(c, code);
        const seen = await Promise.all([appears(host, c, cJoined), appears(b, c, cJoined), appears(c, host, cJoined), appears(c, b, cJoined)]);
        step('C appears to everyone, and everyone to C', seen.every(s => s.tileMs < 10000), seen);

        // The block ends with all three there: everyone moves to the break together, and it runs.
        const before = await clock(host.page);
        await sleep((before.left + 3) * 1000);
        const after = await Promise.all([host, b, c].map(p => clock(p.page)));
        step('The block ends for everyone at once, and the break starts by itself', after.every(a => a.mode === 'break' && a.running), after);
        await watch([host, b, c], 10, 'Three people in the break');
        // Everyone closes the end-of-block note, as a person would.
        for (const p of [host, b, c]) await p.page.getByRole('button', { name: 'Continue', exact: true }).click().catch(() => {});

        // The host steps away: someone else takes over the timer.
        await dismiss(host.page);
        await host.page.getByRole('button', { name: 'Leave', exact: true }).click();
        await host.page.getByRole('button', { name: 'Step away', exact: true }).click();
        const takeover = await Promise.race([
            b.page.waitForFunction(() => !document.getElementById('timer-toggle-btn').disabled, undefined, { timeout: 60000 }).then(() => 'B'),
            c.page.waitForFunction(() => !document.getElementById('timer-toggle-btn').disabled, undefined, { timeout: 60000 }).then(() => 'C')
        ]).catch(() => null);
        step('When the host steps away, someone else can run the timer', !!takeover, { standIn: takeover });
        if (takeover) {
            const standIn = takeover === 'B' ? b : c, other = takeover === 'B' ? c : b;
            await dismiss(standIn.page);
            await standIn.page.getByRole('button', { name: 'Pause timer', exact: true }).click();
            await other.page.waitForFunction(() => document.getElementById('timer-toggle-btn').getAttribute('aria-pressed') === 'false', undefined, { timeout: 10000 }).catch(() => {});
            step('The stand-in pauses it for everyone', !(await clock(other.page)).running);
        }

        // Nobody was ever said to have left while they were there. (The host really did leave
        // when stepping away, so a note about the host after that is true.)
        const leftNotes = await Promise.all([b, c].map(p => p.page.evaluate(() => [...(document.getElementById('notify')?.textContent ?? '').matchAll(/(Load \d{4}|Someone) left the room/g)].map(m => m[1]))));
        const stayed = ['Load 0002', 'Load 0003'];
        const falseOnes = leftNotes.flat().filter(name => stayed.includes(name));
        const joinedNotes = await b.page.evaluate(() => (document.getElementById('notify')?.textContent ?? '').match(/joined the room/g)?.length ?? 0);
        step('No false "left the room" notes about anyone still there', falseOnes.length === 0 && joinedNotes > 0, { notesInB: leftNotes[0], notesInC: leftNotes[1], joinNotesSeenByB: joinedNotes });
        const pageErrors = [host, b, c].flatMap(p => p.errors);
        step('No errors in any page', pageErrors.length === 0, pageErrors.slice(0, 5));
    } catch (error) {
        step('The check ran to the end', false, error.message.split('\n')[0]);
        // What each person was looking at when it stopped.
        for (const p of [host, b, c].filter(Boolean)) await p.page.screenshot({ path: `output/group-check-${p.name}.png` }).catch(() => {});
    } finally {
        await browser.close();
        server?.close();
        console.log(report.problems.length ? `\n${report.problems.length} problem(s).` : '\nEverything held.');
        process.exitCode = report.problems.length ? 1 : 0;
    }
})();
