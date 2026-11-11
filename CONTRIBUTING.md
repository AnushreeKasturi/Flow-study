# Contributing to Flow

Thanks for wanting to help. Flow is small enough to understand in an afternoon, and this page is everything you need to send a change.

## Run it

You need Node.js 22.23.4 or newer.

```sh
git clone https://github.com/ManasDasri/Flow-study.git
cd Flow-study
npm ci
npm run dev:demo
```

Open `http://localhost:4321`. `dev:demo` swaps Supabase for an in-browser stand-in, so every page works offline with one fake account and no keys. Log in with any email and a six-character password.

Useful URL switches in demo mode: `?nocam` skips the camera prompt, `?fresh` shows first-run setup in the lobby, and `/groups.html?board` seeds the study-groups board.

To work against a real backend, copy `.env.example` to `.env`, set your own Supabase project in `supabase.config.json`, apply the files in `sql/` in order, and run `npm run dev`.

## Where things are

| Path | What lives there |
| --- | --- |
| `src/pages` | One `.astro` file per page: landing, setup, login, room, study groups, docs |
| `src/components` | Shared markup; `room/` holds the room's sections and dialogs |
| `src/client` | Browser code. One entry file per page, plus `modules/` for the room |
| `src/styles` | `global.css` (tokens, skies, shared controls) and one stylesheet per page |
| `sql` | Database migrations, applied in numeric order |
| `scripts` | Tests, the Supabase fixture, and the social-preview generator |
| `server.js`, `api/` | The two server endpoints (assistant and TURN credentials) |

## Before you open a pull request

```sh
npm test                 # type check, production build, server and unit tests
npx playwright install chromium   # first time only
npm run test:browser     # full journey in a real browser, against the build
```

Both must pass. CI runs the same commands on Node 22, 24, and 26, plus the database migrations against PostgreSQL 17 and a dependency audit. `main` only accepts changes through a pull request whose checks are green.

If you change the database, add a new numbered file in `sql/` (never edit an applied one), make it safe to run twice, and extend `scripts/sql-integration.test.cjs`.

## What a good change looks like

- **Small and focused.** One idea per pull request. Say what changed and why in the description, and add a screenshot for anything visual.
- **Tested.** New behaviour gets a check in `scripts/ui-smoke.js` or a unit test. If you fix a bug, add the check that would have caught it.
- **Plain.** Reach for the platform first: native elements, CSS, the standard library. Add a dependency only when a few lines of your own won't do.
- **Safe with other people's text.** Names, tasks, and chat come from strangers. Put them in the page with `textContent` or DOM methods, never by building HTML strings.
- **Accessible.** Controls need a name, keyboard access, and visible focus. Motion respects `prefers-reduced-motion`.
- **Honest copy.** Interface text says what a thing does, in plain words. Don't describe features that don't exist.

## Design in one paragraph

The timer is a sun. Every page is a flat sky over a horizon, and the sun is the only round, glowing thing on it; avatars and other markers are squared so they are never mistaken for it. Type is Bricolage Grotesque, condensed and heavy for headlines and the clock. Colour comes from the ten skies in `src/styles/global.css`: use the tokens (`--bg`, `--surface`, `--text`, `--primary`, `--sun`), never fixed colours, so a change works in every sky.

## Reporting problems

Open an [issue](https://github.com/ManasDasri/Flow-study/issues) with what you did, what you expected, and what happened. For anything security-related, follow [SECURITY.md](SECURITY.md) instead of filing a public issue.
