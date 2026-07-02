# 🔧 Device Diagnostics & Donor Parts

A web app that diagnoses problems on **any device** — laptops, appliances, power tools, vehicles, machinery — from photos and video, and lists the components on the device that are worth salvaging as **donor parts**.

Powered by the Claude API (vision + structured outputs).

## Features

- **Photo & video input** — drop in photos or a short walk-around video. Video is sampled into frames entirely in your browser before upload.
- **AI diagnosis** — identifies the device, lists likely faults ranked by likelihood, and grounds each finding in visible evidence (burn marks, bulged capacitors, corrosion, error codes, worn parts…). Each fault includes severity, repair difficulty, step-by-step repair guidance, tools needed, and a rough parts cost.
- **Donor parts inventory** — every salvageable component with its location, assessed condition, removal notes, what other devices it commonly fits, and approximate value.
- **Safety warnings** — mains capacitors, lithium batteries, refrigerant, spring tension, and other hazards flagged before you open anything.
- **Follow-up chat** — ask questions about the diagnosis ("how do I test if the motor is actually dead?") with full context of the report.

## Setup

Requires Node.js 22+ and an [Anthropic API key](https://platform.claude.com/).

```bash
cd device-diagnostics
npm install
cp .env.example .env                                  # paste your API key into .env
node manage-users.js add you@example.com yourpassword # create your login
npm start
```

Open http://localhost:3000 and sign in.

### Accounts & auth

Sign-in is required before any analysis runs (protects your API credits). Accounts live in `users.json` (bcrypt-hashed, git-ignored) and are managed from the server:

```bash
node manage-users.js add <email> <password>
node manage-users.js remove <email>
node manage-users.js list
```

Set `SESSION_SECRET` in `.env` so logins survive server restarts, and `NODE_ENV=production` in production so session cookies are HTTPS-only. For local tinkering without auth, start with `ALLOW_ANONYMOUS=true`.

### Usage metering, quotas & bring-your-own-key

Every analysis and follow-up is metered per account (tokens + estimated cost, written to a git-ignored `usage.json`). Accounts get `DEFAULT_MONTHLY_QUOTA` analyses per month (default 25); override per user:

```bash
node manage-users.js quota someone@example.com 100
```

When the quota is hit, `/api/diagnose` returns 429 and the UI explains the options. Users can also open **Account** in the app and store their **own Anthropic API key** (verified against the API, then encrypted at rest with AES-256-GCM keyed off `SESSION_SECRET`) — their analyses then bill to their own Anthropic account and bypass the quota entirely.

`MODEL` is also configurable via env (default `claude-opus-4-8`) — e.g. `MODEL=claude-sonnet-5` for ~40–60% lower cost per analysis.

## How it works

1. The browser resizes photos (and extracts up to 6 evenly-spaced frames per video) to ≤1568 px JPEG via canvas — no video processing on the server, and image tokens stay cheap.
2. `POST /api/diagnose` sends the images and your notes to `claude-opus-4-8` with adaptive thinking and a strict JSON schema (`output_config.format`), so the response is always a valid, structured diagnostic report.
3. `POST /api/followup` continues the conversation using the report as context.

## Use it as a phone app

The app is an installable **PWA**. Host it over HTTPS (see [DEPLOY.md](DEPLOY.md) for Azure App Service and Azure VM instructions), open the URL on your phone, and choose *Install app* (Android) or *Share → Add to Home Screen* (iPhone). It launches full-screen with its own icon, and the 📸 button opens the phone camera directly.

For a store-distributable native app (App Store / Play Store), see [mobile/README.md](mobile/README.md) — a Capacitor shell that wraps the hosted app.

## Notes

- Up to 12 images per analysis (mix photos and video frames freely).
- Diagnoses are AI-generated — always verify before working on mains-powered or pressurized equipment.
