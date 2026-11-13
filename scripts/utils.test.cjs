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


test('hosted Speed Insights omits invitation parameters and stays off localhost', () => {
    const { runInNewContext } = require('node:vm');
    const source = compile('src/client/speed-insights.ts');
    for (const hostname of ['localhost', 'flow-study.me', 'flow-study-example.vercel.app']) {
        const injected = [];
        const window = {};
        runInNewContext(source.replace(/export \{\};?/, ''), {
            window, location: { hostname, origin: 'https://' + hostname }, URL,
            document: { createElement: () => ({}), head: { appendChild: script => injected.push(script) } }
        });
        assert.equal(injected.length, hostname === 'localhost' ? 0 : 1);
        if (!injected.length) continue;
        assert.equal(injected[0].src, '/_vercel/speed-insights/script.js');
        assert.equal(injected[0].defer, true);
        const filter = window.siq[0][1];
        assert.equal(filter({ url: 'https://' + hostname + '/?room=PRIVATE#token', metric: 'LCP' }).url, 'https://' + hostname + '/');
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
