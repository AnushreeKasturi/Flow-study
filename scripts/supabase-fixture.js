// In-browser stand-in for the Supabase SDK. Used by the browser tests and by
// `npm run dev:demo`, which runs the whole app offline with one fake account.
// It is never part of a production build.

// Cloudflare Turnstile stand-in: hands out single-use tokens. With sessionStorage
// 'captcha-fail' set, the check fails, as when Cloudflare is blocked or offline.
window.turnstile = { issued: [], used: [],
    render(box, options) { this.options = options; this.issue(); return 'widget'; },
    reset() { this.issue(); },
    issue() {
        setTimeout(() => {
            if (sessionStorage.getItem('captcha-fail')) return this.options['error-callback']();
            const token = 'captcha-' + (this.issued.length + 1);
            this.issued.push(token);
            this.options.callback(token);
        }, 10);
    }
};

window.supabase = { createClient() {
        const user = { id: 'test-user', email: 'alex@example.com' };
        // ?fresh starts without a saved name, to show first-run setup.
        const tables = { profiles: new URLSearchParams(location.search).has('fresh') ? [] : [{ id: user.id, display_name: 'Alex' }], rooms: [], tasks: [], sessions: [],
            // ?board seeds the study-groups page so it has something to show.
            open_rooms: new URLSearchParams(location.search).has('board') ? [
                { id: 'listing-1', host_id: 'riya', host_name: 'Riya', topic: 'Organic chemistry: reaction mechanisms', subject: 'science', camera: 'optional', vibe: 'quiet', seats: 4, seats_taken: 2, closed: false, timer_mode: 'focus', timer_ends_at: new Date(Date.now() + 14 * 60000).toISOString(), last_seen: new Date().toISOString() },
                { id: 'listing-2', host_id: 'sam', host_name: 'Sam', topic: 'Quiet essay writing, cameras off', subject: 'writing', camera: 'off', vibe: 'quiet', seats: 2, seats_taken: 2, closed: false, timer_mode: 'shortBreak', timer_ends_at: new Date(Date.now() + 3 * 60000).toISOString(), last_seen: new Date().toISOString() },
                { id: 'listing-3', host_id: 'ines', host_name: 'Inés', topic: 'LeetCode mediums, talk through solutions', subject: 'programming', camera: 'on', vibe: 'chatty', seats: 5, seats_taken: 3, closed: false, timer_mode: null, timer_ends_at: null, last_seen: new Date().toISOString() }
            ] : [],
            planned_groups: new URLSearchParams(location.search).has('board') ? [
                { id: 'plan-1', host_id: 'noor', host_name: 'Noor', topic: 'Calculus II past papers', subject: 'maths', camera: 'optional', vibe: 'quiet', seats: 6, going: 3, base: 3, starts_at: new Date(Date.now() + 3 * 3600000).toISOString() },
                { id: 'plan-2', host_id: 'kai', host_name: 'Kai', topic: 'Spanish conversation practice', subject: 'languages', camera: 'on', vibe: 'chatty', seats: 4, going: 1, base: 1, starts_at: new Date(Date.now() + 26 * 3600000).toISOString() }
            ] : [],
            planned_group_members: [], reports: [] };
        const fixture = window.__fixture = { tables, calls: [], tokens: [], captcha: true, captchaReject: false, delay: 0, fail: null, authFailure: false, collision: false, rpcError: null, channelCount: 0, handlers: {} };
        // The captcha as Supabase checks it once switched on: each request needs a token never used before.
        function refused(options) {
            const token = options?.captchaToken, turnstile = window.turnstile;
            fixture.tokens.push(token);
            if (!fixture.captcha) return null;
            if (!fixture.captchaReject && turnstile.issued.includes(token) && !turnstile.used.includes(token)) { turnstile.used.push(token); return null; }
            return { data: { user: null, session: null }, error: { code: 'captcha_failed', message: 'captcha protection: request disallowed (no captcha_token found)' } };
        }
        async function authResult() {
            fixture.calls.push({ action: 'auth' });
            await new Promise(resolve => setTimeout(resolve, fixture.delay));
            if (fixture.authFailure) throw new Error('Network unavailable');
            // Like Supabase, the session outlives the page (tests sign out by removing it).
            localStorage.setItem('fixture-session', '1');
            return { data: { user, session: {} }, error: null };
        }
        function from(table) {
            let action = 'select', payload, filters = [], single = false;
            const query = {
                select() { return this; }, order() { return this; }, limit() { return this; }, gte() { return this; }, gt() { return this; },
                eq(key, value) { filters.push(row => row[key] === value); return this; },
                maybeSingle() { single = true; return this; },
                insert(value) { action = 'insert'; payload = value; return this; },
                update(value) { action = 'update'; payload = value; return this; },
                upsert(value) { action = table === 'open_rooms' ? 'denied' : 'insert'; payload = value; return this; },
                delete() { action = 'delete'; return this; },
                then(resolve, reject) {
                    return (async () => {
                    fixture.calls.push(table === 'open_rooms' && action !== 'select' ? { table, action, payload } : { table, action });
                    await new Promise(resolve => setTimeout(resolve, fixture.delay));
                    // The real open_rooms table hides room_id, and an upsert must read what it overwrites.
                    if (action === 'denied') return { data: null, error: { code: '42501', message: 'permission denied for table open_rooms' } };
                    const failure = fixture.fail;
                    if (failure && failure.table === table && failure.action === action) {
                        fixture.fail = null;
                        if (failure.throw) throw new Error('Network failure');
                        return { data: [], error: failure.zero ? null : { message: 'Permission denied' } };
                    }
                    if (fixture.collision && table === 'rooms' && action === 'select') return { data: [{ id: 'collision' }], error: null };
                    let rows = tables[table].filter(row => filters.every(filter => filter(row)));
                    if (action === 'insert') {
                        // Stands in for column defaults: a new room belongs to whoever made it.
                        rows = (Array.isArray(payload) ? payload : [payload]).map(row => ({ id: crypto.randomUUID(), ...(table === 'rooms' ? { created_by: user.id } : {}), ...(table === 'planned_groups' ? { going: 1, base: 1 } : {}), ...row, ...(table === 'open_rooms' ? { last_seen: new Date().toISOString() } : {}) }));
                        tables[table].push(...rows);
                    }
                    if (action === 'update') rows.forEach(row => Object.assign(row, payload, table === 'open_rooms' ? { last_seen: new Date().toISOString() } : {})); // like the database's check-in stamp
                    if (action === 'delete') tables[table] = tables[table].filter(row => !rows.includes(row));
                    // Stands in for the database trigger that keeps "going" in step with sign-ups.
                    if (table === 'planned_group_members' && action !== 'select') tables.planned_groups.forEach(group => { group.going = group.base + tables.planned_group_members.filter(member => member.group_id === group.id).length; });
                    return { data: single ? rows[0] || null : structuredClone(rows), error: null, count: rows.length };
                    })().then(resolve, reject);
                }
            };
            return query;
        }
        fixture.board = {};
        const boardChannel = {
            on(type, config, callback) { fixture.board[type + ':' + config.event] = callback; return this; },
            subscribe(callback) { setTimeout(() => callback?.('SUBSCRIBED'), 0); return this; }
        };
        const channel = {
            on(type, config, callback) { fixture.handlers[type + ':' + config.event] = callback; return this; },
            subscribe(callback) { fixture.status = callback; setTimeout(() => callback('SUBSCRIBED'), 0); return this; },
            async track(value) { if (fixture.trackFailures > 0) { fixture.trackFailures--; throw new Error('Track failed'); } this.presence = value; }, async untrack() { fixture.untracked = true; },
            async send(value) { fixture.calls.push({ action: 'send', value }); return fixture.sendStatus || 'ok'; },
            presenceState() { return { [user.id]: [this.presence || { username: 'Alex' }] }; }
        };
        return {
            // The board has its own channel; every other topic is the room's.
            from, channel: topic => topic === 'board' ? boardChannel : (fixture.channelCount++, channel), async removeChannel() { fixture.removed = true; },
            realtime: { setAuth: async () => {} },
            rpc: async (name, args) => {
                // Room messages go through the database; record them the way a broadcast would be.
                if (name === 'room_send') {
                    fixture.calls.push({ action: 'send', value: { event: args.p_event, payload: args.p_payload } });
                    return fixture.sendStatus && fixture.sendStatus !== 'ok' ? { data: null, error: { message: 'send failed' } } : { data: null, error: null };
                }
                fixture.calls.push({ action: 'rpc', name });
                await new Promise(resolve => setTimeout(resolve, fixture.delay));
                if (fixture.rpcError === 'throw') throw new Error('Network unavailable');
                // Host actions: the database would also tell the room; tests send those messages themselves.
                if (name === 'transfer_host') return fixture.rpcError ? { data: null, error: { message: fixture.rpcError } } : { data: 'New host', error: null };
                if (name === 'end_room') return fixture.rpcError ? { data: null, error: { message: fixture.rpcError } } : { data: null, error: null };
                // Stepping away and standing in (sql/012), against the newest room. One stand-in at a time.
                const room = tables.rooms.at(-1) ?? {};
                if (name === 'step_away') { Object.assign(room, { host_away: true, acting_host: null }); if (tables.open_rooms[0]) tables.open_rooms[0].away_until = new Date(Date.now() + 8 * 3600e3).toISOString(); return { data: null, error: null }; }
                if (name === 'claim_host') { const ok = !!room.host_away && (!room.acting_host || room.acting_host === user.id); if (ok) room.acting_host = user.id; return { data: ok, error: null }; }
                if (name === 'release_host') { if (room.acting_host === user.id) room.acting_host = null; return { data: null, error: null }; }
                if (name === 'room_checkin') return { data: !!room.host_away && room.acting_host === user.id, error: null };
                if (name === 'lists_room') return { data: tables.open_rooms.some(row => row.host_id === user.id), error: null };
                // join_room answers with a room id; join_open_room with the room's code.
                return { data: fixture.rpcError ? null : name === 'join_open_room' ? 'FOCUS6' : 'test-room', error: fixture.rpcError ? { message: fixture.rpcError } : null };
            },
            auth: {
                signInWithPassword: async ({ options }) => refused(options) ?? authResult(),
                // With "Confirm email" on, signing up makes no session until the link is opened.
                signUp: async (args) => {
                    const no = refused(args.options);
                    if (no) return no;
                    if (!fixture.requireConfirm) return authResult();
                    fixture.calls.push({ action: 'signup', redirectTo: args.options?.emailRedirectTo });
                    return { data: { user: { ...user, identities: [{}] }, session: null }, error: null };
                },
                resend: async ({ email, options }) => { fixture.calls.push({ action: 'resend', email }); return refused(options) ?? { data: {}, error: null }; },
                // The link in the email: a good token signs the person in, a used or old one doesn't.
                verifyOtp: async ({ token_hash, type }) => {
                    fixture.calls.push({ action: 'verify', token_hash, type });
                    if (fixture.authFailure) throw new Error('Network unavailable');
                    if (token_hash !== 'good-token') return { data: { user: null, session: null }, error: { message: 'Email link is invalid or has expired' } };
                    localStorage.setItem('fixture-session', '1');
                    return { data: { user, session: {} }, error: null };
                },
                // Forgot password. `resetError` and `updateError` stand in for Supabase's refusals.
                resetPasswordForEmail: async (email, options) => {
                    fixture.calls.push({ action: 'reset', email, redirectTo: options?.redirectTo });
                    if (fixture.authFailure) throw new Error('Network unavailable');
                    const no = refused(options);
                    if (no) return no;
                    return { data: {}, error: fixture.resetError ? { message: fixture.resetError } : null };
                },
                updateUser: async (attributes) => {
                    fixture.calls.push({ action: 'update-user', password: attributes.password });
                    if (fixture.updateError) return { data: { user: null }, error: { message: fixture.updateError } };
                    if (!localStorage.getItem('fixture-session')) return { data: { user: null }, error: { message: 'Auth session missing!' } };
                    return { data: { user }, error: null };
                },
                // GitHub and Google: record where the provider would send the browser back to.
                signInWithOAuth: async ({ provider, options }) => {
                    fixture.calls.push({ action: 'oauth', provider, redirectTo: options?.redirectTo });
                    return fixture.oauthError ? { data: null, error: { message: 'Unsupported provider: provider is not enabled' } } : { data: {}, error: null };
                }, signOut: async () => { localStorage.removeItem('fixture-session'); },
                getSession: async () => ({ data: { session: localStorage.getItem('fixture-session') ? { access_token: 'fixture-token', user } : null }, error: null }),
                onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
            }
        };
    } };
