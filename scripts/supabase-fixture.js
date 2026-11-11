// In-browser stand-in for the Supabase SDK. Used by the browser tests and by
// `npm run dev:demo`, which runs the whole app offline with one fake account.
// It is never part of a production build.
window.supabase = { createClient() {
        const user = { id: 'test-user', email: 'alex@example.com' };
        // ?fresh starts without a saved name, to show first-run setup.
        const tables = { profiles: new URLSearchParams(location.search).has('fresh') ? [] : [{ id: user.id, display_name: 'Alex' }], rooms: [], tasks: [], sessions: [],
            // ?board seeds two listings so the study-groups page has something to show.
            open_rooms: new URLSearchParams(location.search).has('board') ? [
                { id: 'listing-1', host_id: 'riya', host_name: 'Riya', topic: 'Organic chemistry: reaction mechanisms', seats: 4, seats_taken: 2, last_seen: new Date().toISOString() },
                { id: 'listing-2', host_id: 'sam', host_name: 'Sam', topic: 'Quiet essay writing, cameras optional', seats: 2, seats_taken: 2, last_seen: new Date().toISOString() }
            ] : [] };
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
                upsert(value) { action = 'insert'; payload = value; if (table === 'open_rooms') tables[table] = tables[table].filter(row => row.host_id !== value.host_id); return this; },
                delete() { action = 'delete'; return this; },
                then(resolve, reject) {
                    return (async () => {
                    fixture.calls.push({ table, action });
                    await new Promise(resolve => setTimeout(resolve, fixture.delay));
                    const failure = fixture.fail;
                    if (failure && failure.table === table && failure.action === action) {
                        fixture.fail = null;
                        if (failure.throw) throw new Error('Network failure');
                        return { data: [], error: failure.zero ? null : { message: 'Permission denied' } };
                    }
                    if (fixture.collision && table === 'rooms' && action === 'select') return { data: [{ id: 'collision' }], error: null };
                    let rows = tables[table].filter(row => filters.every(filter => filter(row)));
                    if (action === 'insert') {
                        rows = (Array.isArray(payload) ? payload : [payload]).map(row => ({ id: crypto.randomUUID(), ...row }));
                        tables[table].push(...rows);
                    }
                    if (action === 'update') rows.forEach(row => Object.assign(row, payload));
                    if (action === 'delete') tables[table] = tables[table].filter(row => !rows.includes(row));
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
            rpc: async name => {
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
