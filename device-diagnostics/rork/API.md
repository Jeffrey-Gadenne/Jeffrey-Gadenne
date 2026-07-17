# Backend API reference (for the Rork app / any mobile client)

Base URL: your deployed server, e.g. `https://diagnostics.yourdomain.com`.
The backend must be deployed over HTTPS **before** the Rork app can work — see `../DEPLOY.md`.

## Auth

Mobile clients authenticate with a bearer token (30-day expiry, HMAC-signed server-side):

```
POST /api/register   {"email": "...", "password": "..."}   → 200 {"user": "...", "token": "..."}
POST /api/login      {"email": "...", "password": "..."}   → 200 {"user": "...", "token": "..."}
```

Send it on every other request:

```
Authorization: Bearer <token>
```

A 401 on any endpoint means the token is missing/expired → send the user back to sign-in.
(The web frontend uses session cookies instead; both work simultaneously.)

## Endpoints

| Method & path | Body | Success | Notable errors |
|---|---|---|---|
| `GET /api/me` | — | `{user, plan, byok, byok_allowed, billing:{enabled, price, pro_quota, packs, pack_credits, pack_price, byok_plan, byok_plan_price}, usage:{month, analyses, quota, credits}}` | 401 stale token |
| `POST /api/diagnose` | `{images:[{media_type,data}], notes}` — `data` is base64 **without** the `data:...;base64,` prefix; ≤12 images; resize to ≤1568px JPEG client-side | `{analysis}` (schema below) | 429 quota exhausted (show `error`, link to Account); 403 BYOK-plan user with no key; 422 model refused; 400 validation |
| `POST /api/followup` | `{analysis, question, history:[{role,content}]}` | `{answer}` plain text | same auth/plan errors |
| `POST /api/apikey` | `{apiKey}` (paid plans only) | `{byok:true}` | 403 free plan; 400 invalid key |
| `DELETE /api/apikey` | — | `{byok:false}` | |
| `POST /api/billing/checkout` | `{type:"pack"\|"subscription"\|"byok"}` | `{url}` → open in browser | 503 billing not configured |
| `POST /api/billing/portal` | — | `{url}` → open in browser | 400 no subscription |

**Purchases and Apple:** don't put checkout inside the iOS app — Apple requires In-App
Purchase for digital goods and rejects Stripe checkout in-app. Have the app open the
website in the system browser for plan management (the Rork prompt already does this).

## `analysis` schema

```json
{
  "device": { "type": "", "identification": "", "confidence": "high|medium|low", "description": "" },
  "diagnosis": [{
    "issue": "", "likelihood": "confirmed|likely|possible", "evidence": "",
    "severity": "cosmetic|minor|major|critical",
    "repair_difficulty": "easy|moderate|hard|professional-only",
    "repair_steps": [""], "tools_needed": [""], "estimated_cost": ""
  }],
  "donor_parts": [{
    "component": "", "location": "", "condition": "",
    "salvage_difficulty": "easy|moderate|hard",
    "compatible_uses": [""], "removal_notes": "", "approximate_value": ""
  }],
  "safety_warnings": [""],
  "image_quality_notes": ""
}
```

## Timing

`/api/diagnose` takes **1–2 minutes** (the model examines every photo and reasons about
faults). Set client timeouts to ≥300 s and show a progress state — a default 30–60 s
HTTP timeout will abort real requests.
