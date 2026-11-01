# Free CDN hosting

Flow serves its HTML, CSS, browser modules, favicon, and social image directly from Vercel's CDN. Only `/api/ai` and `/api/turn-credentials` invoke Node functions. Supabase continues to handle auth, data, and Realtime; WebRTC media stays peer-to-peer or uses the configured TURN provider.

This removes Render's sleeping web service from the page-delivery path. Functions can still have startup/provider latency, and hosting/provider usage limits still apply. No keep-alive pings or paid Render instance are required.

## Project settings

- Project: `flow-study`, in `manas-projects-e9259329` (verified Hobby scope).
- Framework: Other; `vercel.json` explicitly sets `framework: null`.
- Build command: `npm run build` (Astro static generation).
- Output directory: `dist`.
- Install command: `npm ci`; TypeScript and build tools are needed during deployment.
- API functions reuse the tested Express handlers; `public`, `src`, and `dist` are excluded from their bundles. Set Node.js to a supported version (at least 22.23.4).
- Git repository: `ManasDasri/Flow-study`, production branch `main`.

The project is connected to GitHub for automatic deployments after merges. Keep the existing GitHub CI checks enabled. Deployment files and local credentials under `.vercel` are ignored by Git; only the generated `dist` directory is statically served, and `.env`, SQL, tests, and screenshots are excluded from uploads.

## Move server credentials

In Vercel Project Settings → Environment Variables, copy these values directly from Render into Production, and redeploy after saving. Add them to Preview only if provider calls are needed in preview deployments:

| Name | Purpose |
| --- | --- |
| `GROQ_API_KEY` | Study-assistant requests |
| `TWILIO_ACCOUNT_SID` | TURN credential requests |
| `TWILIO_AUTH_TOKEN` | Server-side Twilio authentication |

Do not put these values in public files, Git, or chat. Existing Supabase public configuration and database migrations remain unchanged. If any Supabase email redirect allowlist is restricted to the custom domain, add the deployment URL only when testing email redirects there; keeping `flow-study.me` preserves the existing production origin.

## Check before switching DNS

1. Verify the new Vercel URL serves the real login page and the current static assets without Vercel authentication.
2. Confirm `/server.js`, `/.env`, and `/sql/schema.sql` return 404.
3. Verify AI and TURN endpoints return JSON, with `Cache-Control: private, no-store`. Test one provider request after copying credentials.
4. Run the browser suite and Node tests. The browser suite deliberately stalls TURN and verifies that local WebRTC setup continues after about five seconds.
5. Preserve the existing Namecheap apex record value for rollback before changing it. Use the exact DNS destination shown in Vercel's domain settings. Change only the web record for `flow-study.me`; leave mail and other unrelated records alone.
6. Wait for Vercel domain/TLS verification, then check the custom domain, social image, login, room code links, and provider endpoints again.
7. Keep Render available until the custom-domain checks pass. Do not delete the old service as part of the cutover.

Current domain configuration is visible at:
https://vercel.com/manas-projects-e9259329/flow-study/settings/domains

The apex A record was switched from Render (`216.24.57.1`) to Vercel (`216.198.79.1`) on October 31, 2026. Re-check Vercel's domain settings before any later DNS change. Do not change nameservers or unrelated MX/TXT records. The saved Render value is the rollback destination.

## Latency and limits

Both pages load the native HTML Speed Insights integration. It loads Vercel's deferred performance script on the custom domain and Vercel deployment URLs, strips query strings/fragments from reported URLs, and stays disabled on localhost. Enable Speed Insights in the project's dashboard to see incoming real-user measurements; the integration is bundled by Astro and does not require a Next.js component. The fixture browser suite intercepts telemetry so synthetic stress runs do not enter the dashboard. No paid Insights upgrade is enabled by this code.

The browser loads the site without waiting for an API function. Groq has a 15-second request deadline without SDK retries. Twilio token requests have a four-second deadline, and the browser stops waiting for TURN after five seconds and continues with STUN. STUN-only calls may still fail on restrictive networks; a working TURN configuration remains important.

The existing API request limits remain in Express. Those counters are local to each function instance, so they are not a global distributed quota. Monitor provider and Hobby usage before increasing traffic; distributed quotas can be added when needed.

Local development uses `npm ci` followed by `npm run dev` on port 4321. For the production server, run `npm run build` and then `npm start`. The Astro migration changes page generation and bundling without changing the database or provider endpoints.

To run the isolated browser fixture suite against a deployed frontend instead of a local server:

```sh
FLOW_TEST_ORIGIN=https://your-deployment.vercel.app npm run test:browser
```

This loads deployed HTML/CSS/modules while intercepting Supabase and provider requests. It does not test real credentials or mutate the live database.
