// In-browser stand-in for the Supabase SDK. Used by the browser tests and by
// `npm run dev:demo`, which runs the whole app offline with one fake account.
// It is never part of a production build.
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
        const fixture = window.__fixture = { tables, calls: [], delay: 0, fail: null, authFailure: false, collision: false, rpcError: null, channelCount: 0, handlers: {} };
        async function authResult() {
            fixture.calls.push({ action: 'auth' });
            await new Promise(resolve => setTimeout(resolve, fixture.delay));
            if (fixture.authFailure) throw new Error('Network unavailable');
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
                    fixture.calls.push({ table, action });
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
                        rows = (Array.isArray(payload) ? payload : [payload]).map(row => ({ id: crypto.randomUUID(), ...(table === 'rooms' ? { created_by: user.id } : {}), ...(table === 'planned_groups' ? { going: 1, base: 1 } : {}), ...row }));
                        tables[table].push(...rows);
                    }
                    if (action === 'update') rows.forEach(row => Object.assign(row, payload));
                    if (action === 'delete') tables[table] = tables[table].filter(row => !rows.includes(row));
                    // Stands in for the database trigger that keeps "going" in step with sign-ups.
                    if (table === 'planned_group_members' && action !== 'select') tables.planned_groups.forEach(group => { group.going = group.base + tables.planned_group_members.filter(member => member.group_id === group.id).length; });
                    return { data: single ? rows[0] || null : structuredClone(rows), error: null, count: rows.length };
                    })().then(resolve, reject);
                }
            };
            return query;
        }
        const channel = {
            on(type, config, callback) { fixture.handlers[type + ':' + config.event] = callback; return this; },
            subscribe(callback) { fixture.status = callback; setTimeout(() => callback('SUBSCRIBED'), 0); return this; },
            async track(value) { if (fixture.trackFailures > 0) { fixture.trackFailures--; throw new Error('Track failed'); } this.presence = value; }, async untrack() { fixture.untracked = true; },
            async send(value) { fixture.calls.push({ action: 'send', value }); return fixture.sendStatus || 'ok'; },
            presenceState() { return { [user.id]: [this.presence || { username: 'Alex' }] }; }
        };
        return {
            from, channel: () => { fixture.channelCount++; return channel; }, async removeChannel() { fixture.removed = true; },
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
                // join_room answers with a room id; join_open_room with the room's code.
                return { data: fixture.rpcError ? null : name === 'join_open_room' ? 'FOCUS6' : 'test-room', error: fixture.rpcError ? { message: fixture.rpcError } : null };
            },
            auth: {
                signInWithPassword: authResult, signUp: authResult, signOut: async () => {},
                getSession: async () => ({ data: { session: { access_token: 'fixture-token' } }, error: null }),
                onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
            }
        };
    } };
