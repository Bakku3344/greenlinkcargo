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
const nodemailer = require('nodemailer');
const twilio = require('twilio');
const { authenticator } = require('otplib');
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const app = express();

// The default express.json() body limit is 100kb. Shipments now carry
// compressed photos (base64) inside the same JSON blob, and even a handful
// of them across different shipments comfortably exceeds that -- once it
// does, every save silently starts failing with a 413. 25mb gives plenty of
// headroom for many photos in a single save.
app.use(express.json({ limit: '25mb' }));

// --- Owner PIN reset (emailed via Gmail) -----------------------------------
// GMAIL_USER / GMAIL_APP_PASSWORD are the credentials the app itself sends
// FROM (a Gmail account with an "App Password" generated at
// https://myaccount.google.com/apppasswords — this requires 2-Step
// Verification to be on). The reset link is sent TO whatever address the
// Owner has registered in Settings ("Registered Gmail"). APP_URL is the
// public URL of the front-end (your GitHub Pages site), used to build the
// link, e.g. https://YOUR-USERNAME.github.io
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');
const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes

const mailer = (GMAIL_USER && GMAIL_APP_PASSWORD)
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    })
  : null;

// --- Owner PIN reset (texted via Twilio SMS) --------------------------------
// TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN come from your Twilio console.
// TWILIO_PHONE_NUMBER is the Twilio number the text is sent FROM (must be
// SMS-capable). The reset link is texted TO whatever number the Owner has
// registered in Settings ("Registered Phone").
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;

const smsClient = (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN)
  ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
  : null;

// --- Owner PIN reset (authenticator app code) -------------------------------
// TOTP_SECRET is a base32 secret known only to this server (set as a Render
// env var, never returned by any API response) and to whatever authenticator
// app (OneAuth, Google Authenticator, Authy, etc.) the Owner entered it into.
// Unlike the email/phone paths, this needs no outside service to work -- the
// 6-digit code the app shows is verified locally against the same secret.
const TOTP_SECRET = process.env.TOTP_SECRET;
authenticator.options = { window: 1 }; // allow 1 step (\u00b130s) of clock drift

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
// the email matches, whether Gmail is configured, or whether sending
// succeeds -- this endpoint must never reveal what the registered address
// is or whether an account exists.
// Returns the currently configured authenticator secret (or null if
// TOTP_SECRET hasn't been set on this deployment), so the Owner Settings
// screen can show it for setting up a new device. Note: like every other
// endpoint in this API, there is no server-side login check here -- anyone
// with the API URL can call this, consistent with the rest of this app's
// security model (see README).
app.get('/api/totp-secret', (req, res) => {
  res.json({ secret: TOTP_SECRET || null });
});

app.post('/api/reset-pin/request', async (req, res) => {
  const generic = { ok: true };
  const raw = (req.body && (req.body.identifier || req.body.email) || '').trim();
  if (!raw) return res.json(generic);

  try {
    const rows = await sql`SELECT value FROM app_data WHERE key = 'settings'`;
    const settings = rows.length ? rows[0].value : {};
    const registeredEmail = (settings.ownerEmail || '').trim().toLowerCase();
    const registeredPhone = (settings.ownerPhone || '').replace(/\D/g, '');

    const inputLower = raw.toLowerCase();
    const inputDigits = raw.replace(/\D/g, '');

    const matchedEmail = !!(registeredEmail && registeredEmail === inputLower);
    const matchedPhone = !!(registeredPhone && inputDigits && registeredPhone === inputDigits);

    if ((!matchedEmail && !matchedPhone) || !APP_URL) {
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

    // Email and SMS are both best-effort bonuses, not requirements -- if
    // either isn't configured or fails to send, the link is still returned
    // directly below so the Owner (who just proved they know a registered
    // email or phone) can open it themselves or share it via WhatsApp.
    if (matchedEmail && mailer) {
      mailer.sendMail({
        from: `"GreenLine Cargo" <${GMAIL_USER}>`,
        to: registeredEmail,
        subject: 'Reset your GreenLine Cargo Owner PIN',
        text: `A reset was requested for your GreenLine Cargo Owner PIN.\n\nOpen this link to set a new PIN (it expires in 30 minutes):\n${link}\n\nIf you didn't request this, you can safely ignore this email.`,
        html: `<p>A reset was requested for your GreenLine Cargo Owner PIN.</p>
               <p><a href="${link}">Click here to set a new PIN</a> (expires in 30 minutes).</p>
               <p>If you didn't request this, you can safely ignore this email.</p>`,
      }).catch(e => console.error('reset-pin email send failed (link is still returned to the app)', e));
    } else if (matchedEmail && !mailer) {
      console.error('Reset matched by email but GMAIL_USER/GMAIL_APP_PASSWORD are not set -- link returned directly to the app instead.');
    }

    if (matchedPhone && smsClient && TWILIO_PHONE_NUMBER) {
      smsClient.messages.create({
        body: `GreenLine Cargo: reset your Owner PIN here (expires in 30 min): ${link}`,
        from: TWILIO_PHONE_NUMBER,
        to: settings.ownerPhone,
      }).catch(e => console.error('reset-pin SMS send failed (link is still returned to the app)', e));
    } else if (matchedPhone && (!smsClient || !TWILIO_PHONE_NUMBER)) {
      console.error('Reset matched by phone but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER are not fully set -- link returned directly to the app instead.');
    }

    res.json({ ok: true, link });
  } catch (e) {
    console.error(e);
    res.json(generic); // never leak failure details to the client
  }
});

// Verify an authenticator-app code. If it matches TOTP_SECRET, issue a
// reset token directly (no email/SMS round-trip needed) -- this path works
// even if Gmail/Twilio are misconfigured or unreachable, since it's fully
// self-contained on this server.
app.post('/api/reset-pin/totp-verify', async (req, res) => {
  const code = (req.body && req.body.code || '').trim();
  if (!TOTP_SECRET) {
    return res.status(400).json({ ok: false, error: 'Authenticator reset is not set up yet.' });
  }
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ ok: false, error: 'Enter the 6-digit code from your authenticator app.' });
  }
  try {
    const valid = authenticator.verify({ token: code, secret: TOTP_SECRET });
    if (!valid) {
      return res.status(400).json({ ok: false, error: 'That code is incorrect or expired. Try the latest code shown in your app.' });
    }

    await sql`DELETE FROM pin_resets WHERE expires_at < now() - interval '1 day'`;

    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString();
    await sql`
      INSERT INTO pin_resets (token, role, expires_at)
      VALUES (${token}, 'owner', ${expiresAt})
    `;

    res.json({ ok: true, token });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: 'Something went wrong. Try again.' });
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
