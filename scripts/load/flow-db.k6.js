// Load test: how many database requests per second Flow's project handles, with no
// Realtime connection cap in the way. Mostly room_send (what rooms do all day), plus the
// reads a join makes. Same setup as flow-rooms.k6.js; see scripts/load/README.md.
//
//   k6 run -e PEAK=300 scripts/load/flow-db.k6.js
import http from 'k6/http';
import { sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
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
const PEOPLE = 60;
const GROUP = 5;
const PEAK = Number(__ENV.PEAK || 300); // requests per second at the top of the ramp
if (!URL || !KEY || !PASSWORD) throw new Error('Set SUPABASE_URL, SUPABASE_KEY and LOAD_PASSWORD (see README.md)');
if (/mrjtkxwenqswbjplmzko/.test(URL)) throw new Error('That is the production project. Load tests run against flow-loadtest only.');

// Climb in steps, holding each for a minute, so each rate gets a clean reading.
const steps = [0.1, 0.25, 0.5, 0.75, 1].map(share => Math.round(PEAK * share));
export const options = {
    setupTimeout: '10m',
    scenarios: {
        requests: {
            executor: 'ramping-arrival-rate', startRate: steps[0], timeUnit: '1s', preAllocatedVUs: 200, maxVUs: 600,
            stages: steps.flatMap(rate => [{ duration: '15s', target: rate }, { duration: '60s', target: rate }])
        }
    },
    summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max']
};

const sendMs = new Trend('flow_room_send_ms', true);
const readMs = new Trend('flow_read_ms', true);
const failed = new Rate('flow_failed');
const api = (token) => ({ headers: { apikey: KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
const rest = (path) => `${URL}/rest/v1/${path}`;

export function setup() {
    const people = [];
    for (let i = 0; i < PEOPLE; i++) {
        let response;
        for (let attempt = 0; attempt < 8; attempt++) {
            response = http.post(`${URL}/auth/v1/token?grant_type=password`, JSON.stringify({ email: `load${String(i + 1).padStart(4, '0')}@example.test`, password: PASSWORD }), { headers: { apikey: KEY, 'Content-Type': 'application/json' } });
            if (response.status !== 429) break;
            sleep(2 ** attempt * 0.5);
        }
        if (response.status !== 200) throw new Error(`Sign-in failed (${response.status})`);
        people.push({ token: response.json().access_token, id: response.json().user.id });
        sleep(0.15);
    }
    const run = 'D' + String.fromCharCode(65 + randomInt(26));
    const rooms = [];
    for (let r = 0; r * GROUP < PEOPLE; r++) {
        const code = run + String(r).padStart(4, '0');
        http.post(rest('rooms'), JSON.stringify({ room_code: code }), api(people[r * GROUP].token));
        let id = null;
        for (let k = 0; k < GROUP; k++) id = http.post(rest('rpc/join_room'), JSON.stringify({ p_room_code: code, p_pin: '' }), api(people[r * GROUP + k].token)).json();
        rooms.push({ code, id });
        for (let k = 0; k < GROUP; k++) people[r * GROUP + k].room = r;
    }
    return { people, rooms };
}

export default function (data) {
    const i = randomInt(PEOPLE);
    const me = data.people[i];
    const room = data.rooms[me.room];
    // Nine in ten requests are room messages, as in a busy room; one in ten is a join's reads.
    if (randomInt(10) < 9) {
        const response = http.post(rest('rpc/room_send'), JSON.stringify({ p_room: room.id, p_event: 'presence-heartbeat', p_payload: { userId: me.id, username: 'Load', isDummyMedia: true } }), api(me.token));
        sendMs.add(response.timings.duration);
        failed.add(response.status >= 300);
    } else {
        const response = http.get(rest(`rooms?select=created_by,host_away,acting_host,timer&room_code=eq.${room.code}`), api(me.token));
        readMs.add(response.timings.duration);
        failed.add(response.status >= 300);
    }
}
