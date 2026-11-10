const { chromium } = require('playwright');
const { once } = require('node:events');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { Script } = require('node:vm');
const { build } = require('esbuild');
process.env.GROQ_API_KEY = '';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.TWILIO_AUTH_TOKEN = '';
const app = require('../server');

(async () => {
    mkdirSync('output/playwright', { recursive: true });
    const externalOrigin = process.env.FLOW_TEST_ORIGIN ? new URL(process.env.FLOW_TEST_ORIGIN).origin : null;
    const server = externalOrigin ? null : app.listen(0, '127.0.0.1');
    let browser, context, page;
    const watchdog = setTimeout(() => {
        console.error('Browser suite exceeded its three-minute limit');
        process.exitCode = 1;
        browser?.close();
        server?.close();
    }, 180000);
    watchdog.unref();
    const errors = [];
    try {
        if (server) await once(server, 'listening');
        browser = await chromium.launch({
            headless: true,
            ...(process.env.FLOW_TEST_BROWSER_EXECUTABLE ? { executablePath: process.env.FLOW_TEST_BROWSER_EXECUTABLE } : {})
        });
        context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
        await context.route('**/_vercel/speed-insights/**', route => route.fulfill({ body: '', contentType: 'text/javascript' }));
        // Compile the real RTC module with only signalling stubbed. Never ship this test route.
        const rtcHarness = await build({
            entryPoints: ['src/client/modules/rtc.ts'], bundle: true, write: false, format: 'esm',
            plugins: [{ name: 'rtc-test-signalling', setup(builder) {
                builder.onResolve({ filter: /^\.\/(socket|api)$/ }, args => ({ path: args.path, namespace: 'test' }));
                builder.onLoad({ filter: /socket$/, namespace: 'test' }, () => ({
                    contents: "export const getMyUserId = () => 'test-user'; export const sendSignal = (to, signal) => window.__fixture.calls.push({ value: { payload: { to, from: 'test-user', signal } } });"
                }));
                builder.onLoad({ filter: /api$/, namespace: 'test' }, () => ({
                    contents: "export const api = (path, body, timeoutMs) => fetch(path, { method: 'POST', signal: AbortSignal.timeout(timeoutMs) });"
                }));
            } }]
        });
        await context.route('**/__flow-test/rtc.js*', route => route.fulfill({ body: rtcHarness.outputFiles[0].text, contentType: 'text/javascript' }));
        await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
        page = await context.newPage();
        page.setDefaultTimeout(15000);
        page.on('pageerror', error => errors.push(error.message));
        const origin = externalOrigin || 'http://127.0.0.1:' + server.address().port;
        await page.route(origin + '/login.html', route => route.fulfill({ body: '<!doctype html><title>Flow test setup</title>', contentType: 'text/html' }), { times: 1 });
        await page.goto(origin + '/login.html');
        const results = {};
        for (const file of ['scripts/ui-smoke.js', 'scripts/tools-layout.js']) {
            const run = new Script(readFileSync(file, 'utf8'), { filename: file }).runInThisContext();
            results[file] = await run(page);
        }
        if (errors.length) throw new Error('Uncaught browser errors: ' + errors.join('; '));
        writeFileSync('output/playwright/results.json', JSON.stringify(results, null, 2));
        await context.tracing.stop();
        console.log(JSON.stringify(results, null, 2));
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
        if (page) await page.screenshot({ path: 'output/playwright/failure.png', fullPage: true }).catch(() => {});
        if (context) await context.tracing.stop({ path: 'output/playwright/failure-trace.zip' }).catch(() => {});
    } finally {
        clearTimeout(watchdog);
        await browser?.close();
        if (server) await new Promise(resolve => server.close(resolve));
    }
})();
