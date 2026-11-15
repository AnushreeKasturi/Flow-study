const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.GROQ_API_KEY = '';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.TWILIO_AUTH_TOKEN = '';
const http = require('node:http');
const { once } = require('node:events');
test('HTTP boundaries and bounded local concurrency', async t => {
    // Stand-in for Supabase's token check: only the bearer token "valid" belongs to a user.
    // Stand-in for Supabase. Only the bearer token "valid" belongs to a user; the quota
    // function allows every call except for the token "spent".
    let quotaInstalled = true;
    const quotaCalls = [];
    const auth = http.createServer(async (req, res) => {
        const token = (req.headers.authorization || '').replace('Bearer ', '');
        const known = ['valid', 'spent'].includes(token) && req.headers.apikey;
        quotaCalls.push(req.url);
        // The server's own quota call (sql/016): only the service key may make it.
        if (req.url === '/rest/v1/rpc/api_allow_for') {
            let body = '';
            for await (const chunk of req) body += chunk;
            if (req.headers.apikey !== 'service-test' || token !== 'service-test') return res.writeHead(401).end('{}');
            return res.writeHead(200, { 'Content-Type': 'application/json' }).end(String(JSON.parse(body).p_user === 'user-valid'));
        }
        if (req.url === '/auth/v1/user' && known) return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id: 'user-' + token }));
        if (req.url === '/rest/v1/rpc/api_allow') {
            if (!quotaInstalled) return res.writeHead(404).end('{}');
            return res.writeHead(known ? 200 : 401, { 'Content-Type': 'application/json' }).end(known ? String(token === 'valid') : '{}');
        }
        res.writeHead(req.url === '/auth/v1/user' && known ? 200 : 401).end('{}');
    }).listen(0, '127.0.0.1');
    await once(auth, 'listening');
    process.env.PUBLIC_SUPABASE_URL = 'http://127.0.0.1:' + auth.address().port;
    const app = require('../api/ai');
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(() => auth.close(resolve))));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const post = (body, token = 'valid') => fetch(origin + '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body });

    await t.test('HTML, CSS, modules, missing files, and private files', async () => {
        for (const path of ['/', '/start.html', '/login.html', '/room.html', '/groups.html', '/docs.html', '/verify.html', '/favicon.svg', '/room-preview.webp']) assert.equal((await fetch(origin + path)).status, 200, path);
        const html = await (await fetch(origin + '/login.html')).text();
        const asset = html.match(/src="([^"]+\.js)"/)[1];
        assert.equal((await fetch(origin + asset)).status, 200);
        for (const path of ['/src/client/app.ts', '/.env', '/sql/schema.sql', '/package.json', '/missing.html']) assert.equal((await fetch(origin + path)).status, 404, path);
    });
    await t.test('link crawlers receive static metadata and a public preview image', async () => {
        const expected = {
            'og:type': 'website',
            'og:site_name': 'Flow',
            'og:title': 'Flow | Study better, together',
            'og:image': 'https://flow-study.me/social-preview-lake.jpg',
            'og:image:type': 'image/jpeg',
            'og:image:width': '1200',
            'og:image:height': '630',
            'twitter:card': 'summary_large_image',
            'twitter:image': 'https://flow-study.me/social-preview-lake.jpg'
        };
        // Every public page points at itself; the room (also served for /?room=)
        // is behind a login and keeps the home page.
        const canonicalFor = {
            '/': 'https://flow-study.me/',
            '/start.html': 'https://flow-study.me/start.html',
            '/login.html': 'https://flow-study.me/login.html',
            '/groups.html': 'https://flow-study.me/groups.html',
            '/docs.html': 'https://flow-study.me/docs.html',
            '/?room=FOCUS6': 'https://flow-study.me/'
        };
        const crawler = { headers: { 'User-Agent': 'facebookexternalhit/1.1' } };
        for (const [path, canonical] of Object.entries(canonicalFor)) {
            const response = await fetch(origin + path, crawler);
            assert.equal(response.status, 200);
            const head = (await response.text()).split('</head>')[0];
            for (const [key, value] of Object.entries(expected)) {
                const tags = [...head.matchAll(new RegExp('<meta (?:property|name)="' + key + '" content="([^"]+)"', 'g'))];
                assert.equal(tags.length, 1, path + ': ' + key);
                assert.equal(tags[0][1], value, path + ': ' + key);
            }
            for (const key of ['description', 'og:description', 'og:image:alt', 'twitter:title', 'twitter:description', 'twitter:image:alt']) {
                assert.match(head, new RegExp('<meta (?:property|name)="' + key + '" content="[^"]+"'), path + ': ' + key);
            }
            assert.equal(head.match(/<meta property="og:url" content="([^"]+)">/)?.[1], canonical, path + ': og:url');
            assert.equal(head.match(/<link rel="canonical" href="([^"]+)">/)?.[1], canonical, path + ': canonical');
        }
        const image = await fetch(origin + '/social-preview-lake.jpg', crawler);
        assert.equal(image.status, 200);
        assert.match(image.headers.get('content-type'), /^image\/jpeg/);
        const jpeg = Buffer.from(await image.arrayBuffer());
        assert.equal(jpeg.subarray(0, 2).toString('hex'), 'ffd8');
        // Chromium's baseline JPEG stores its dimensions in the SOF0 frame header.
        const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
        assert(frame > 0, 'Preview should contain a baseline JPEG frame');
        assert.equal(jpeg.readUInt16BE(frame + 7), 1200);
        assert.equal(jpeg.readUInt16BE(frame + 5), 630);
        assert(jpeg.length < 1000000, 'Preview should remain below 1 MB');
        const legacyJpeg = await fetch(origin + '/social-preview.jpg', crawler);
        assert.equal(legacyJpeg.status, 200);
        assert.match(legacyJpeg.headers.get('content-type'), /^image\/jpeg/);
        assert.deepEqual(Buffer.from(await legacyJpeg.arrayBuffer()), jpeg, 'Both JPEG URLs should serve the current artwork');
        const legacyImage = await fetch(origin + '/social-preview.png', crawler);
        assert.equal(legacyImage.status, 200, 'Cached cards can still fetch the legacy image URL');
        assert.match(legacyImage.headers.get('content-type'), /^image\/png/);
        const png = Buffer.from(await legacyImage.arrayBuffer());
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), 1200);
        assert.equal(png.readUInt32BE(20), 630);
    });
    await t.test('pages carry security headers and never ship the offline demo backend', async () => {
        for (const path of ['/', '/start.html', '/login.html', '/room.html', '/groups.html', '/docs.html', '/verify.html']) {
            const response = await fetch(origin + path);
            assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
            assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
            assert.equal(response.headers.get('x-powered-by'), null, path);
            const policy = response.headers.get('content-security-policy');
            assert.match(policy, /script-src 'self' https:\/\/challenges\.cloudflare\.com;/, path + ': scripts from this site, and the captcha (Cloudflare Turnstile) only');
            assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
            const html = await response.text();
            assert.doesNotMatch(html, /__fixture/, path);
            for (const tag of html.match(/<script[^>]*>/gi) || []) assert.match(tag, / src="/, path + ': no inline scripts, found ' + tag);
        }
    });
    await t.test('provider endpoints reject callers who are not signed in', async t => {
        // A second app instance, so these probes don't spend the rate-limit budget the burst test measures.
        delete require.cache[require.resolve('../server')];
        const fresh = require('../server').listen(0, '127.0.0.1');
        await once(fresh, 'listening');
        t.after(() => new Promise(resolve => fresh.close(resolve)));
        const origin = 'http://127.0.0.1:' + fresh.address().port;
        for (const path of ['/api/ai', '/api/turn-credentials']) {
            for (const headers of [{}, { Authorization: 'Bearer forged' }, { Authorization: 'Basic valid' }]) {
                const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{"message":"Hi"}' });
                assert.equal(response.status, 401, path + ' ' + JSON.stringify(headers));
                assert.equal(response.headers.get('cache-control'), 'private, no-store');
            }
        }
    });
    await t.test('browser error reports are logged as one line each, within limits', async () => {
        const logged = [];
        const original = console.error;
        console.error = line => logged.push(String(line));
        try {
            const send = body => fetch(origin + '/api/errors', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
            assert.equal((await send({ kind: 'error', message: 'Boom', source: '/_astro/room.js', line: 3, column: 7, stack: 'at x', page: '/room.html', extra: 'dropped' })).status, 204);
            assert.equal((await send({ message: '' })).status, 400, 'An empty report is refused');
            assert.equal((await send({ message: 'm'.repeat(5000), line: '3', stack: 's'.repeat(9000) })).status, 204);
            assert.equal((await send({ message: 'forged\n[client-error] {"message":"fake"}' })).status, 204);
        } finally { console.error = original; }
        const reports = logged.filter(line => line.startsWith('[client-error] ')).map(line => JSON.parse(line.slice(15)));
        assert.deepEqual(reports[0], { kind: 'error', message: 'Boom', source: '/_astro/room.js', line: 3, column: 7, stack: 'at x', page: '/room.html' }, 'Only known fields are kept');
        assert.equal(reports[1].message.length, 300);
        assert.equal(reports[1].stack.length, 2000);
        assert.equal(reports[1].line, 0, 'A line that is not a number becomes 0');
        assert.equal(logged.filter(line => line.startsWith('[client-error] ')).length, 3, 'Each report is exactly one log line');
        assert(!logged.some(line => line.split('\n').length > 1), 'A message cannot add lines to the log');
    });
    await t.test('an account over its quota is refused, and a server without the quota function still checks sign-in', async t => {
        delete require.cache[require.resolve('../server')];
        const fresh = require('../server').listen(0, '127.0.0.1');
        await once(fresh, 'listening');
        t.after(() => new Promise(resolve => fresh.close(resolve)));
        const call = token => fetch('http://127.0.0.1:' + fresh.address().port + '/api/turn-credentials', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
        assert.equal((await call('spent')).status, 429, 'Over quota');
        assert.equal((await call('valid')).status, 500, 'Within quota reaches the handler (TURN is not configured in tests)');
        quotaInstalled = false;
        assert.equal((await call('forged')).status, 401, 'Fallback still rejects unknown tokens');
        assert.equal((await call('valid')).status, 500, 'Fallback still accepts known ones');
        quotaInstalled = true;
    });
    await t.test('with the service key, the server records usage itself and never asks the browser-callable quota', async t => {
        process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-test';
        delete require.cache[require.resolve('../server')];
        const fresh = require('../server').listen(0, '127.0.0.1');
        await once(fresh, 'listening');
        t.after(() => new Promise(resolve => fresh.close(() => { delete process.env.SUPABASE_SERVICE_ROLE_KEY; resolve(); })));
        const call = token => fetch('http://127.0.0.1:' + fresh.address().port + '/api/turn-credentials', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
        quotaCalls.length = 0;
        assert.equal((await call('spent')).status, 429, 'Over quota');
        assert.equal((await call('valid')).status, 500, 'Within quota reaches the handler');
        assert.equal((await call('forged')).status, 401, 'An unknown sign-in is refused before any quota is touched');
        assert(quotaCalls.includes('/rest/v1/rpc/api_allow_for') && !quotaCalls.includes('/rest/v1/rpc/api_allow'), 'Only the server-side quota is used');
    });
    await t.test('invalid payloads return JSON errors', async () => {
        for (const message of [null, 12, {}, [], '', '   ', 'a'.repeat(501)]) {
            const response = await post(JSON.stringify({ message }));
            assert.equal(response.status, 400);
            assert.equal(typeof (await response.json()).text, 'string');
        }
        assert.equal((await post('{')).status, 400);
        assert.equal((await post(JSON.stringify({ message: 'x'.repeat(20000) }))).status, 413);
    });
    await t.test('unconfigured AI returns 503 and bursts are throttled', async () => {
        const unavailable = await post(JSON.stringify({ message: 'Explain photosynthesis' }));
        assert.equal(unavailable.status, 503);
        assert.equal(unavailable.headers.get('cache-control'), 'private, no-store');
        const responses = await Promise.all(Array.from({ length: 25 }, () => post(JSON.stringify({ message: 'Test' }))));
        assert(responses.some(response => response.status === 429));
        assert(responses.every(response => response.status === 429 || response.status === 503));
    });
    await t.test('TURN without configuration returns an error without a provider call', async () => {
        const response = await fetch(origin + '/api/turn-credentials', { method: 'POST', headers: { Authorization: 'Bearer valid' } });
        assert.equal(response.status, 500);
        assert.equal(typeof (await response.json()).error, 'string');
    });
    await t.test('100 simultaneous local static requests complete', async () => {
        const start = performance.now();
        const html = await (await fetch(origin + '/login.html')).text();
        const stylesheet = html.match(/href="([^"]+\.css)"/)[1];
        const statuses = await Promise.all(Array.from({ length: 100 }, async (_, i) => (await fetch(origin + (i % 2 ? '/login.html' : stylesheet))).status));
        assert(statuses.every(status => status === 200));
        console.log('100 concurrent static requests: ' + Math.round(performance.now() - start) + 'ms');
    });
});

test('assistant reminders are checked and timed on the server', () => {
    const { normalizeReminder } = require('../server');
    const now = Date.UTC(2026, 10, 12, 15, 30); // 15:30 UTC, which is 21:00 in India (UTC+5:30)
    const india = { now, tz: -330 };
    assert.equal(normalizeReminder({ text: 'stretch', minutes_from_now: 20 }, india).at, new Date(now + 20 * 60000).toISOString());
    assert.equal(normalizeReminder({ text: 'call home', local_time: '21:30' }, india).at, '2026-11-12T16:00:00.000Z', 'Local clock times use the person\'s timezone');
    assert.equal(normalizeReminder({ text: 'gym', local_time: '08:00' }, india).at, '2026-11-13T02:30:00.000Z', 'A time already past is tomorrow');
    assert.equal(normalizeReminder({ text: 'call home', local_time: '21:30' }, { now, tz: 0 }).at, '2026-11-12T21:30:00.000Z');
    assert.deepEqual(normalizeReminder({ text: 'water', timer: 'break' }, india), { text: 'water', trigger: 'break' });
    assert.equal(normalizeReminder({ text: 'x'.repeat(500), minutes_from_now: 5 }, india).text.length, 120);
    for (const bad of [null, {}, { text: '' }, { text: 'no time' }, { text: 'x', minutes_from_now: 0 }, { text: 'x', minutes_from_now: 99999 }, { text: 'x', minutes_from_now: 2.5 }, { text: 'x', local_time: '25:00' }, { text: 'x', local_time: '<script>' }, { text: 'x', timer: 'lunch' }, { text: 42, minutes_from_now: 5 }]) {
        assert.equal(normalizeReminder(bad, india), null, JSON.stringify(bad));
    }
});

