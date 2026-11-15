// Load test: people studying in Flow rooms, doing what an open room tab does.
// Run against a separate Supabase project (never production); see scripts/load/README.md.
//
//   k6 run -e PEOPLE=100 -e GROUP=5 scripts/load/flow-rooms.k6.js
//
// Each virtual user is one signed-in person:
//   Home      profile, today's focus, the board
//   Join      join_room, who hosts, is it listed, the saved timer, tasks
//   In room   one Realtime connection with the room and board channels, presence,
//             a heartbeat through room_send every 20 s, and while the timer runs a
//             timer sync every 10 s (src/client/modules/timer.ts), as every member does;
//             hosts of listed rooms refresh the listing every 45 s; focus saved every 5 min.
import http from 'k6/http';
import { sleep } from 'k6';
import { WebSocket } from 'k6/websockets';
import { setInterval, setTimeout, clearInterval } from 'k6/timers';
import { Trend, Counter, Rate } from 'k6/metrics';
import exec from 'k6/execution';
// A whole number in [0, n) from the Web Crypto API, without modulo bias: draws past the
// last full multiple of n are thrown away (CodeQL js/insecure-randomness, js/biased-cryptographic-random).
const randomInt = (n) => {
    const limit = 2 ** 32 - (2 ** 32 % n);
    let x;
    do x = crypto.getRandomValues(new Uint32Array(1))[0]; while (x >= limit);
    return x % n;
};

const URL = __ENV.SUPABASE_URL;
const KEY = __ENV.SUPABASE_KEY;
const PASSWORD = __ENV.LOAD_PASSWORD;
const PEOPLE = Number(__ENV.PEOPLE || 50);
const GROUP = Math.min(6, Number(__ENV.GROUP || 5)); // a listed room has at most 6 seats
const LISTED = Number(__ENV.LISTED ?? 0.5); // share of rooms on the public board
const TIMER = __ENV.TIMER !== '0'; // the room's timer is running (the usual state)
const RAMP_S = Number(__ENV.RAMP_S || 60);
const HOLD_S = Number(__ENV.HOLD_S || 180);
if (!URL || !KEY || !PASSWORD) throw new Error('Set SUPABASE_URL, SUPABASE_KEY and LOAD_PASSWORD (see README.md)');
if (/mrjtkxwenqswbjplmzko/.test(URL)) throw new Error('That is the production project. Load tests run against flow-loadtest only.');
// Free-plan limits (200 Realtime connections) are shared by every project in the organisation,
// production included. Going past them once started a usage grace period; see README.md.
if (PEOPLE > 150 && __ENV.OVER_QUOTA !== 'yes') throw new Error('Over 150 people can push the whole Supabase organisation past its Realtime limit. Set OVER_QUOTA=yes only on a paid plan or a separate organisation.');

export const options = {
    setupTimeout: '15m',
    scenarios: {
        rooms: { executor: 'ramping-vus', startVUs: 0, stages: [{ duration: RAMP_S + 's', target: PEOPLE }, { duration: HOLD_S + 's', target: PEOPLE }], gracefulRampDown: '30s', gracefulStop: '30s' }
    },
    thresholds: {
        flow_rpc_failed: ['rate<0.01'],
        flow_channel_join_ok: ['rate>0.99'],
        flow_rpc_ms: ['p(95)<1000'],
        flow_delivery_ms: ['p(95)<2000'],
        flow_join_ms: ['p(95)<3000']
    },
    summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max']
};

const joinMs = new Trend('flow_join_ms', true); // Home + join reads, end to end
const rpcMs = new Trend('flow_rpc_ms', true); // room_send
const rpcFailed = new Rate('flow_rpc_failed');
const deliveryMs = new Trend('flow_delivery_ms', true); // sent by one person, received by another
const channelJoinOk = new Rate('flow_channel_join_ok');
const received = new Counter('flow_messages_received');
const boardPings = new Counter('flow_board_pings_received');
const realtimeErrors = new Counter('flow_realtime_errors');
const droppedSockets = new Counter('flow_sockets_dropped');

const OPEN = 'id,host_id,host_name,topic,subject,camera,vibe,seats,seats_taken,closed,timer_mode,timer_ends_at,last_seen,away_until,acting_name';
const api = (token, extra = {}) => ({ headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra } });
const rest = (path) => `${URL}/rest/v1/${path}`;
const email = (i) => `load${String(i + 1).padStart(4, '0')}@example.test`;

// Sign everyone in, and have each room's host create and (sometimes) list the room.
export function setup() {
    // A few at a time, backing off on 429: Supabase limits bursts of sign-ins from one address,
    // and real people don't all sign in in the same second.
    const people = [];
    for (let i = 0; i < PEOPLE; i++) {
        let response;
        for (let attempt = 0; attempt < 8; attempt++) {
            response = http.post(`${URL}/auth/v1/token?grant_type=password`, JSON.stringify({ email: email(i), password: PASSWORD }), { headers: { apikey: KEY, 'Content-Type': 'application/json' } });
            if (response.status !== 429) break;
            sleep(2 ** attempt * 0.5);
        }
        if (response.status !== 200) throw new Error(`Sign-in failed (${response.status}): ${response.body}`);
        const body = response.json();
        people.push({ token: body.access_token, id: body.user.id });
        sleep(0.15);
    }
    const run = String.fromCharCode(65 + randomInt(26)) + String.fromCharCode(65 + randomInt(26));
    const rooms = [];
    for (let r = 0; r * GROUP < PEOPLE; r++) {
        const host = people[r * GROUP];
        const code = run + String(r).padStart(4, '0');
        const made = http.post(rest('rooms'), JSON.stringify({ room_code: code }), api(host.token, { Prefer: 'return=minimal' }));
        if (made.status >= 300) throw new Error(`Room creation failed (${made.status}): ${made.body}`);
        const joined = http.post(rest('rpc/join_room'), JSON.stringify({ p_room_code: code, p_pin: '' }), api(host.token));
        const id = joined.json();
        const listed = r < Math.round(LISTED * Math.ceil(PEOPLE / GROUP));
        if (listed) {
            http.del(rest(`open_rooms?host_id=eq.${host.id}`), null, api(host.token));
            const listing = { host_id: host.id, room_id: id, host_name: `Load ${r}`, topic: `Load test room ${r}`, subject: 'other', camera: 'optional', vibe: 'quiet', seats: Math.max(2, GROUP), seats_taken: 1, closed: false, timer_mode: 'focus', timer_ends_at: null };
            const res = http.post(rest('open_rooms'), JSON.stringify(listing), api(host.token, { Prefer: 'return=minimal' }));
            if (res.status >= 300) throw new Error(`Listing failed (${res.status}): ${res.body}`);
        }
        rooms.push({ code, id, listed });
    }
    return { people, rooms, endsAt: Date.now() + (RAMP_S + HOLD_S) * 1000 };
}

export default function (data) {
    const index = exec.vu.idInTest - 1;
    if (index >= PEOPLE) return;
    const me = data.people[index];
    const roomIndex = Math.floor(index / GROUP);
    const room = data.rooms[roomIndex];
    const isHost = index % GROUP === 0;
    const auth = api(me.token);

    // Home, then joining: the reads a real tab makes, in parallel where the page does.
    const began = Date.now();
    http.batch([
        ['GET', rest(`profiles?select=display_name&id=eq.${me.id}`), null, auth],
        ['GET', rest(`sessions?select=id,duration_seconds&user_id=eq.${me.id}&completed_at=gte.${new Date(Date.now() - 864e5).toISOString()}`), null, auth],
        ['GET', rest(`open_rooms?select=${OPEN}&order=last_seen.desc&limit=60`), null, auth]
    ]);
    const join = http.post(rest('rpc/join_room'), JSON.stringify({ p_room_code: room.code, p_pin: '' }), auth);
    if (join.status !== 200) { rpcFailed.add(true); return; }
    http.batch([
        ['GET', rest(`rooms?select=created_by,host_away,acting_host&room_code=eq.${room.code}`), null, auth],
        ['POST', rest('rpc/room_listed'), JSON.stringify({ p_room: room.id }), auth],
        ['GET', rest(`rooms?select=timer&room_code=eq.${room.code}`), null, auth],
        ['GET', rest(`tasks?select=*&room_id=eq.${room.id}&order=created_at.asc`), null, auth]
    ]);
    joinMs.add(Date.now() - began);

    const send = (event, payload) => {
        const response = http.post(rest('rpc/room_send'), JSON.stringify({ p_room: room.id, p_event: event, p_payload: { ...payload, sentAt: Date.now() } }), auth);
        rpcMs.add(response.timings.duration);
        rpcFailed.add(response.status >= 300);
    };

    const ws = new WebSocket(`${URL.replace('https', 'wss')}/realtime/v1/websocket?apikey=${KEY}&vsn=1.0.0`);
    let ref = 0;
    const push = (topic, event, payload, joinRef) => ws.send(JSON.stringify({ topic, event, payload, ref: String(++ref), join_ref: joinRef }));
    const timers = [];
    const roomTopic = `realtime:room:${room.id}`;
    let roomJoinRef = null;
    let closing = false;

    ws.onopen = () => {
        const config = (presence) => ({ config: { broadcast: { ack: false, self: false }, presence: { key: presence, enabled: !!presence }, postgres_changes: [], private: true }, access_token: me.token });
        push('realtime:board', 'phx_join', config(''), '1');
        roomJoinRef = String(ref + 1);
        push(roomTopic, 'phx_join', config(me.id), roomJoinRef);
        timers.push(setInterval(() => push('phoenix', 'heartbeat', {}, null), 25000));
    };
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.event === 'phx_reply' && message.topic === roomTopic && message.ref === roomJoinRef) {
            const ok = message.payload?.status === 'ok';
            channelJoinOk.add(ok);
            if (!ok) { realtimeErrors.add(1); return; }
            push(roomTopic, 'presence', { type: 'presence', event: 'track', payload: { username: `Load ${index}`, status: 'Focusing', nowPlaying: null, isDummyMedia: true, handRaised: false } }, roomJoinRef);
            send('presence-heartbeat', { userId: me.id, username: `Load ${index}`, isDummyMedia: true });
            timers.push(setInterval(() => send('presence-heartbeat', { userId: me.id, username: `Load ${index}`, isDummyMedia: true }), 20000));
            // Everyone in a running room sends the 10-second sync, on the same tick.
            if (TIMER) setTimeout(() => closing || timers.push(setInterval(() => send('timer-updated', { action: 'sync', timeLeft: 600 }), 10000)), (roomIndex % 10) * 1000);
            if (isHost && room.listed) timers.push(setInterval(() => http.patch(rest(`open_rooms?host_id=eq.${me.id}`), JSON.stringify({ seats_taken: GROUP, timer_mode: 'focus', timer_ends_at: null }), auth), 45000));
            timers.push(setInterval(() => http.post(rest('sessions'), JSON.stringify({ room_id: room.id, user_id: me.id, mode: 'focus-partial', duration_seconds: 300 }), api(me.token, { Prefer: 'return=minimal' })), 300000));
            return;
        }
        if (message.event === 'phx_error' || (message.event === 'system' && message.payload?.status === 'error')) { realtimeErrors.add(1); console.warn(`realtime said: ${JSON.stringify(message.payload).slice(0, 200)}`); return; }
        if (message.event === 'broadcast') {
            if (message.topic === 'realtime:board') { boardPings.add(1); return; }
            received.add(1);
            const sentAt = message.payload?.payload?.sentAt;
            if (sentAt) deliveryMs.add(Date.now() - sentAt);
        }
    };
    ws.onerror = (event) => { realtimeErrors.add(1); console.warn(`socket error: ${event.error || ''}`); };
    ws.onclose = (event) => {
        if (!closing) { droppedSockets.add(1); console.warn(`socket closed early: ${event.code} ${event.reason || ''}`); }
        timers.forEach(clearInterval);
    };

    // Stay until the test's hold ends, then leave like a closing tab.
    setTimeout(() => {
        closing = true;
        timers.forEach(clearInterval);
        ws.close();
    }, Math.max(1000, data.endsAt - Date.now()));
}
