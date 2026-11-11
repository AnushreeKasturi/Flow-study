const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.GROQ_API_KEY = '';
process.env.TWILIO_ACCOUNT_SID = '';
process.env.TWILIO_AUTH_TOKEN = '';
const http = require('node:http');
const { once } = require('node:events');
test('HTTP boundaries and bounded local concurrency', async t => {
    // Stand-in for Supabase's token check: only the bearer token "valid" belongs to a user.
    const auth = http.createServer((req, res) => {
        res.writeHead(req.url === '/auth/v1/user' && req.headers.authorization === 'Bearer valid' && req.headers.apikey ? 200 : 401).end('{}');
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
        for (const path of ['/', '/start.html', '/login.html', '/room.html', '/groups.html', '/docs.html', '/favicon.svg', '/room-preview.webp']) assert.equal((await fetch(origin + path)).status, 200, path);
        const html = await (await fetch(origin + '/login.html')).text();
        const asset = html.match(/src="([^"]+\.js)"/)[1];
        assert.equal((await fetch(origin + asset)).status, 200);
        for (const path of ['/src/client/app.ts', '/.env', '/sql/schema.sql', '/package.json', '/missing.html']) assert.equal((await fetch(origin + path)).status, 404, path);
    });
    await t.test('link crawlers receive static metadata and a public preview image', async () => {
        const expected = {
            'og:type': 'website',
            'og:site_name': 'Flow',
            'og:url': 'https://flow-study.me/',
            'og:title': 'Flow | Study better, together',
            'og:image': 'https://flow-study.me/social-preview.png',
            'og:image:type': 'image/png',
            'og:image:width': '1200',
            'og:image:height': '630',
            'twitter:card': 'summary_large_image',
            'twitter:image': 'https://flow-study.me/social-preview.png'
        };
        const crawler = { headers: { 'User-Agent': 'facebookexternalhit/1.1' } };
        for (const path of ['/', '/login.html', '/?room=FOCUS6']) {
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
            assert.match(head, /<link rel="canonical" href="https:\/\/flow-study\.me\/">/);
        }
        const image = await fetch(origin + '/social-preview.png', crawler);
        assert.equal(image.status, 200);
        assert.match(image.headers.get('content-type'), /^image\/png/);
        const png = Buffer.from(await image.arrayBuffer());
        assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(png.readUInt32BE(16), 1200);
        assert.equal(png.readUInt32BE(20), 630);
        assert(png.length < 1000000, 'Preview should remain below 1 MB');
    });
    await t.test('pages carry security headers and never ship the offline demo backend', async () => {
        for (const path of ['/', '/start.html', '/login.html', '/room.html', '/groups.html', '/docs.html']) {
            const response = await fetch(origin + path);
            assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, path);
            assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
            assert.equal(response.headers.get('x-powered-by'), null, path);
            assert.doesNotMatch(await response.text(), /__fixture/, path);
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
