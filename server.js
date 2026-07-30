/**
 * Reference API layer for the Ferry Cargo Log app, backed by Neon Postgres.
 *
 * Contract expected by the front-end (cargo-ferry-log.html):
 *   GET  /api/data/:key   -> { value: <json or null> }
 *   PUT  /api/data/:key   body { value: <json> }  -> upserts, returns { value }
 *
 * This example uses Express + the Neon serverless driver (HTTP-based, works
 * anywhere — Node, Vercel Functions, Cloudflare Workers with small tweaks).
 * Swap the Express wrapper for your platform's handler signature as needed;
 * the Neon query logic in the middle stays the same.
 *
 * Setup:
 *   npm install express @neondatabase/serverless cors
 *   export DATABASE_URL="postgresql://<user>:<password>@<host>/<db>?sslmode=require"
 *   node server.js
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const app = express();

// The default express.json() body limit is 100kb. Shipments now carry
// compressed photos (base64) inside the same JSON blob, and even a handful
// of them across different shipments comfortably exceeds that -- once it
// does, every save silently starts failing with a 413. 25mb gives plenty of
// headroom for many photos in a single save.
app.use(express.json({ limit: '25mb' }));

// --- Owner PIN reset (emailed via Resend) -----------------------------------
// RESEND_API_KEY is the API key from https://resend.com/api-keys.
// RESEND_FROM is the "from" address used to send -- when you haven't
// verified your own sending domain on Resend, use their shared test domain
// address 'onboarding@resend.dev' (works out of the box, but Resend will
// only deliver it to the email address you signed up to Resend with). Once
// you verify a domain on Resend you can switch this to any address on it.
// The reset link is sent TO whatever address the Owner has registered in
// Settings ("Registered Gmail"). APP_URL is the public URL of the front-end
// (your GitHub Pages site), used to build the link, e.g.
// https://YOUR-USERNAME.github.io/greenlinkcargo
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'GreenLine Cargo <onboarding@resend.dev>';
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

async function sendResetEmail(to, link){
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject: 'Reset your GreenLine Cargo Owner PIN',
      text: `A reset was requested for your GreenLine Cargo Owner PIN.\n\nOpen this link to set a new PIN (it expires in 30 minutes):\n${link}\n\nIf you didn't request this, you can safely ignore this email.`,
      html: `<p>A reset was requested for your GreenLine Cargo Owner PIN.</p>
             <p><a href="${link}">Click here to set a new PIN</a> (expires in 30 minutes).</p>
             <p>If you didn't request this, you can safely ignore this email.</p>`,
    }),
  });
  if(!res.ok){
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

// Restrict this to your actual GitHub Pages origin in production,
// e.g. cors({ origin: 'https://bakku3344.github.io' })
app.use(cors());

// Never let browsers or intermediate CDNs cache these responses -- this data
// changes constantly (new check-ins, staff PIN changes, etc), and a cached
// stale response can make the app look broken even when the DB is fine.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

const ALLOWED_KEYS = new Set(['shipments', 'rates', 'settings', 'trips']);

app.get('/api/data/:key', async (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'unknown key' });
  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = ${key}`;
    res.json({ value: rows.length ? rows[0].value : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db error' });
  }
});

app.put('/api/data/:key', async (req, res) => {
  const { key } = req.params;
  if (!ALLOWED_KEYS.has(key)) return res.status(400).json({ error: 'unknown key' });
  const { value } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'missing value' });
  try {
    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES (${key}, ${JSON.stringify(value)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(value)}::jsonb, updated_at = now()
    `;
    res.json({ value });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db error' });
  }
});

// Request a reset link. Always responds the same way regardless of whether
// the email matches, whether Resend is configured, or whether sending
// succeeds -- this endpoint must never reveal what the registered address
// is or whether an account exists.
app.post('/api/reset-pin/request', async (req, res) => {
  const generic = { ok: true };
  const email = (req.body && req.body.email || '').trim().toLowerCase();
  if (!email) return res.json(generic);

  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = 'settings'`;
    const settings = rows.length ? rows[0].value : {};
    const registered = (settings.ownerEmail || '').trim().toLowerCase();

    if (!registered || registered !== email || !RESEND_API_KEY || !APP_URL) {
      if (!RESEND_API_KEY) console.error('Reset requested but RESEND_API_KEY is not set.');
      if (!APP_URL) console.error('Reset requested but APP_URL is not set.');
      return res.json(generic);
    }

    // Housekeeping: drop old tokens so the table doesn't grow forever.
    await sql`DELETE FROM pin_resets WHERE expires_at < now() - interval '1 day'`;

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await sql`
      INSERT INTO pin_resets (token, role, expires_at)
      VALUES (${token}, 'owner', ${expiresAt})
    `;

    const link = `${APP_URL}/#reset-pin/${token}`;
    await sendResetEmail(registered, link);

    res.json(generic);
  } catch (e) {
    console.error(e);
    res.json(generic); // never leak failure details to the client
  }
});

// Confirm a reset: consumes the token and sets the new Owner PIN.
app.post('/api/reset-pin/confirm', async (req, res) => {
  const { token, newPin } = req.body || {};
  if (!token || !newPin || !/^\d{4,6}$/.test(String(newPin))) {
    return res.status(400).json({ ok: false, error: 'Enter a valid 4\u20136 digit PIN.' });
  }
  try {
    const rows = await sql`SELECT * FROM pin_resets WHERE token = ${token}`;
    const record = rows[0];
    if (!record || record.used || new Date(record.expires_at) < new Date()) {
      return res.status(400).json({ ok: false, error: 'That link is invalid or expired. Request a new one.' });
    }

    const settingsRows = await sql`SELECT value FROM app_data WHERE key = 'settings'`;
    const settings = settingsRows.length ? settingsRows[0].value : {};
    settings.ownerPin = String(newPin);

    await sql`
      INSERT INTO app_data (key, value, updated_at)
      VALUES ('settings', ${JSON.stringify(settings)}::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = ${JSON.stringify(settings)}::jsonb, updated_at = now()
    `;
    await sql`UPDATE pin_resets SET used = true WHERE token = ${token}`;

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Cargo API listening on :${port}`));
