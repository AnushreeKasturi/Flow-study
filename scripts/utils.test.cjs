const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { transpileModule, ModuleKind } = require('typescript');
const compile = path => transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText;
const source = compile('src/client/modules/utils.ts');
const load = () => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

test('all shipped JavaScript parses', () => {
    const files = readdirSync('dist/_astro', { recursive: true }).filter(path => path.endsWith('.js')).map(path => 'dist/_astro/' + path);
    for (const file of ['server.js', ...files]) {
        const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        assert.equal(result.status, 0, file + ': ' + result.stderr);
    }
});

test('text escaping preserves content and rejects markup interpretation', async () => {
    const { escapeHTML } = await load();
    assert.equal(escapeHTML('<img a="x"> & \'hi\''), '&lt;img a=&quot;x&quot;&gt; &amp; &#39;hi&#39;');
    assert.equal(escapeHTML(null), '');
    assert.equal(escapeHTML(0), '0');
    assert.equal(escapeHTML('日本語 📝'), '日本語 📝');
});

test('media parser accepts supported links and rejects lookalikes and malformed URLs', async () => {
    const { youtubeEmbedUrl } = await load();
    for (const url of ['https://youtu.be/jfKfPfyJRdk?t=2', 'https://www.youtube.com/watch?v=jfKfPfyJRdk', 'https://m.youtube.com/shorts/jfKfPfyJRdk', 'https://youtube.com/live/jfKfPfyJRdk']) {
        assert.equal(youtubeEmbedUrl(url), 'https://www.youtube.com/embed/jfKfPfyJRdk?autoplay=1');
    }
    assert.match(youtubeEmbedUrl('https://youtube.com/playlist?list=PLabcdefghijk12345'), /videoseries/);
    for (const url of ['', 'not a link', 'javascript:alert(1)', 'https://youtube.com.attacker.example/watch?v=jfKfPfyJRdk', 'https://attacker.example/youtu.be/jfKfPfyJRdk', 'https://youtube.com/watch?v=short', 'https://youtube.com/watch?v=jfKfPfyJRdk%22%3E']) assert.equal(youtubeEmbedUrl(url), null, url);
});

test('players can only be pointed at the official embed addresses', async () => {
    const { isEmbedUrl, youtubeEmbedUrl, spotifyEmbedUrl } = await load();
    for (const url of ['https://www.youtube.com/embed/jfKfPfyJRdk?autoplay=1', 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?theme=0']) assert.equal(isEmbedUrl(url), true, url);
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'https://www.youtube.com.evil.example/embed/x', 'http://www.youtube.com/embed/jfKfPfyJRdk', 'https://www.youtube.com/watch?v=jfKfPfyJRdk', 'https://evil.example/?https://www.youtube.com/embed/', 'not a url', '']) assert.equal(isEmbedUrl(url), false, url);
    // Everything the parsers return passes the check at the point of use.
    for (const url of [youtubeEmbedUrl('https://youtu.be/jfKfPfyJRdk'), youtubeEmbedUrl('https://www.youtube.com/playlist?list=PLx0sYbCqOb8TBPRdmBHs5Iftvv9TPboYG'), spotifyEmbedUrl('https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC')]) assert.equal(isEmbedUrl(url), true, url);
});

test('Supabase fetch has a deadline and preserves caller cancellation', async () => {
    const previousFetch = global.fetch;
    let options;
    let observedSignal;
    global.window = { supabase: { createClient: (url, key, config) => { options = config.global; return {}; } } };
    global.fetch = async (url, config) => { observedSignal = config.signal; return new Response('{}'); };
    try {
        // The client now bundles the SDK, so load the module the way the site does: bundled.
        const bundle = await require('esbuild').build({
            entryPoints: ['src/client/modules/supabase.ts'], bundle: true, write: false, format: 'esm',
            define: { 'import.meta.env.PUBLIC_SUPABASE_URL': '""', 'import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY': '""' }
        });
        await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
        await options.fetch('https://example.test');
        assert(observedSignal instanceof AbortSignal);
        assert.equal(observedSignal.aborted, false);
        const controller = new AbortController();
        controller.abort();
        await options.fetch('https://example.test', { signal: controller.signal });
        assert.equal(observedSignal.aborted, true);
    } finally {
        global.fetch = previousFetch;
        delete global.window;
    }
});

test('Spotify parser accepts official content and rejects untrusted or malformed links', async () => {
    const { spotifyEmbedUrl } = await load();
    const id = '4uLU6hMCjMI75M1A2tKUQC';
    for (const kind of ['track', 'album', 'playlist', 'artist', 'episode', 'show']) {
        for (const prefix of ['', 'embed/', 'intl-en/']) {
            assert.equal(spotifyEmbedUrl('https://open.spotify.com/' + prefix + kind + '/' + id + '?si=test'), 'https://open.spotify.com/embed/' + kind + '/' + id + '?theme=0');
        }
    }
    for (const url of ['', 'javascript:alert(1)', 'https://open.spotify.com.attacker.example/track/' + id, 'https://attacker.example/track/' + id, 'https://open.spotify.com/user/' + id, 'https://open.spotify.com/track/short', 'https://open.spotify.com/track/' + id + '/extra']) assert.equal(spotifyEmbedUrl(url), null, url);
});


test('hosted analytics omit invitation parameters, load only their own scripts, and stay off localhost', () => {
    const { runInNewContext } = require('node:vm');
    const source = compile('src/client/analytics.ts');
    for (const hostname of ['localhost', 'flow-study.me', 'flow-study-example.vercel.app']) {
        const injected = [];
        const window = {};
        // A stand-in for Trusted Types: script URLs must come from the page's own policy.
        let policy;
        window.trustedTypes = { createPolicy: (name, rules) => (policy = { name, ...rules }) };
        runInNewContext(source.replace(/export \{\};?/, ''), {
            window, location: { hostname, origin: 'https://' + hostname }, URL,
            document: { createElement: () => ({}), head: { appendChild: script => injected.push(script) } }
        });
        assert.equal(injected.length, hostname === 'localhost' ? 0 : 2);
        if (!injected.length) continue;
        assert.deepEqual(injected.map(script => script.src), ['/_vercel/insights/script.js', '/_vercel/speed-insights/script.js']);
        assert(injected.every(script => script.defer));
        assert.equal(policy.name, 'flow-script');
        assert.throws(() => policy.createScriptURL('https://elsewhere.example/x.js'), /Unexpected script/);
        for (const queue of [window.vaq, window.siq]) {
            const filter = queue[0][1];
            assert.equal(filter({ url: 'https://' + hostname + '/room.html?room=PRIVATE#token', metric: 'LCP' }).url, 'https://' + hostname + '/room.html');
        }
    }
});

test('visits send only the page name, the linking site, and a random browser id, on the hosted site only', async () => {
    const source = compile('src/client/visits.ts')
        .replace(/import defaults from .*;/, "const defaults = { url: 'https://db.example', publishableKey: 'key' };")
        .replaceAll('import.meta.env', '({})');
    const { recordVisit } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const sent = [];
    const store = new Map();
    const realFetch = globalThis.fetch;
    const setGlobals = (hostname, referrer) => Object.assign(globalThis, {
        location: { hostname, pathname: '/room.html' },
        document: { referrer },
        localStorage: { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) },
        matchMedia: () => ({ matches: true }),
        fetch: async (url, options) => { sent.push({ url, ...JSON.parse(options.body) }); }
    });
    try {
        setGlobals('localhost', '');
        recordVisit();
        assert.equal(sent.length, 0, 'Local copies send nothing');
        setGlobals('flow-study.me', 'https://www.google.com/search?q=private');
        recordVisit();
        setGlobals('flow-study.me', 'https://flow-study.me/');
        recordVisit();
        assert.equal(sent.length, 2);
        assert.equal(sent[0].url, 'https://db.example/rest/v1/rpc/record_visit');
        assert.deepEqual({ ...sent[0], url: undefined, p_visitor: undefined }, { url: undefined, p_visitor: undefined, p_page: 'room', p_source: 'google.com', p_device: 'touch', p_signed_in: false }, 'Only the linking site, never its address');
        assert.equal(sent[1].p_source, null, 'Moving around Flow is not a source');
        assert.match(sent[0].p_visitor, /^[0-9a-f-]{36}$/);
        assert.equal(sent[1].p_visitor, sent[0].p_visitor, 'The same browser keeps its id');
    } finally {
        for (const key of ['location', 'document', 'localStorage', 'matchMedia']) delete globalThis[key];
        globalThis.fetch = realFetch;
    }
});

test('reminder commands are understood without the assistant', async () => {
    const source = compile('src/client/modules/reminder-parse.ts');
    const { parseRemind, describeWhen } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const now = new Date(2026, 10, 12, 21, 0, 0).getTime(); // 9:00 pm local
    const minutesFrom = request => Math.round((request.at - now) / 60000);
    assert.deepEqual([parseRemind('/remind 20m stretch', now).text, minutesFrom(parseRemind('/remind 20m stretch', now))], ['stretch', 20]);
    assert.equal(minutesFrom(parseRemind('/remind in 1h 30m send the email', now)), 90);
    assert.equal(parseRemind('/remind in 1h 30m send the email', now).text, 'send the email');
    assert.equal(minutesFrom(parseRemind('/remind me in half an hour to review chapter 4', now)), 30);
    assert.equal(parseRemind('/remind me in half an hour to review chapter 4', now).text, 'review chapter 4');
    assert.equal(minutesFrom(parseRemind('/remind 45 minutes check the oven', now)), 45);
    // Clock times: later today, or tomorrow once passed.
    assert.equal(new Date(parseRemind('/remind at 21:30 call home', now).at).getHours(), 21);
    assert.equal(minutesFrom(parseRemind('/remind at 21:30 call home', now)), 30);
    assert.equal(minutesFrom(parseRemind('/remind at 10pm call home', now)), 60);
    assert.equal(minutesFrom(parseRemind('/remind at 8:15 am gym', now)), 11 * 60 + 15, 'A time already past is tomorrow');
    assert.equal(minutesFrom(parseRemind('/remind at 12am sleep', now)), 3 * 60);
    // Timer-linked.
    assert.deepEqual(parseRemind('/remind break drink water', now), { trigger: 'break', text: 'drink water' });
    assert.deepEqual(parseRemind('/remind at the next break stand up', now), { trigger: 'break', text: 'stand up' });
    assert.deepEqual(parseRemind('/remind after this block email Sam', now), { trigger: 'break', text: 'email Sam' });
    assert.deepEqual(parseRemind('/remind when focus starts phone away', now), { trigger: 'focus', text: 'phone away' });
    // Refused: no time, no text, out of range.
    for (const bad of ['/remind', '/remind stretch', '/remind 20m', '/remind 0m stretch', '/remind 2000m stretch', '/remind at 25:00 x', '/remind at 7:75 x', '/remind break']) assert.equal(parseRemind(bad, now), null, bad);
    assert.equal(parseRemind('/remind 5m ' + 'x'.repeat(500), now).text.length, 120);
    assert.equal(describeWhen({ trigger: 'break' }, now), 'at the next break');
    assert.match(describeWhen({ at: now + 20 * 60000 }, now), /^in 20 min/);
});

// Trusted Types (vercel.json) makes any other HTML-string sink throw; this keeps the code honest before it ever runs.
test('HTML strings reach the page only through setMarkup', () => {
    const { readdirSync, readFileSync, statSync } = require('node:fs');
    const { join } = require('node:path');
    const files = dir => readdirSync(dir).flatMap(name => statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : [join(dir, name)]);
    const offenders = files('src/client').filter(file => /\.ts$/.test(file) && !file.endsWith('markup.ts'))
        .filter(file => /\.(innerHTML|outerHTML)\s*=[^=]|insertAdjacentHTML|document\.write/.test(readFileSync(file, 'utf8')));
    assert.deepEqual(offenders, []);
});

test('likely email typos are caught, and nothing else is', async () => {
    const source = compile('src/client/modules/email-check.ts');
    const { looksLikeEmail, suggestEmail } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    assert.equal(suggestEmail('robin@gmial.com'), 'robin@gmail.com');
    assert.equal(suggestEmail('Robin@HOTMIAL.COM'), 'Robin@hotmail.com');
    assert.equal(suggestEmail('robin@gmail.com'), null);
    assert.equal(suggestEmail('robin@university.ac.uk'), null);
    assert.equal(suggestEmail('not-an-email'), null);
    assert(looksLikeEmail('a.b+c@example.co') && !looksLikeEmail('abc@gmail') && !looksLikeEmail('a b@x.com') && !looksLikeEmail('@x.com'));
});

test('error reports keep where it broke and drop anything personal', async () => {
    const source = compile('src/client/modules/error-report.ts');
    const { describeError } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
    const here = { origin: 'https://flow-study.me', pathname: '/room.html' };
    const report = describeError({
        kind: 'error', message: 'Failed to load https://flow-study.me/room.html?room=SECRET1#token',
        source: 'https://flow-study.me/_astro/room.js?v=1', line: 12, column: 4,
        stack: 'Error: x\n    at join (https://flow-study.me/_astro/room.js?v=1:12:4)\n    at https://evil.example/steal?code=1:1:1'
    }, here);
    assert.equal(report.message, 'Failed to load /room.html', 'Query and fragment are removed');
    assert.equal(report.source, '/_astro/room.js');
    assert.match(report.stack, /at join \(\/_astro\/room\.js:12:4\)/, 'Line numbers in our own files are kept');
    assert(!/SECRET1|token|code=1|steal/.test(JSON.stringify(report)), 'Nothing from query strings, and other sites by host only');
    assert.equal(report.page, '/room.html');
    assert.equal(describeError({ kind: 'error', message: 'Script error.' }, here), null, 'Cross-origin noise is dropped');
    assert.equal(describeError({ kind: 'error', message: 'x', source: 'chrome-extension://abc/content.js' }, here), null, 'Extensions are not our bugs');
    assert.equal(describeError({ kind: 'rejection', message: 'y'.repeat(1000) }, here).message.length, 300, 'Messages are capped');
    assert.equal(describeError({ kind: 'error', message: 'z', line: -3 }, here).line, 0);
});
