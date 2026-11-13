# Security

## Reporting a vulnerability

Please don't open a public issue. Use GitHub's private reporting: **Security → Report a vulnerability** on this repository. Include what you found and how to reproduce it. You'll get a reply as soon as the maintainer can look at it.

## What Flow protects today

| Area | Protection |
| --- | --- |
| Accounts | Supabase email/password authentication. New accounts need a password of at least 8 characters |
| Rooms | A room, its code, and its internal id are visible only to its creator and the people who have joined it. The database, not the browser, records who created a room, validates the code and PIN, and caps how many rooms one account can create in a day |
| Joining | A wrong code and a wrong PIN get the same answer, so a guess reveals nothing about which was wrong. Ten misses in ten minutes lock joining for that account, and thirty wrong PINs on one room (from any accounts) close it to newcomers, until the window passes |
| Room PINs | Never readable by clients; checked inside the `join_room` database function |
| Tasks, sessions, profiles | Row-level security: tasks are readable and writable only by people who joined that room; sessions and profiles only by their owner. Length and size limits are enforced by the database |
| Room channels | Private (Supabase Realtime Authorization): only people who joined a room can subscribe to it, and public channels are switched off for the project |
| Who sent a message | Chat, timer changes, call setup, and the rest are sent through a database function that checks membership and stamps the real sender, so a member cannot speak or signal as someone else. See "Verified senders" below for the one step that makes this binding |
| Study-groups board | Readable without an account (topic, host display name, seats); a room's internal id is never exposed; one listing per room, by its creator only; seats are handed out by a database function that checks capacity under a row lock; listing expiry uses the server's clock; a seat is passed to the room page in session storage, so no link can join a room on someone's behalf |
| Disruptive people | The person who created a room can remove someone: the database deletes their membership and refuses every later join. Only the host can announce a removal, and the removed browser still confirms it with the database |
| Abusive listings | Any signed-in user can report a listing. Reports are recorded against the host by the database, and three different reporters within a week hide everything that host has on the board. Only accounts at least a day old count, and one account can file ten reports a day |
| Text from other people | Names, tasks, and chat are always inserted as text, never as HTML. Tests feed markup through every one of these paths and assert it stays inert |
| Shared audio links | Only real YouTube and Spotify hosts are accepted, converted to the official embed URL, and the Content-Security-Policy allows frames from those two origins only |
| Assistant and TURN endpoints | Require a signed-in user and count each request against a per-account quota held in the database, so the limit holds across server instances. A project-wide hourly ceiling on top (`sql/013`) bounds what many accounts together can spend. Provider keys stay on the server. TURN credentials are issued per request and expire after an hour. Assistant answers are capped in length |
| Assistant | Receives only the text typed after `/ai`. It has no access to the database, the room, or earlier messages, and nothing is kept after the reply |
| Pages | A Content-Security-Policy that allows scripts from this site only (no inline scripts) and requires Trusted Types: assigning an HTML string or script URL anywhere in the page throws unless it goes through one of two audited policies (`modules/markup.ts`, and one for the Speed Insights script), so a missed escape cannot become script. A test fails the build if code writes HTML any other way. Also plus `nosniff`, a referrer policy, a permissions policy limiting camera and microphone to this site, HSTS, and no framing by other sites |
| Video and voice | Encrypted by WebRTC (DTLS-SRTP) with keys negotiated between the two browsers on each call. Media goes directly between browsers when a direct path exists; otherwise a TURN relay forwards the encrypted packets without being able to read them. Flow's servers never receive media |
| The codebase | Dependency audit on every pull request, weekly dependency updates, CodeQL static analysis, secret scanning with push protection, and private vulnerability reporting |

## Known limits

These are real gaps. They are listed so nobody assumes more than is true.

- **Chat and tasks are not end-to-end encrypted.** Task text is readable by the database operator, and chat passes through the database and realtime service in readable form (chat messages sent through `room_send` are kept in Supabase's `realtime.messages` table for up to three days before it clears them). Calls are encrypted between browsers. A shared room key agreed between browsers and applied to chat and tasks would close this; it has not been started (issue #60).
- **Presence is self-reported.** "Who is here", display names, and camera state travel as presence, which the database cannot stamp. A member could show up under another display name. Everything that acts on identity (chat, call setup, removal) uses the verified sender, not presence.
- **Seat limits rely on the host's browser for the head count.** Only live presence knows who is in a room right now, so the host reports it.
- **Membership is permanent.** Someone who has joined a room keeps access to its tasks and channel until the host removes them.
- **The PIN lock can be turned against a room.** Thirty wrong PINs in ten minutes close a PIN room to newcomers for that window, which stops guessing but lets a few accounts keep new people out for a while. People already in the room are unaffected and are told when it happens.
- **Room PINs are stored as entered.** They are four digits, never sent to browsers, and protected by the attempt limit; hashing four digits would add nothing against someone who can read the database.
- **Automatic hiding can be abused by a patient group.** Three accounts that are each more than a day old can hide a host's listings for a week. The `reports` table records who reported whom.
- **Removal takes effect at the database immediately, and in the removed person's browser when it hears about it.** Their realtime access ends when their token next refreshes.
- **Rooms created before `sql/006` have no host,** so nobody can remove people from them.
- **The shared timer trusts participants.** Anyone in a room can start, pause, or reset it; that is the feature. Message floods are limited in the browser, not yet in the database.
- **Styles still allow inline rules** in the Content-Security-Policy; scripts do not.

## Checking a live project

The numbered files in `sql/` leave every table with row-level security and keep signed-out visitors to the public board (`sql/014`); CI checks both after every migration. Projects can drift, for example a table added by hand, so this read-only query in the Supabase SQL editor shows anything open on yours. Every column should come back empty.

```sql
SELECT
  (SELECT string_agg(relname, ', ') FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p') AND NOT relrowsecurity) AS tables_without_rls,
  (SELECT string_agg(DISTINCT table_name || ':' || privilege_type, ', ') FROM information_schema.role_table_grants
     WHERE grantee = 'anon' AND table_schema = 'public' AND (privilege_type <> 'SELECT' OR table_name NOT IN ('open_rooms', 'planned_groups'))) AS signed_out_access_beyond_the_board;
```

## Verified senders

`sql/008` adds `room_send()`, and the site sends every room message through it. Until `sql/009` is applied, browsers can also still broadcast directly, which is what makes a forged sender possible. Do these in order:

1. Run [`sql/008_security_hardening.sql`](sql/008_security_hardening.sql) and deploy the matching site version.
2. With two accounts in two browsers, check a room: chat arrives, the timer syncs, video connects, and leaving shows on the other side.
3. Run [`sql/009_only_stamped_room_messages.sql`](sql/009_only_stamped_room_messages.sql). From then on only the database can put a message on a room channel. Tabs opened before step 1 lose chat and timer sync until they reload.

To back out of step 3, run `sql/007_private_room_channels.sql` again; the site falls back to direct messages by itself.

## Turning on private room channels

This changes how every browser connects to a room, so do it in order, at a quiet time, and test with two real accounts. Tabs that were open before step 2 stay on the old channel until they reload, and will not see people who have reloaded.

1. **Apply the policies.** Run [`sql/007_private_room_channels.sql`](sql/007_private_room_channels.sql) in the Supabase SQL editor. On its own this changes nothing.
2. **Switch the client.** Set `"privateRoomChannels": true` in [`supabase.config.json`](supabase.config.json) and deploy.
3. **Test.** With two accounts in two browsers, join the same room. Check that each sees the other, the timer syncs, chat arrives, and video connects. Then sign in with a third account that has not joined the room and confirm, from the browser console, that subscribing to `room:<that room's id>` fails.
4. **Close the old door.** In the Supabase dashboard, open **Realtime → Settings** and turn off **Allow public access**. Until you do this, a client that chooses the public channel can still use it.

To back out, set `privateRoomChannels` to `false`, deploy, and turn **Allow public access** back on.

This has been written to Supabase's documented behaviour but has not been run against a live project from this repository; step 3 is the test.
