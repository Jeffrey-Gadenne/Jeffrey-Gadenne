# Rork prompt — Device Diagnostics MVP

Copy everything below the line into Rork as your app prompt. Before you do, replace
`https://YOUR-BACKEND-URL` (appears twice) with your deployed backend URL — the Rork
app is the frontend only; accounts, quotas, billing, and the AI all run on your server.

---

Build a mobile app called **Device Diagnostics** — a repair-and-salvage assistant.
Users photograph any broken device (laptop, washing machine, power tool, engine, etc.),
and the app returns an AI diagnosis of what's wrong plus a list of components worth
salvaging as donor parts. The AI runs on my existing backend REST API — the app never
calls any AI service directly.

## Design

Dark workshop theme: near-black background (#10141a), card surfaces (#1a2029), amber
accent (#f59e0b), light text (#e6ebf2). Rounded cards, generous padding, clean and
practical — a tool for people fixing things, not a toy. Use a wrench 🔧 motif for the
app icon and empty states.

## Screens

**1. Sign in / Create account** — email + password, two buttons ("Sign in", "Create
account"), inline error messages. On success store the returned `token` securely and
go to Diagnose. Skip this screen on launch if a token is already stored and
`GET /api/me` succeeds.

**2. Diagnose (home)** — the core screen:
- Buttons: "📸 Take photo" (camera) and "Add from library" (multi-select).
- Thumbnails of added photos with an ✕ to remove each; cap at 12 with a friendly
  message when exceeded.
- Before upload, resize every image on-device to at most 1568 px on the long edge,
  JPEG quality ~0.85, and base64-encode it.
- A multiline "Describe the problem (optional)" text field.
- A big "Analyze device" button → shows a full-screen progress state with rotating
  status lines ("Examining the photos…", "Identifying the device…", "Checking for
  visible faults…") because the request takes 1–2 minutes. Set the HTTP timeout to
  at least 5 minutes for this request.

**3. Results** — rendered from the JSON the backend returns:
- Device card: identification, confidence badge (high=green / medium=amber /
  low=red), description.
- "🩺 Diagnosis" list: one card per issue with badges for likelihood, severity, and
  repair difficulty, the evidence sentence, estimated cost, and an expandable
  "Repair steps" section (numbered steps + tools needed).
- "♻️ Donor parts" list: one card per part with salvage-difficulty badge, location,
  condition, approximate value, what it's compatible with, and expandable removal
  notes.
- "⚠️ Safety warnings" section in a red-tinted card when present.
- A "💬 Ask a follow-up" chat box at the bottom (see API below) with message bubbles.

**4. Account** — email, current plan name, usage line ("X of Y analyses this month",
plus credits if any), and a "Manage plan" button that opens
`https://YOUR-BACKEND-URL` in the device browser (purchases happen on the website,
not in the app). A "Sign out" button that deletes the stored token.

Bottom tab bar: Diagnose · Account. Results pushes onto the Diagnose stack.

## Backend API (base URL: https://YOUR-BACKEND-URL)

All authenticated requests send header `Authorization: Bearer <token>`.
Every error response is JSON: `{ "error": "human-readable message" }` — show it to
the user as-is.

- `POST /api/register` `{email, password}` → `{user, token}` (password min 8 chars;
  409 if the email exists)
- `POST /api/login` `{email, password}` → `{user, token}`
- `GET /api/me` → `{user, plan, usage: {analyses, quota, credits}, byok, billing: {...}}`
  (401 means the stored token is stale — return to the sign-in screen)
- `POST /api/diagnose` `{images: [{media_type: "image/jpeg", data: "<base64, no
  data: prefix>"}], notes: "..."}` → `{analysis}` where `analysis` =
  `{device: {type, identification, confidence, description},
    diagnosis: [{issue, likelihood, evidence, severity, repair_difficulty,
                 repair_steps[], tools_needed[], estimated_cost}],
    donor_parts: [{component, location, condition, salvage_difficulty,
                   compatible_uses[], removal_notes, approximate_value}],
    safety_warnings: [string], image_quality_notes: string}`.
  A 429 response means the user's quota is used up — show the error message with a
  button to the Account screen. A 403 mentions adding an API key — also route to
  Account.
- `POST /api/followup` `{analysis: <the full analysis object>, question: "...",
  history: [{role: "user"|"assistant", content: "..."}]}` → `{answer}` (plain text)

## MVP boundaries

Photos only for v1 (no video). No push notifications. No in-app purchases — the
Manage plan button opens the website. Handle offline gracefully ("You're offline —
check your connection"). Never store the password, only the token.
