# Load tests

k6 scripts that act like people using Flow, run against a **separate Supabase project**, never production. The scripts refuse to run against the production project.

| Script | What it answers |
|---|---|
| `flow-rooms.k6.js` | How many people can be in rooms at once. Each virtual user signs in, loads Home, joins a room, and keeps a Realtime connection (room + board channels, presence) with the heartbeat, timer syncs, listing refreshes and focus saves a real tab sends. |
| `flow-db.k6.js` | How many requests per second the database handles, without Realtime's connection cap in the way. Climbs in steps up to `PEAK` requests per second. |
| `seed-accounts.sql` | 400 confirmed test accounts (`load0001@example.test` …). No emails are sent. |
| `summarise.cjs` | Turns `--summary-export` files from a series of runs into one table. |

## Setting up a load-test project

1. Create a Supabase project in the same region and plan as production (Mumbai, Free). Ours is `flow-loadtest`.
2. In its SQL editor, run `sql/schema.sql`, then every numbered file in `sql/` in order.
3. Run `seed-accounts.sql`, with `PASSWORD_HERE` replaced by a password of your own.
4. Authentication → Rate Limits: raise "sign-ups and sign-ins" and "token refreshes" to 1000 per 5 minutes. Every virtual user signs in from your one machine.
5. Then run:

```sh
export SUPABASE_URL=https://<load-test-ref>.supabase.co
export SUPABASE_KEY=<its publishable key>
export LOAD_PASSWORD=<the seed password>
k6 run -e PEOPLE=100 -e GROUP=5 scripts/load/flow-rooms.k6.js
k6 run -e PEAK=300 scripts/load/flow-db.k6.js
```

Options for `flow-rooms.k6.js`: `PEOPLE` (default 50), `GROUP` (people per room, at most 6; default 5), `LISTED` (share of rooms on the board; default 0.5), `TIMER=0` (timers stopped), `RAMP_S` and `HOLD_S` (ramp-up and hold, in seconds).

## Results, 15 November 2026

Free plan, Mumbai, Nano compute. Rooms of 5, half of them listed, timers running. Each run ramped up over a minute, then held for three. The load came from one machine in India.

**People in rooms at once (`flow-rooms.k6.js`):**

| People | Joined their room | `room_send` failed | `room_send` p95 | Message delivery p95 | Realtime messages received /s (room + board) | Sockets refused |
|---|---|---|---|---|---|---|
| 50 | 50 | 0 of 1,538 | 122 ms | 127 ms | 30 + 4 | 0 |
| 100 | 100 | 0 of 3,080 | 122 ms | 126 ms | 57 + 16 | 0 |
| 150 | 150 | 0 of 4,622 | 125 ms | 129 ms | 81 + 30 | 0 |
| **200** | **200** | **0 of 6,169** | **121 ms** | **125 ms** | **90 + 45** | **0** |
| 250 | 249 | 0 of 6,463 | 52 ms | 58 ms | 92 + 54 | 47 |
| 300 | 277 | 0 of 7,169 | 51 ms | 59 ms | 71 + 52 | 78 |

Above 200, new connections fail with `websocket: bad handshake`. That's the free plan's documented limit of [200 concurrent Realtime connections](https://supabase.com/docs/guides/realtime/limits). Every open Flow tab holds one connection, on Home as well as in a room.

**Database requests (`flow-db.k6.js`):** 90% `room_send`, 10% join reads.

| Requests /s | Failed | p50 | p95 |
|---|---|---|---|
| 30 | 0 | 40 ms | 50 ms |
| 75 | 0 | 38 ms | 48 ms |
| 150 | 0 | 38 ms | 48 ms (one 15-second spike to 1.2 s) |
| 200–225 | 0 | climbs to 2–6 s | 7 s+ |

Up to 150 requests a second the database is flat. Between 150 and 200 it saturates, and requests queue for seconds rather than fail.

## What the numbers mean

- **Flow holds 200 people online at once on the free plan.** That's 40 rooms of 5, and the limit is Realtime connections, not the database. At 200, every message still arrived in about an eighth of a second.
- **People in rooms make about 0.14 requests a second each** (200 people made 27 a second), mostly `room_send`. At that rate the database would run out at roughly 1,000 people in rooms, so it isn't the first limit.
- **Accounts aren't the limit; people online at the same time are.** How many accounts fit under 200 online depends on how many of them study at the same moment, which these tests can't tell.

## Where to optimise

1. **Leave the board channel when entering a room.** Everyone stays subscribed to `board`, and each listing change goes to all of them, so board traffic grows with listed rooms × people online. At 200 people it was 45 messages a second, a third of all Realtime traffic, delivered to people in rooms who ignore it.
2. **One timer sync per room, not one per person.** While the timer runs, every member sends `timer-updated` every 10 seconds (`modules/timer.ts`), all on the same tick. One sender per room would cut each person's `room_send` rate by about half.
3. **A slower `room_send` heartbeat.** Presence already tracks who's here. The 20-second heartbeat through the database is a backstop, and it could run at 60 seconds.
4. **One request to join a room instead of six.** `join_room`, who hosts, listed, timer and tasks could be a single RPC.
5. **More than 200 at once needs a paid plan,** which raises the Realtime connection limit. Items 1–4 don't change that cap; they make each connection cheaper, which matters once the cap is higher.
