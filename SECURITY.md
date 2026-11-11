# Security

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Include what you found and how to reproduce it. You'll get a reply as soon as the maintainer can look at it.

## What Flow protects today

| Area | Protection |
| --- | --- |
| Accounts | Supabase email/password authentication |
| Tasks, sessions, profiles | PostgreSQL row-level security: tasks are readable and writable only by people who joined that room; sessions and profiles only by their owner |
| Room PINs | Never readable by clients; checked inside the `join_room` database function |
| Stored text | Length limits enforced by the database, not only by the browser (`sql/005`) |
| Study-groups board | Readable without an account (topic, host display name, seats); a room's internal id is never exposed; seats are handed out by a database function that checks capacity under a row lock; listing expiry uses the server's clock; a seat is passed to the room page in session storage, so no link can join a room on someone's behalf |
| Text from other people | Names, tasks, and chat are always inserted as text, never as HTML. Tests feed markup through every one of these paths and assert it stays inert |
| Shared audio links | Only real YouTube and Spotify hosts are accepted, converted to the official embed URL, and the Content-Security-Policy allows frames from those two origins only |
| Assistant and TURN endpoints | Require a signed-in user (the server validates the caller's Supabase token), are rate limited per address, and keep provider keys on the server. TURN credentials are short-lived tokens issued per request |
| Assistant | Receives only the text typed after `/ai`. It has no access to the database, the room, or earlier messages, and nothing is kept after the reply |
| Pages | Content-Security-Policy, `nosniff`, a referrer policy, a permissions policy limiting camera and microphone to this site, HSTS, and no framing by other sites |
| Video and voice | Encrypted by WebRTC (DTLS-SRTP) with keys negotiated between the two browsers on each call. Media goes directly between browsers when a direct path exists; otherwise a TURN relay forwards the encrypted packets without being able to read them. Flow's servers never receive media |
| Disruptive people | The person who created a room can remove someone: the database deletes their membership and refuses every later join, by code or from the board. A "you were removed" message is only acted on after the database confirms it, so it cannot be forged to eject others |
| Abusive listings | Any signed-in user can report a listing. Reports are recorded against the host by the database, and three different reporters within a week hide everything that host has on the board, including anything posted afterwards. Only accounts at least a day old count toward the three, and one account can file ten reports a day. Reports are write-only and are read in the Supabase table editor |
| Listings | One per room, and only by the room's creator, so a second listing cannot be used to close a room or get around its seat limit |
| Seat limits | A listed room's seat count, and "closed to new people", are enforced in the database for joins by code as well as from the board |
| Departure messages | A "goodbye" only marks a tile; the connection is torn down once that person's call has actually dropped, and their next heartbeat undoes a false one, so it cannot be used to cut someone else off |
| Abuse inside a room | Timer messages are throttled when sent and flood-limited when received; ICE candidates are capped per peer |

## Known limits

These are real gaps. They are listed so nobody assumes more than is true.

- **Room channels are not private until you turn them on.** Presence, chat, timer, and call-setup messages travel over a Supabase Realtime channel named after the room's internal id. That id is a random UUID and is not exposed by the app, but by default the channel does not verify membership. The code and policies for private channels ship in this repository, switched off; follow the steps below to enable them. Even with them on, a member of a room can send messages under another member's id, because Realtime checks who may use a channel, not what they claim inside a message.
- **Chat and tasks are not end-to-end encrypted.** Task text is readable by the database operator, and chat passes through the realtime service in readable form. Calls are encrypted between browsers, but the keys are agreed over the room's signalling channel, which is not yet authenticated (see the point above), so the encryption does not by itself prove who is on the other end. A shared room key agreed between browsers and applied to chat, tasks, and media frames would close this; it has not been started.
- **Room codes are six characters** from a 31-character alphabet (about 887 million combinations), with an optional four-digit PIN. Joins are not yet rate limited per account, so a code should be treated as an invitation, not a secret.
- **Seat limits rely on the host's browser for the head count.** Only live presence knows who is in a room right now, so the host reports it. A host can therefore over- or under-state their own room's occupancy.
- **Removal takes effect at the database immediately, and in the removed person's browser when it hears about it.** If their browser ignores the message they keep receiving realtime traffic until they reload, unless private channels are on, in which case access ends when their token next refreshes.
- **Automatic hiding can be abused by a patient group.** Three accounts that are each more than a day old can hide a host's listings for a week. The `reports` table records who reported whom, so check it if a host says they were hidden unfairly, and delete the rows to restore them.
- **Rooms created before `sql/006` have no host,** so nobody can remove people from them.
- **The shared timer trusts participants.** Anyone in a room can start, pause, or reset it; that is the feature. Each browser counts down from its own clock.
- **Rate limits are per server instance.** On serverless hosting they are not a global quota.

## Turning on private room channels

This changes how every browser connects to a room, so do it in order, at a quiet time, and test with two real accounts. Tabs that were open before step 2 stay on the old channel until they reload, and will not see people who have reloaded.

1. **Apply the policies.** Run [`sql/007_private_room_channels.sql`](sql/007_private_room_channels.sql) in the Supabase SQL editor. On its own this changes nothing.
2. **Switch the client.** Set `"privateRoomChannels": true` in [`supabase.config.json`](supabase.config.json) and deploy.
3. **Test.** With two accounts in two browsers, join the same room. Check that each sees the other, the timer syncs, chat arrives, and video connects. Then sign in with a third account that has not joined the room and confirm, from the browser console, that subscribing to `room:<that room's id>` fails.
4. **Close the old door.** In the Supabase dashboard, open **Realtime → Settings** and turn off **Allow public access**. Until you do this, a client that chooses the public channel can still use it.

To back out, set `privateRoomChannels` to `false`, deploy, and turn **Allow public access** back on.

This has been written to Supabase's documented behaviour but has not been run against a live project from this repository; step 3 is the test.
