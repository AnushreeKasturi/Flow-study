# Validation and coverage

The UI refinement has repeatable checks across every shipped JavaScript module, the HTTP server, all six HTML pages, all ten skies, and the supplied database schemas. This is a coverage inventory, not a claim that every possible state or production environment has been tested.

## Run the checks

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
```

The browser runner starts an ephemeral local server and closes it after checking the complete journey. It intercepts Supabase and media-provider traffic and uses synthetic media. Screenshots in assets/ui-preview use these fixtures. Runtime screenshots and results go to output/playwright. Failures also produce a trace ZIP and screenshot.

The runner executes ui-smoke.js and then tools-layout.js in one browser context. The layout check covers ten viewport sizes, including 1366x600 and 1440x500, verifies composer and fullscreen control bounds, checks that labels fit inside their buttons, and exercises Shift+Enter versus Enter. It also verifies the outlined f. SVG favicon loads without a runtime font dependency.

`npm test` first runs strict Astro/TypeScript diagnostics and a fresh production build. The browser suite serves that built output. Run `npm run build` before invoking the browser suite on its own. Its RTC harness compiles the real TypeScript media module with fixture signalling and is intercepted only by Playwright; it is never included in `dist` or deployed. The SDK fixture (`scripts/supabase-fixture.js`) is injected before page scripts and takes the place of the bundled Supabase client, while the actual bundled app handles interactions and callbacks. The same file powers `npm run dev:demo`; a server test asserts it never appears in built pages.

The browser suite also exercises normal motion, closing a dialog during its entrance, changing to reduced motion during an entrance, and focus restoration. Use Playwright CLI against `npm run dev` for manual debugging; the complete automated fixture setup is owned by `scripts/browser-ci.cjs`.

Database checks require an isolated local PostgreSQL server owned by a test superuser named `flow_test`. They connect only to `127.0.0.1`, create disposable `flow_ui_*` databases, and remove those databases afterward. Do not point these checks at Supabase or a shared database.

```sh
FLOW_TEST_PGPORT=55439 npm run test:db
```

## Continuous integration

The workflow in .github/workflows/ci.yml runs on PRs targeting main, pushes to main (including merges), and manual dispatch. Strict diagnostics, production builds, and Node tests run on 22, 24, and 26; migration tests use an isolated PostgreSQL 17 service; Chromium runs the browser suite; the production dependency audit fails on high/critical findings. Browser diagnostics are uploaded even on failure and retained for seven days. Configure required status checks in GitHub branch rules if merges should be blocked.

The test server clears AI and Twilio provider credentials before loading Express. CI never needs production secrets. The PostgreSQL service password is a disposable fixture value.

## Coverage inventory

| Area | Exercised behavior |
| --- | --- |
| `login.ts`, `login.astro` | Native form validation, Enter submission, service rejection recovery, signup, theme persistence, malformed stored login, logout, password visibility, interactive timer preview |
| `verify.ts`, `verify.astro` | Sign-up link: resend and cooldown, one-tap confirm, expired and someone else's links. Forgot password: address carried from login, typo check, rate-limited and failed sends, cooldown, expired link, short and unchanged passwords, saving and signing in |
| `captcha.ts` | The fixture checks tokens the way Supabase does once the captcha is on, so every sign-up, log-in, resend, and reset in the suite must send an unused token. Also: a fresh token per attempt, a refused check, and a check that could not run (no token, a plain message, and a retry that works) |
| `landing.ts`, `index.astro` | Responsive fit, hero timer start/pause/modes, atmosphere swatches, legacy invite-link redirect, opening animation skipped under reduced motion |
| `start.ts`, `start.astro` | Name validation and live greeting, sky choice, focus length by preset, slider and dragging the sun, soundscape choice, account validation, choices carried into the first room, first-session checklist |
| `groups.ts`, `board.ts`, `groups.astro` | Empty state, topic validation, hosting with subject and house rules, closing seats, unlisting on leave, search and subject filters, live status text, saying you're in, two-step reports, planning for later, Find me a seat, read-only view when signed out, inert topic text |
| Host controls (`room.ts`, `stage.ts`) | Removing a participant (database call, then the nudge), and ignoring a forged removal message |
| `room.ts`, `room.astro` | Room code/PIN validation, wrong PIN, rejected join, bounded code collisions, host/join exclusion, invite clipboard fallback, media links, leave cancellation and confirmation |
| `feedback.ts` | Inline feedback, toasts, dialog focus containment, Escape, focus restoration, inert background |
| `ui.ts` | Task reconciliation, assignment, completion, pending controls, empty states, text escaping, presence cards, progress |
| `tasks.ts` | Add/update/delete rejection, empty RLS write results, rollback, preserved draft text, in-flight duplicate prevention, task-load retry |
| `chat.ts` | Normal sends, failed delivery, AI errors and success, question retry, hostile/long text, bounded history |
| `timer.ts` | Start/pause/reset, all modes, settings bounds, rejected malformed sync, completion, wall-time catch-up after simulated throttling |
| `presence.ts`, `profile.ts` | Local/remote status, focus transitions, profile edits/failure recovery, session completion and stats refresh, matching live profile/card time, pause exclusion, save reconciliation, local-midnight accounting |
| `socket.ts` | Subscription state, tracking rejection/recovery, participant leave/rejoin grace period, disconnect and stale callback suppression |
| `rtc.ts` | Denied-media fallback, stalled TURN request deadline, local offer and answer negotiation, two received synthetic tracks, peer removal, track shutdown, late peer creation cancellation |
| `supabase.ts`, `utils.ts` | Request deadlines and caller cancellation, corrupted storage, Unicode escaping, supported YouTube/Spotify URLs and lookalike rejection |
| audio.ts | YouTube/Spotify provider switching, canonical embeds, stopping the old player, invalid link rejection, incoming room audio |
| CSS and HTML | Browser-rendered checks at 320, 390, 768, 1024, and 1440px; horizontal overflow, primary text contrast in all themes, reduced motion, desktop/mobile screenshots |
| `server.js` | Static assets and missing/private paths, malformed/type/size boundaries, unconfigured providers, rate limiting, local concurrent static requests |
| SQL | Legacy TEXT and current UUID fixtures, data preservation, repeat application, PIN checks, task isolation, author validation, publication preservation |
| Dependency lockfile | `npm audit --omit=dev`: zero reported vulnerabilities at validation time |

## Local stress results

The successful browser runs rendered 500 task rows through five reconciliations, delivered 1,000 fixture messages while retaining the most recent 300, and created 16 simulated partner tiles. Local WebRTC reached `connected` and received one audio and one video track. The suite finished without uncaught browser errors.

The HTTP checks completed 100 concurrent local static requests. These small, isolated workloads validate behavior under those conditions. They are not a benchmark of hosted capacity, a cross-network media test, or a sustained production load test. Timings depend on the test machine.

## Supabase compatibility

The supplied older schema defines `verify_room_pin`, TEXT room references, and permissive task policies. The current app expects `join_room`, participant membership, profiles, and task assignment.

For an existing database, review and stage these migrations in order:

1. `sql/002_profiles.sql`
2. `sql/003_task_assignment.sql`
3. `sql/004_room_access_compatibility.sql`

Migration 004 preserves existing rows and publications, maps recognized legacy room-code references to UUID strings, backfills membership for existing task/session authors, and replaces legacy task policies with participant checks. Unknown room references remain intact and require review. Historical author fields come from the old schema and should be reviewed before relying on their backfilled memberships.

`sql/schema.sql` is a destructive bootstrap script, not an upgrade path for an existing database. No migration was executed against the live Supabase project during this work.

## Remaining integration checks

- Validate the actual deployed schema and policies rather than assuming the shared SQL exactly matches it.
- Exercise real authentication/email delivery, live database mutations, and Supabase subscription recovery on a staging project.
- Test physical camera/microphone permissions and calls across separate devices and restrictive networks, using configured TURN credentials.
- Verify private Realtime authorization separately: table RLS and the join RPC do not establish private Broadcast-channel authorization by themselves.
- Check paid AI/TURN success paths with staging credentials and agreed request limits.
- Run Safari/Firefox, assistive-technology, long-duration, and hosted load checks before making broader compatibility/capacity claims.
