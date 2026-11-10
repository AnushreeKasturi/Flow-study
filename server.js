require('dotenv').config();

const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');
const Groq = require('groq-sdk');
const supabaseDefaults = require('./supabase.config.json');
const { headers: hostingHeaders } = require('./vercel.json');

const app = express();
// Vercel replaces X-Forwarded-For with the client address at its edge.
if (process.env.VERCEL) app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.PUBLIC_SUPABASE_URL || supabaseDefaults.url;
const SUPABASE_KEY = process.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || supabaseDefaults.publishableKey;

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
// users. Supabase validates the caller's access token; no secret is needed.
async function requireUser(req, res, next) {
    const token = /^Bearer (\S+)$/.exec(req.get('authorization') || '')?.[1];
    if (!token) return res.status(401).json({ text: 'Sign in to use this.', error: 'Sign in to use this.' });
    try {
        const response = await fetch(SUPABASE_URL + '/auth/v1/user', {
            headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + token },
            signal: AbortSignal.timeout(4000)
        });
        if (response.ok) return next();
        const expired = response.status === 401 || response.status === 403;
        res.status(expired ? 401 : 503).json(expired
            ? { text: 'Your sign-in has expired. Log in again.', error: 'Your sign-in has expired. Log in again.' }
            : { text: 'Sign-in could not be checked. Try again shortly.', error: 'Sign-in could not be checked.' });
    } catch {
        res.status(503).json({ text: 'Sign-in could not be checked. Try again shortly.', error: 'Sign-in could not be checked.' });
    }
}

const limiter = max => rateLimit({
    windowMs: 60 * 1000, limit: max, standardHeaders: true, legacyHeaders: false,
    message: { text: 'Too many requests. Try again in a minute.', error: 'Too many requests.' }
});

const hasGroqApiKey = Boolean(process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here');
const groq = hasGroqApiKey ? new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 15000, maxRetries: 0 }) : null;

app.post('/api/ai', limiter(10), requireUser, async (req, res) => {
    try {
        const message = req.body?.message;
        if (typeof message !== 'string' || !message.trim() || message.length > 500) {
            return res.status(400).json({ text: 'Enter a message between 1 and 500 characters.' });
        }
        if (!groq) return res.status(503).json({ text: 'The study assistant is not configured on this server.' });

        const completion = await groq.chat.completions.create({
            messages: [
                { role: 'system', content: 'You are a helpful study assistant in a virtual study room. Answer concisely.' },
                { role: 'user', content: message }
            ],
            // Groq retired llama-3.1-8b-instant on 2026-08-16; this is its designated replacement.
            model: 'openai/gpt-oss-20b'
        });
        res.json({ text: completion.choices[0].message.content });
    } catch (error) {
        console.error('AI error:', error);
        res.status(500).json({ text: 'The study assistant could not answer. Try again.' });
    }
});

app.post('/api/turn-credentials', limiter(20), requireUser, async (req, res) => {
    try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        if (!accountSid || !authToken) return res.status(500).json({ error: 'Twilio credentials not configured on server.' });

        const client = twilio(accountSid, authToken, { timeout: 4000, autoRetry: false });
        const token = await client.tokens.create();
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
