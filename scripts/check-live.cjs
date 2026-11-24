// Checks the live site and its Supabase project from the outside, using only public
// endpoints, so settings that live outside this repository can't drift unnoticed:
// a missing page, a migration that wasn't run, a sign-in provider that isn't switched
// on, email confirmation without its page. Run: `npm run check:live` (or daily in CI).
const config = require('../supabase.config.json');

const SITE = process.env.FLOW_SITE || 'https://flow-study.me';
const headers = { apikey: config.publishableKey };
const results = [];
const check = (ok, text) => { results.push({ ok, text }); };
const get = (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) });

async function main() {
    // Every page loads, including the one verification emails link to.
    for (const page of ['/', '/start.html', '/login.html', '/room.html', '/groups.html', '/docs.html', '/verify.html']) {
        const response = await get(SITE + page);
        check(response.ok, `${page} loads (${response.status})`);
    }
    // The security headers are served.
    const home = await get(SITE + '/');
    const csp = home.headers.get('content-security-policy') || '';
    check(csp.includes("script-src 'self'") && csp.includes("require-trusted-types-for 'script'"), 'Content-Security-Policy is served, with Trusted Types');

    // Sign-in: what the site offers is what Supabase has switched on, and confirmation has its page.
    const settings = await (await get(`${config.url}/auth/v1/settings`, { headers })).json();
    const enabled = Object.entries(settings.external || {}).filter(([, on]) => on).map(([name]) => name);
    // Fixed labels, so the report never prints a value read from config.
    const LABELS = { github: 'GitHub', google: 'Google' };
    for (const provider of config.oauthProviders || []) check(enabled.includes(provider), `${LABELS[provider] || 'A configured'} sign-in is switched on in Supabase (the site offers it)`);
    check(enabled.includes('email'), 'Email sign-in is switched on');
    if (!settings.mailer_autoconfirm) check((await get(SITE + '/verify.html')).ok, 'Email confirmation is on, and its page exists');

    // The captcha: on in Supabase only once the site has its key, or every sign-in is refused.
    // An empty email sends nothing; with the captcha on, it's refused for the missing token first.
    const recover = await (await get(`${config.url}/auth/v1/recover`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"email":""}' })).json();
    if (recover.error_code === 'captcha_failed') check(!!config.captchaSiteKey, 'The captcha is on in Supabase, and the site has its key');
    // Exact source in each directive Turnstile needs (its script, and the iframe it draws), not a substring of the header.
    const sources = name => (csp.split(';').map(d => d.trim().split(/\s+/)).find(([n]) => n === name) || []).slice(1);
    const TURNSTILE = 'https://challenges.cloudflare.com';
    if (config.captchaSiteKey) check(['script-src', 'frame-src'].every(d => sources(d).some(source => source === TURNSTILE)), 'The Content-Security-Policy lets the captcha load');

    // The database: the public board is readable, everything else is closed to signed-out visitors.
    const read = (table, columns = '*') => get(`${config.url}/rest/v1/${table}?select=${columns}&limit=1`, { headers });
    // The same columns the board asks for (src/client/modules/board.ts); a missing grant or migration fails here.
    const board = await read('open_rooms', 'id,host_id,host_name,topic,subject,camera,vibe,seats,seats_taken,closed,timer_mode,timer_ends_at,last_seen,away_until,acting_name');
    check(board.ok, `The public board is readable (${board.status})`);
    check((await read('planned_groups')).ok, 'Planned study groups are readable');
    for (const table of ['profiles', 'sessions', 'tasks', 'room_participants']) {
        const response = await read(table);
        check(!response.ok, `${table} is closed to signed-out visitors (${response.status})`);
    }
    // Migrations are in. A function signed-out visitors may not call answers 401; one that
    // doesn't exist answers 404. (Signed-out visitors can't read rooms at all, so a column can't be checked.)
    const rpc = (name, body) => get(`${config.url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    for (const [name, body, migration] of [
        ['api_allow_for', { p_user: '00000000-0000-0000-0000-000000000000', p_kind: 'ai' }, 'sql/016'],
        ['focus_days', { p_tz: 'UTC' }, 'sql/019'],
        ['platform_stats', { p_days: 30 }, 'sql/020'],
        ['room_link_status', { p_room_code: 'AAAAAA' }, 'sql/022']
    ]) {
        const { status } = await rpc(name, body);
        check(status === 401 || status === 403, `${migration} is applied, and ${name} is closed to signed-out visitors (${status})`);
    }
    check((await rpc('visitor_count', {})).ok, 'sql/023 is applied (the visitor count answers)');
    // Quotas are server-only: browsers can't call them.
    const quota = await get(`${config.url}/rest/v1/rpc/api_allow`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{"p_kind":"ai"}' });
    check(quota.status === 401 || quota.status === 403 || quota.status === 404, `The quota function is closed to browsers (${quota.status})`);
    for (const page of ['/stats.html']) check((await get(SITE + page)).ok, `${page} loads`);
    for (const [name, want] of [['strict-transport-security', 'max-age'], ['x-content-type-options', 'nosniff'], ['x-frame-options', '']])
        check((home.headers.get(name) || '').toLowerCase().includes(want) && home.headers.has(name), `${name} is served`);

    // The API answers without a sign-in only where it should.
    const post = (path, body) => get(SITE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    check((await post('/api/ai', '{"message":"hi"}')).status === 401, '/api/ai needs a sign-in');
    check((await post('/api/turn-credentials', '{}')).status === 401, '/api/turn-credentials needs a sign-in');
}

main().catch(error => check(false, 'The check itself failed: ' + error.message)).finally(() => {
    for (const { ok, text } of results) console.log(`${ok ? '✅' : '❌'} ${text}`);
    const failed = results.filter(r => !r.ok).length;
    console.log(failed ? `\n${failed} problem(s) on ${SITE}.` : `\nAll ${results.length} checks pass on ${SITE}.`);
    process.exitCode = failed ? 1 : 0;
});
