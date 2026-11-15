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

## Picking up an issue

1. Read the issue, then **describe your approach in a comment**: what you'd change, where, and how you'd test it. A few sentences is plenty.
2. Then comment **`/take`**. The bot assigns the issue to you, but only once your approach is there, and only if nobody else has it. That way an issue goes to the clearest plan, not the fastest reply.
3. Can't finish it? Comment **`/drop`** so someone else can pick it up.

Every pull request gets an automatic comment checking that it links its issue (`Closes #12`), that the issue is assigned to you, and that the description is filled in. A review from the maintainer is requested for you automatically, so you don't need to ask for one. The **Style** check in CI looks only at the lines you add: no trailing whitespace or tabs, no leftover `console.log` or `debugger`.

## Before you open a pull request

```sh
npm test                 # type check, production build, server and unit tests
npx playwright install chromium   # first time only
npm run test:browser     # full journey in a real browser, against the build
```

Both must pass. CI runs the same commands on Node 22, 24, and 26, plus the database migrations against PostgreSQL 17 and a dependency audit. `main` only accepts changes through a pull request whose checks are green.

If you change the database, add a new numbered file in `sql/` (never edit an applied one), make it safe to run twice, and extend `scripts/sql-integration.test.cjs`.

## Merging and releasing (maintainers)

Merging to `main` deploys flow-study.me. Some of what the site needs lives outside this repository, so a green CI run isn't the whole story.

**Merging**
- Merge only the commit you reviewed: `gh pr merge N --squash --match-head-commit <sha>`, or check the commit list right before pressing the button. If someone pushes after your review, review again.
- A PR stacked on another branch: merge the base first. Its branch is deleted on merge, and GitHub then retargets the stacked PR to `main`.

**When a change needs the live setup changed too**
- *A new `sql/` file:* run it in the Supabase SQL editor **before** merging the code that uses it, in number order. Then add a check for it to `scripts/check-live.cjs` (it currently looks for `rooms.timer`, from 017).
- *A sign-in provider:* switch it on in Supabase (Authentication → Sign In / Providers) first, then add it to `oauthProviders` in `supabase.config.json`.
- *Auth emails or redirects:* Supabase → Authentication → URL Configuration must have **Site URL** `https://flow-study.me` (never localhost) and redirect URLs for `/login.html` and `/verify.html`. The templates in `emails/` (Confirm signup, Reset password) are pasted into Authentication → Emails → Templates; paste one again whenever it changes. Without them, Supabase's default emails link to its own page and `/verify.html` can't use them.
- *The captcha:* put the Turnstile site key in `captchaSiteKey` (`supabase.config.json`) and let it deploy **before** turning on captcha protection in Supabase (Authentication → Attack Protection, with the secret key). The other way round, every sign-up, log-in, and auth email is refused until the deploy lands. To turn it off, reverse the order. See the README.
- *Password rules:* Authentication → Sign In / Providers → Email keeps **Minimum password length** at 8 (what the site asks for) and **Require current password when updating** off, since a password reset has no current password to give.

**After it deploys**
- Run `npm run check:live`. It also runs daily and opens a `live-check` issue when something drifts.
- It can't see the settings above that aren't public: the Supabase Site URL, and the domains on Google's OAuth branding page (`flow-study.me` and `mrjtkxwenqswbjplmzko.supabase.co`). After touching either, sign up once with a new address and sign in once with Google.
- Anything that changes rooms (calls, the timer, hosting, leaving): try it with two windows, one of them incognito.
- Browser errors from real visitors appear in the Vercel logs as `[client-error]` lines.

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
