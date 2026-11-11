# Flow.

[![CI](https://github.com/ManasDasri/Flow-study/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/ManasDasri/Flow-study/actions/workflows/ci.yml)
[![Astro](https://img.shields.io/badge/Astro-7-bc52ee)](https://astro.build/)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22%20%7C%2024%20%7C%2026-5f8056)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-f4dc8f)](LICENSE)
[![Open Flow](https://img.shields.io/badge/demo-flow--study.me-b6d3ac)](https://flow-study.me)

A shared study room for focused work. Bring your group, set a timer, and work through your goals together. Free to use and open source.

![Flow landing page](assets/ui-preview/landing-desktop.png)

## Inside a room

- **The sun is the timer:** every page is a sky over a horizon. Starting a focus block starts the sun sinking for the whole room; it rises again through the break. Focus, short break, and long break lengths are adjustable, four focus blocks make a set, and the fourth earns the long break. Focus mode strips the room down to sky, sun, clock, and people.
- **Study partners:** camera and microphone controls, presence, reactions, raised hands, and encrypted peer-to-peer WebRTC calls. Video and voice never pass through Flow's servers.
- **Shared tasks:** add, assign, complete, and remove room goals with persistent storage.
- **Room chat:** send messages and ask the study assistant with `/ai`.
- **Soundscapes:** rain, ocean, fireplace, wind, night, and a deep hum, each synthesized in the browser from filtered noise. Only you hear them; no audio files are downloaded.
- **Study groups (`/groups.html`):** open your room to a public board with a topic and two to six seats, or take a seat in someone else's. Listings disappear when the host leaves.
- **Arrivals and departures:** a soft chime, and a tile that says who left before it clears.
- **Room audio:** share YouTube or Spotify links through the official embedded players. Everyone controls their own playback, and no player loads until someone asks for one.
- **Your focus:** today's total, a streak, and a seven-day chart. Pauses do not count. Completed focus sessions are saved; progress from an unfinished session is lost on refresh.
- **Ten skies:** Forest, Midnight, Warm, Aqua, Amethyst, Desert, Aurora, Storm, Dawn, and Daylight. Sky, ground, and sun all take their colours from the one you choose.
- **Keyboard shortcuts:** `S` timer, `F` focus mode, `M` microphone, `V` camera, `?` for the list.
- **Optional notifications:** a system notification when a session ends while Flow is in a background tab.
- **Interactive setup (`/start.html`):** name, sky, focus length (drag the sun), and a soundscape preview, then the account. The choices carry into the first room, which shows a short first-session checklist. An invite link survives sign-in.

![Flow setup](assets/ui-preview/setup-desktop.png)


## Run locally

Use Node.js 22.23.4 or newer. CI exercises the latest releases of Node 22, 24, and 26.

```sh
git clone https://github.com/ManasDasri/Flow-study.git
cd Flow-study
npm ci
npm run dev:demo
```

Open `http://localhost:4321`. `dev:demo` replaces Supabase with the in-browser stand-in the tests use ([`scripts/supabase-fixture.js`](scripts/supabase-fixture.js)), so the whole app runs offline with one fake account and no keys. Log in with any email and a six-character password. Add `?nocam` to the room URL to skip the camera prompt, or `?fresh` to see first-run setup.

To develop against a real backend, copy `.env.example` to `.env` and run `npm run dev`. Astro provides live reload and forwards `/api/*` to the Express handlers.

To run the production build locally:

```sh
npm run build
npm start
```

The production server uses `http://localhost:3000`; set `PORT` to change that port.

The Supabase project URL and **public publishable key** live in [`supabase.config.json`](supabase.config.json), shared by the browser bundle and the server. For your own deployment, edit that file or set `PUBLIC_SUPABASE_URL` and `PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Never put a service-role key there.

### Server configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port; defaults to `3000` |
| `GROQ_API_KEY` | Optional; enables `/api/ai` for study-assistant questions |
| `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Optional; override `supabase.config.json` at build time and on the server |
| `TWILIO_ACCOUNT_SID` | Optional; used with the auth token to obtain TURN credentials |
| `TWILIO_AUTH_TOKEN` | Optional; server-side Twilio credential |

Keep `.env` out of version control. Without Groq, rooms still work and AI requests return a configuration message. Without TURN credentials, calls fall back to STUN and may fail across restrictive networks. Spotify embeds require no application API key; available playback depends on Spotify, the user's account, and browser permissions. YouTube availability depends on the video's embedding permissions.

### Supabase setup

Enable email/password authentication and configure your site URL, redirect URLs, and confirmation email delivery. The UI supports both immediate sessions and email-confirmation flows.

For a **new, empty database**, run these files in order in the Supabase SQL editor:

1. [`sql/schema.sql`](sql/schema.sql)
2. [`sql/002_profiles.sql`](sql/002_profiles.sql)
3. [`sql/003_task_assignment.sql`](sql/003_task_assignment.sql)
4. [`sql/004_room_access_compatibility.sql`](sql/004_room_access_compatibility.sql)
5. [`sql/005_open_rooms_and_limits.sql`](sql/005_open_rooms_and_limits.sql) (study-groups board and text size limits; the board page reports that it is not set up until this has run)

**`schema.sql` drops existing tables. Do not run it as an upgrade on a database with data.** For an existing installation, use the additive migration sequence and compatibility notes in [TESTING.md](TESTING.md#supabase-compatibility).

The app uses profiles, rooms, room participants, tasks, sessions, the `join_room` RPC, and task Realtime updates. Migration 004 supports the older TEXT room references and the newer UUID schema, preserves existing rows, and scopes task access to room participants.

Database RLS protects table access. Private Realtime Broadcast authorization needs its own coordinated policies and client configuration; it is a separate production-hardening task.

## Shared-link preview

All pages include static Open Graph and large-image card metadata, with a branded 1200 × 630 PNG at `/social-preview.png`. Room invitations use the same generic preview; room codes and PINs are not included in the card metadata.

The artwork source is [`scripts/social-preview.html`](scripts/social-preview.html). After editing it, regenerate the committed image:

```sh
npx playwright install chromium
npm run preview:social
```

Generation loads Instrument Sans from Google Fonts; the deployed PNG has no font or browser dependency. CI checks that crawlers can fetch the metadata and correctly sized image without authentication. Social apps control their own preview caches, so existing shared links may take time to refresh.

## Architecture

Astro generates six static pages: the landing page (`/`), setup (`/start.html`), sign-in (`/login.html`), the room (`/room.html`), the study-groups board (`/groups.html`), and docs (`/docs.html`). Strict TypeScript powers the room, Vite bundles and fingerprints everything into `dist/_astro`, and fonts are self-hosted, so the only third-party requests are to Supabase, plus YouTube or Spotify when a player is requested and GitHub for the landing page's star count. No client framework runtime is needed.

| Location | Responsibility |
| --- | --- |
| `src/pages` | Landing, setup, login, room, study groups, and docs templates |
| `src/layouts`, `src/components` | Shared metadata, page layout, icons, room sections, and dialogs |
| `src/client` | `landing.ts`, `start.ts`, `login.ts`, `room.ts`, and the room's modules (timer, tasks, realtime, WebRTC, soundscape, shortcuts) |
| `src/styles` | Design tokens and shared controls (`global.css`), then one stylesheet per page |
| `public` | Images, favicon, and social preview copied unchanged to the build |
| `api`, `server.js` | AI/TURN functions and the conventional Node server |
| `supabase.config.json`, `vercel.json` | Public backend settings; hosting config and the security headers Express reuses |

Supabase handles authentication, PostgreSQL persistence, task changes, presence, and room broadcasts. WebRTC carries camera and microphone media between peers, with TURN relay support when configured. Groq answers assistant requests through the server. Room chat and broadcasts are transient; tasks, profiles, and completed sessions are stored.

`/api/ai` and `/api/turn-credentials` spend provider credit, so they require a signed-in user: the browser sends its Supabase access token and the server asks Supabase to validate it before calling Groq or Twilio. Both stay rate limited per address. Every page is served with a Content-Security-Policy and related headers, defined once in `vercel.json`.

Old invite links (`/?room=CODE`) redirect to the room. The landing page's opening (the wordmark in the dark, then a sunrise) is CSS only, plays once per browser session, and is skipped under reduced motion. Type is Bricolage Grotesque, self-hosted.

## License

Flow is released under the [MIT License](LICENSE).

## Contributing, security, and launch material

- [CONTRIBUTING.md](CONTRIBUTING.md): how to run, test, and send a change.
- [SECURITY.md](SECURITY.md): what is protected today, what is not yet, and how to report a problem.
- [marketing/launch-kit.md](marketing/launch-kit.md): descriptions, posts, and the image list for sharing Flow.

## Checks and CI

```sh
npm test
npx playwright install chromium
npm run test:browser
```

The browser command starts and stops its own local server. It tests login through leaving/rejoining a room with isolated Supabase/provider fixtures and synthetic media. No live user data, camera, microphone, or paid provider calls are used.

For database tests, start an isolated local PostgreSQL server with a test superuser named `flow_test`:

```sh
FLOW_TEST_PGPORT=55439 npm run test:db
```

The database suite creates and removes throwaway databases on `127.0.0.1`. See [TESTING.md](TESTING.md) for setup, coverage, and integration limits.

GitHub Actions runs on pull requests to `main`, pushes/merges to `main`, and manual dispatch:

| Check | What it verifies |
| --- | --- |
| Node.js 22 / 24 / 26 | Strict Astro/TypeScript checks, production builds, JavaScript parsing, HTTP boundaries, endpoint authentication, security headers, local concurrency, URL validation, and focus accounting |
| PostgreSQL 17 | Both schema variants, migration repeatability, preserved data, room/PIN access, and task policies |
| Chromium | Complete interactive flows, failure recovery, stress fixtures, and ten responsive tool layouts |
| Dependency audit | Production dependencies fail the job on reported high/critical vulnerabilities |

Browser screenshots, results, and failure traces are uploaded as `browser-diagnostics` and retained for seven days. A failing check marks the run red. To block merges, configure the desired checks as required in the repository's branch rules.

## Deploy

For free CDN hosting, use the included `vercel.json`: Astro builds the `dist` directory, which is served directly by the CDN, and the two files in `api` expose the existing Express endpoints as Node functions. This keeps Render's web-service startup out of page loads. See [HOSTING.md](HOSTING.md) for credentials, domain cutover, verification, and rollback.

Conventional Node hosting remains supported with `npm ci`, `npm run build`, and `npm start`. Build dependencies must be installed before generating `dist`. Serve the public site over HTTPS for camera/microphone access. Keep server credentials in the host's secret settings.

Before a wider launch, validate live authentication, two-account room behavior, physical media across networks, TURN, provider success paths, and browser compatibility. Local fixture stress checks are documented measurements, not a hosted-capacity guarantee.
