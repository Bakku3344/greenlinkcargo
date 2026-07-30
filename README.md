# Ferry Cargo Log

A web app for logging cargo loaded/unloaded on a ferry, invoicing customers, and
letting senders and receivers track shipment status. Four roles: Owner, Boat
Staff, Sender, Receiver.

## Repo structure

```
index.html          <- the whole front-end app (deploy this via GitHub Pages)
neon-schema.sql      <- run once against your Neon database
api-example/
  server.js          <- reference API layer (Express + Neon serverless driver)
  package.json        <- dependencies for the API
  .env.example         <- copy to .env and fill in your Neon connection string
```

## Setup

### 1. Database (Neon)
1. Create a project at neon.tech if you haven't already.
2. Open the SQL editor and run `neon-schema.sql`. This creates the `app_data`
   table and seeds default rates/settings.

### 2. API layer
The API holds your Neon connection string (which must never be exposed in the
public HTML) and exposes the endpoints the app calls:

- `GET /api/data/:key` -> `{ value }`
- `PUT /api/data/:key` body `{ value }` -> upserts
- `POST /api/reset-pin/request` body `{ email }` -> emails a reset link if the
  address matches the registered Owner Gmail
- `POST /api/reset-pin/confirm` body `{ token, newPin }` -> sets the new
  Owner PIN if the token is valid and unexpired

To run the reference implementation locally or on any Node host:

```bash
cd api-example
npm install
cp .env.example .env   # then fill in your real DATABASE_URL (and Resend settings below)
npm start
```

Deploy it wherever you like (Render, Railway, Fly.io, a VPS, Vercel/Cloudflare
with light adaptation, etc). Whatever platform you choose, make sure:
- `DATABASE_URL` is set as a secret/environment variable, not hardcoded.
- CORS allows requests from your GitHub Pages origin (e.g.
  `https://YOUR-USERNAME.github.io`).

#### Owner PIN reset via Resend
The Owner sign-in screen has a "Forgot PIN?" link that emails a one-time reset
link, sent via [Resend](https://resend.com). To enable it, set two more
environment variables on your API host:

- `RESEND_API_KEY` — from resend.com/api-keys (sign up free, verify your
  email, then create a key).
- `APP_URL` — your GitHub Pages URL (e.g.
  `https://YOUR-USERNAME.github.io/YOUR-REPO`), used to build the emailed
  link.

Optionally set `RESEND_FROM` (defaults to `GreenLine Cargo
<onboarding@resend.dev>`, Resend's shared test sender — this only delivers to
the email address you signed up to Resend with. Verify your own domain on
Resend and set `RESEND_FROM` to an address on it, e.g. `GreenLine Cargo
<noreply@yourdomain.com>`, to send to any address).

Then, as Owner, go to **Settings > Owner Settings > Your Owner PIN >
Registered Gmail** and enter the address that should receive reset emails.
If either env var is missing, or no Registered Gmail is set, "Forgot PIN?"
quietly does nothing (no error is shown, to avoid leaking whether an
account/email exists) — check your API host's logs if a reset email isn't
arriving. Reset links expire after 30 minutes and can only be used once.

### 3. Front-end (GitHub Pages)
1. Push `index.html` to the root of your `YOUR-USERNAME.github.io` repo (or a
   project repo, with Pages enabled).
2. Open `index.html` and edit this line near the top of the `<script>` tag:
   ```js
   const API_BASE = 'https://YOUR-API-DOMAIN-HERE';
   ```
   Point it at wherever you deployed the API layer in step 2.
3. Commit and push. GitHub Pages usually takes a minute or two to build.

## Using the app

- **Owner / Boat Staff** sign in at `https://YOUR-USERNAME.github.io/#staff`
  with a PIN (defaults: Owner `1234`, Staff `0000` — change these immediately
  under Rates & Setup once logged in as Owner).
- **Sender / Receiver** just open `https://YOUR-USERNAME.github.io/` (no
  hash) — this is the link your QR code should point to. They pick "I'm
  Sending" or "I'm Receiving" from a toggle at the top.

## Notes

- PINs are a light gate to keep casual users out of dispatch tools — they are
  not real authentication. Don't rely on them to protect sensitive data.
- All four roles share the same live data, refreshed every ~5 seconds.
