require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const rateLimit = require('express-rate-limit');
const twilio = require('twilio');

const app = express();
// Vercel replaces X-Forwarded-For with the client address at its edge.
if (process.env.VERCEL) app.set('trust proxy', 1);
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;

// Rate limiting for API endpoints
const aiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // Limit each IP to 10 requests per `window` (here, per minute)
    message: { text: "Too many requests to the AI endpoint, please try again after a minute." },
    standardHeaders: true,
    legacyHeaders: false,
});

// Serve Astro's generated production pages and fingerprinted assets.
app.use(express.static(path.join(__dirname, 'dist')));
app.use(express.json({ limit: '16kb' }));
app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
});

// AI Chat Route
const Groq = require('groq-sdk');
const hasGroqApiKey = Boolean(
    process.env.GROQ_API_KEY && process.env.GROQ_API_KEY !== 'your_groq_api_key_here'
);
const groq = hasGroqApiKey ? new Groq({ apiKey: process.env.GROQ_API_KEY, timeout: 15000, maxRetries: 0 }) : null;

app.post('/api/ai', aiLimiter, async (req, res) => {
    try {
        const message = req.body?.message;
        if (typeof message !== 'string' || !message.trim() || message.length > 500) {
            return res.status(400).json({ text: 'Enter a message between 1 and 500 characters.' });
        }
        if (!groq) {
            return res.status(503).json({ text: "AI assistant is not configured on this server yet." });
        }

        
        const completion = await groq.chat.completions.create({
            messages: [
                { role: "system", content: "You are a helpful study assistant in a virtual study room. Answer concisely." },
                { role: "user", content: message }
            ],
            // llama-3.1-8b-instant was deprecated by Groq (shut down 08/16/26);
            // openai/gpt-oss-20b is Groq's designated replacement — fast and
            // well-suited to a chat assistant.
            model: "openai/gpt-oss-20b",
        });
        res.json({ text: completion.choices[0].message.content });
    } catch (e) {
        console.error("AI Error:", e);
        res.status(500).json({ text: "Sorry, I am having trouble connecting to my brain right now." });
    }
});

// Twilio TURN Credentials Route
const turnLimiter = rateLimit({ windowMs: 60000, limit: 20, standardHeaders: true, legacyHeaders: false });
app.post('/api/turn-credentials', turnLimiter, async (req, res) => {
    try {
        const accountSid = process.env.TWILIO_ACCOUNT_SID;
        const authToken = process.env.TWILIO_AUTH_TOKEN;
        
        if (!accountSid || !authToken) {
            return res.status(500).json({ error: "Twilio credentials not configured on server." });
        }
        
        const client = twilio(accountSid, authToken, { timeout: 4000, autoRetry: false });
        const token = await client.tokens.create();
        
        res.json({ iceServers: token.iceServers });
    } catch (e) {
        console.error("TURN Error:", e);
        res.status(500).json({ error: "Failed to generate TURN credentials" });
    }
});
app.use((error, req, res, next) => {
    if (error.type === 'entity.too.large') return res.status(413).json({ text: 'Request is too large.' });
    if (error instanceof SyntaxError && error.status === 400) return res.status(400).json({ text: 'Request must contain valid JSON.' });
    console.error('Request failed:', error);
    res.status(500).json({ text: 'This request could not be completed.' });
});
if (require.main === module) server.listen(PORT, () => console.log(`Flow static server running on port ${PORT}`));
module.exports = app;
