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
cp .env.example .env   # then paste your API key into .env
npm start
```

Open http://localhost:3000.

## How it works

1. The browser resizes photos (and extracts up to 6 evenly-spaced frames per video) to ≤1568 px JPEG via canvas — no video processing on the server, and image tokens stay cheap.
2. `POST /api/diagnose` sends the images and your notes to `claude-opus-4-8` with adaptive thinking and a strict JSON schema (`output_config.format`), so the response is always a valid, structured diagnostic report.
3. `POST /api/followup` continues the conversation using the report as context.

## Use it as a phone app

The app is an installable **PWA**. Host it over HTTPS (see [DEPLOY.md](DEPLOY.md) for Azure App Service and Azure VM instructions), open the URL on your phone, and choose *Install app* (Android) or *Share → Add to Home Screen* (iPhone). It launches full-screen with its own icon, and the 📸 button opens the phone camera directly.

## Notes

- Up to 12 images per analysis (mix photos and video frames freely).
- Diagnoses are AI-generated — always verify before working on mains-powered or pressurized equipment.
