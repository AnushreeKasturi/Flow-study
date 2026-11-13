require('dotenv').config();

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const supabaseDefaults = require('./supabase.config.json');
const { headers: hostingHeaders } = require('./vercel.json');

const app = express();
app.disable('x-powered-by');
// Vercel replaces X-Forwarded-For with the client address at its edge.
if (process.env.VERCEL) app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL || supabaseDefaults.url;
const SUPABASE_KEY = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || supabaseDefaults.publishableKey;
// Server-only. With it, usage is recorded by the server (sql/016) and browsers cannot touch the quota.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// One definition of the security headers: vercel.json sends them from the CDN,
// and this applies the same list when Express serves the site itself.
const securityHeaders = hostingHeaders.find(rule => rule.source === '/(.*)').headers;
app.use((req, res, next) => {
    for (const { key, value } of securityHeaders) res.set(key, value);
    next();
});

// Astro's generated pages and fingerprinted assets.
app.use(express.static(path.join(__dirname, 'dist')));
app.use(express.json({ limit: '16kb' }));
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});

// Both endpoints spend provider credit, so they only answer signed-in Flow
// users, within a per-account quota. One database call does both: api_allow()
// (sql/008) runs as the caller, so it fails without a valid token, and it
// counts the request in one place for every server instance.
const refuse = (res, status, text) => res.status(status).json({ text, error: text });
const supabaseCall = (path, token, body) => fetch(SUPABASE_URL + path, {
    method: body ? 'POST' : 'GET',
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(4000)
});
// The server's own call to the quota. Newer Supabase secret keys (sb_secret_…) go in the
// apikey header only; the older service_role JWT is also sent as the bearer token.
const serviceQuota = (userId, kind) => fetch(SUPABASE_URL + '/rest/v1/rpc/api_allow_for', {
    method: 'POST',
    headers: { apikey: SERVICE_KEY, ...(SERVICE_KEY.startsWith('sb_') ? {} : { Authorization: 'Bearer ' + SERVICE_KEY }), 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_user: userId, p_kind: kind }),
    signal: AbortSignal.timeout(4000)
});
const requireUser = kind => async (req, res, next) => {
    const token = /^Bearer (\S+)$/.exec(req.get('authorization') || '')?.[1];
    if (!token) return refuse(res, 401, 'Sign in to use this.');
    try {
        if (SERVICE_KEY) {
            // Who is asking comes from Supabase Auth; how much they may use, from the server's own call.
            const who = await supabaseCall('/auth/v1/user', token);
            if (who.status === 401 || who.status === 403) return refuse(res, 401, 'Your sign-in has expired. Log in again.');
            if (!who.ok) return refuse(res, 503, 'Sign-in could not be checked. Try again shortly.');
            const { id } = await who.json();
            const quota = await serviceQuota(id, kind);
            if (quota.ok) return await quota.json() === true ? next() : refuse(res, 429, 'You have reached the limit for now. Try again in a little while.');
            if (quota.status !== 404) return refuse(res, 503, 'Sign-in could not be checked. Try again shortly.');
            // sql/016 is not installed yet: count it the older way, below.
        }
        let response = await supabaseCall('/rest/v1/rpc/api_allow', token, { p_kind: kind });
        if (response.status === 404) {
            // The quota function is not installed (sql/008 not run): fall back to checking the sign-in only.
            response = await supabaseCall('/auth/v1/user', token);
            if (response.ok) return next();
        } else if (response.ok) {
            if (await response.json() === true) return next();
            return refuse(res, 429, 'You have reached the limit for now. Try again in a little while.');
        }
        if (response.status === 401 || response.status === 403) return refuse(res, 401, 'Your sign-in has expired. Log in again.');
        refuse(res, 503, 'Sign-in could not be checked. Try again shortly.');
    } catch {
        refuse(res, 503, 'Sign-in could not be checked. Try again shortly.');
    }
};

const limiter = max => rateLimit({
    windowMs: 60 * 1000, limit: max, standardHeaders: true, legacyHeaders: false,
    message: { text: 'Too many requests. Try again in a minute.', error: 'Too many requests.' }
});

const hasGroqApiKey = Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here');
const groq = hasGroqApiKey ? new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 15000, maxRetries: 0 }) : null;

// The assistant can set a reminder for the person asking. It only describes the
// reminder; normalizeReminder() decides what is acceptable and when it is due.
const REMINDER_TOOL = {
    type: 'function',
    function: {
        name: 'set_reminder',
        description: 'Set a reminder for the person asking. Use only when they ask to be reminded of something.',
        parameters: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'What to remind them about, short, in their own words.' },
                minutes_from_now: { type: 'integer', description: 'For a delay such as "in 20 minutes".' },
                local_time: { type: 'string', description: 'For a clock time such as "at 6pm": 24-hour HH:MM in their local time.' },
                timer: { type: 'string', enum: ['break', 'focus'], description: 'When tied to the study timer: the next break, or the next focus block.' }
            },
            required: ['text']
        }
    }
};

// Turns the model's description into a reminder the browser can schedule, or null.
// `tz` is the browser's getTimezoneOffset(): minutes to add to local time to get UTC.
function normalizeReminder(args, { now = Date.now(), tz = 0 } = {}) {
    const text = typeof args?.text === 'string' ? args.text.trim().slice(0, 120) : '';
    if (!text) return null;
    if (args.timer === 'break' || args.timer === 'focus') return { text, trigger: args.timer };
    const minutes = Number(args.minutes_from_now);
    if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 1440) return { text, at: new Date(now + minutes * 60000).toISOString() };
    const clock = typeof args.local_time === 'string' && /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(args.local_time.trim());
    if (clock) {
        // Work on the person's wall clock: today at that time, or tomorrow if it has passed.
        const local = new Date(now - tz * 60000);
        let target = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), Number(clock[1]), Number(clock[2]));
        if (target <= local.getTime()) target += 24 * 60 * 60000;
        return { text, at: new Date(target + tz * 60000).toISOString() };
    }
    return null;
}

app.post('/api/ai', limiter(10), requireUser('ai'), async (req, res) => {
    try {
        const message = req.body?.message;
        if (typeof message !== 'string' || !message.trim() || message.length > 500) {
            return res.status(400).json({ text: 'Enter a message between 1 and 500 characters.' });
        }
        const tz = Number.isInteger(req.body?.tz) && Math.abs(req.body.tz) <= 840 ? req.body.tz : 0;
        if (!groq) return res.status(503).json({ text: 'The study assistant is not configured on this server.' });

        const localNow = new Date(Date.now() - tz * 60000).toISOString().slice(0, 16).replace('T', ' ');
        const completion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: `You are a study buddy in the chat of a shared study room. Reply like a friendly person in a chat, not an article: a few short sentences, usually under 80 words. Use a short numbered list only when there are real steps, bold only the one or two words that matter most, and no headings or tables. Use plain, encouraging language. The person's local time is ${localNow}. If they ask to be reminded of something, call set_reminder instead of replying.` },
                { role: 'user', content: message }
            ],
            // Groq retired llama-3.1-8b-instant on 2026-08-16; this is its designated replacement.
            model: 'openai/gpt-oss-20b',
            tools: [REMINDER_TOOL],
            tool_choice: 'auto',
            max_completion_tokens: 700 // an answer for a chat panel, and a bound on what one request can cost
        });
        const reply = completion.choices[0].message;
        const call = reply.tool_calls?.find(item => item.function?.name === 'set_reminder');
        if (call) {
            let args = null;
            try { args = JSON.parse(call.function.arguments); } catch { /* treated as no reminder */ }
            const reminder = normalizeReminder(args, { tz });
            if (reminder) return res.json({ text: '', reminder });
            return res.json({ text: 'I couldn’t work out when to remind you. Try “remind me in 20 minutes to stretch”, or use /remind.' });
        }
        res.json({ text: reply.content || 'I don’t have an answer for that.' });
    } catch (error) {
        console.error('AI error:', error);
        res.status(500).json({ text: 'The study assistant could not answer. Try again.' });
    }
});

app.post('/api/turn-credentials', limiter(20), requireUser('turn'), async (req, res) => {
    try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        if (!accountSid || !authToken) return res.status(500).json({ error: 'Twilio credentials not configured on server.' });

        const client = twilio(accountSid, authToken, { timeout: 4000, autoRetry: false });
        const token = await client.tokens.create({ ttl: 3600 }); // relay credentials good for one hour, not Twilio's default day
        res.json({ iceServers: token.iceServers });
    } catch (error) {
        console.error('TURN error:', error);
        res.status(500).json({ error: 'Failed to generate TURN credentials' });
    }
});

app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ text: 'Request is too large.' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ text: 'Request must contain valid JSON.' });
    console.error('Request failed:', error);
    res.status(500).json({ text: 'This request could not be completed.' });
});

if (require.main === module) app.listen(PORT, () => console.log(`Flow running on port ${PORT}`));
module.exports = app;
module.exports.normalizeReminder = normalizeReminder; // for scripts/server.test.cjs
