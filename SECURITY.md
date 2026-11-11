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
| Study-groups board | A room's internal id is never exposed; seats are handed out by a database function that checks capacity under a row lock; listing expiry uses the server's clock; a seat is passed to the room page in session storage, so no link can join a room on someone's behalf |
| Text from other people | Names, tasks, and chat are always inserted as text, never as HTML. Tests feed markup through every one of these paths and assert it stays inert |
| Shared audio links | Only real YouTube and Spotify hosts are accepted, converted to the official embed URL, and the Content-Security-Policy allows frames from those two origins only |
| Assistant and TURN endpoints | Require a signed-in user (the server validates the caller's Supabase token), are rate limited per address, and keep provider keys on the server. TURN credentials are short-lived tokens issued per request |
| Assistant | Receives only the text typed after `/ai`. It has no access to the database, the room, or earlier messages, and nothing is kept after the reply |
| Pages | Content-Security-Policy, `nosniff`, a referrer policy, a permissions policy limiting camera and microphone to this site, HSTS, and no framing by other sites |
| Video and voice | Encrypted by WebRTC (DTLS-SRTP) with keys negotiated between the two browsers on each call. Media goes directly between browsers when a direct path exists; otherwise a TURN relay forwards the encrypted packets without being able to read them. Flow's servers never receive media |
| Abuse inside a room | Timer messages are throttled when sent and flood-limited when received; ICE candidates are capped per peer |

## Known limits

These are real gaps. They are listed so nobody assumes more than is true.

- **Room channels are not private yet.** Presence, chat, timer, and call-setup messages travel over a Supabase Realtime channel named after the room's internal id. That id is a random UUID and is not exposed by the app, but the channel does not yet verify membership. The fix is Supabase Realtime Authorization: private channels plus policies on `realtime.messages`. It needs dashboard configuration alongside a client change, so it has to be rolled out together, not from code alone. Until then, a participant can also send messages under another participant's id.
- **Chat and tasks are not end-to-end encrypted.** Task text is readable by the database operator, and chat passes through the realtime service in readable form. Calls are encrypted between browsers, but the keys are agreed over the room's signalling channel, which is not yet authenticated (see the point above), so the encryption does not by itself prove who is on the other end. A shared room key agreed between browsers and applied to chat, tasks, and media frames would close this; it has not been started.
- **Room codes are six characters** from a 31-character alphabet (about 887 million combinations), with an optional four-digit PIN. Joins are not yet rate limited per account, so a code should be treated as an invitation, not a secret.
- **Group size is enforced on the board, not on direct joins.** Someone who already has a room's code can join even if its board listing is full.
- **The shared timer trusts participants.** Anyone in a room can start, pause, or reset it; that is the feature. Each browser counts down from its own clock.
- **Rate limits are per server instance.** On serverless hosting they are not a global quota.
