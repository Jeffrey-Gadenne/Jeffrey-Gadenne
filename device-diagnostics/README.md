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

### Plans, metering & monetization

Users can self-register in the app (disable with `ALLOW_SIGNUPS=false`). Every analysis and follow-up is metered per account (tokens + estimated cost, in a git-ignored `usage.json`). Three tiers:

| Tier | Allowance | Who pays for the API |
|---|---|---|
| **Free** | `FREE_MONTHLY_QUOTA` analyses/month (default 3) | You |
| **Credit packs** (one-off purchase) | `PACK_CREDITS` analyses per pack (default 5), never expire, used after the monthly quota | You, covered by the purchase |
| **Pro** (Stripe subscription) | `PRO_MONTHLY_QUOTA` analyses/month (default 30) | You, covered by the subscription |
| **Pro + own key** | Unlimited | The user (their key, encrypted at rest) — they still pay the subscription |

Packs suit occasional users (fix one thing, buy once); the subscription suits trade users (repair shops, refurbishers, salvage) — price it accordingly. Per-user overrides: `node manage-users.js quota|plan|credits <email> <value>`.

**Bring-your-own-key is a Pro perk by default** (`BYOK_MODE=pro`), so it adds revenue instead of bypassing it: heavy users pay the subscription *and* their own API bill — your highest-margin tier. Set `BYOK_MODE=open` to let anyone use their own key (useful pre-launch for testers), or `BYOK_MODE=off` to disable it entirely. A key saved while on Pro simply goes inactive if the subscription lapses.

**Stripe setup:** in the [Stripe dashboard](https://dashboard.stripe.com) create a Product with a **recurring** Price (subscription) and one with a **one-off** Price (pack), add a webhook endpoint pointing at `https://<your-host>/api/billing/webhook` (events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`), then set:

```bash
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PRICE_ID=price_...          # recurring price → Pro subscription
STRIPE_PACK_PRICE_ID=price_...     # one-off price → credit packs
STRIPE_WEBHOOK_SECRET=whsec_...
PLAN_PRICE_DISPLAY="A$29/month"
PACK_PRICE_DISPLAY="A$7"
```

Each is optional — configure only the subscription, only packs, or neither (billing UI hides; free tier + BYOK still work).

### Recommended launch configuration

Margin-positive in every case, validated pricing to start from:

```bash
MODEL=claude-sonnet-5        # ~half the API cost of Opus, excellent at this task
FREE_MONTHLY_QUOTA=3         # acquisition hook, worst case ~A$0.80/user/month
PACK_CREDITS=5               # consumer tier: A$7 pack costs you ~A$1.50 in API
PACK_PRICE_DISPLAY="A$7"
PRO_MONTHLY_QUOTA=100        # trade tier: repair shops, refurbishers, salvage
PLAN_PRICE_DISPLAY="A$29/month"   # capped-out worst case ~A$24 API — typical far less
```

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
