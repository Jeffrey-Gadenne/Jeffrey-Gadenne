import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";
import cookieSession from "cookie-session";
import bcrypt from "bcryptjs";
import Stripe from "stripe";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic();

const MODEL = process.env.MODEL || "claude-opus-4-8";
const MAX_IMAGES = 12;
const USERS_FILE = process.env.USERS_FILE || path.join(here, "users.json");
const USAGE_FILE = process.env.USAGE_FILE || path.join(here, "usage.json");
const ALLOW_ANONYMOUS = process.env.ALLOW_ANONYMOUS === "true";
const ALLOW_SIGNUPS = process.env.ALLOW_SIGNUPS !== "false";
const FREE_MONTHLY_QUOTA = parseInt(process.env.FREE_MONTHLY_QUOTA || "3", 10);
const PRO_MONTHLY_QUOTA = parseInt(process.env.PRO_MONTHLY_QUOTA || "30", 10);
const PLAN_PRICE_DISPLAY = process.env.PLAN_PRICE_DISPLAY || "$15/month";
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;
const BILLING_ENABLED = Boolean(stripe && process.env.STRIPE_PRICE_ID);
// USD per million tokens, for the cost estimates in usage records (Opus 4.8 pricing)
const PRICE_PER_MTOK = { input: 5, output: 25 };
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");

app.set("trust proxy", 1); // Azure App Service / reverse proxies terminate TLS

// Stripe webhook — must see the raw body for signature verification, so it's
// registered before the JSON body parser.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return res.status(400).send("Invalid signature");
  }

  const users = loadUsers();
  const byCustomer = (customerId) =>
    Object.keys(users).find((e) => users[e].stripeCustomerId === customerId);

  switch (event.type) {
    case "checkout.session.completed": {
      const s = event.data.object;
      const email = (s.client_reference_id || s.customer_details?.email || "").toLowerCase();
      if (users[email]) {
        users[email].plan = "pro";
        users[email].stripeCustomerId = s.customer;
        users[email].stripeSubscriptionId = s.subscription;
        saveUsers(users);
        console.log(`Billing: ${email} upgraded to pro.`);
      }
      break;
    }
    case "customer.subscription.deleted": {
      const email = byCustomer(event.data.object.customer);
      if (email) {
        users[email].plan = "free";
        delete users[email].stripeSubscriptionId;
        saveUsers(users);
        console.log(`Billing: ${email} subscription ended — back to free.`);
      }
      break;
    }
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const email = byCustomer(sub.customer);
      if (email) {
        users[email].plan = ["canceled", "unpaid", "incomplete_expired"].includes(sub.status) ? "free" : "pro";
        saveUsers(users);
      }
      break;
    }
  }
  res.json({ received: true });
});

app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(here, "public")));

if (!process.env.SESSION_SECRET) {
  console.warn("Warning: SESSION_SECRET is not set — using a random secret, so logins won't survive a restart.");
}
app.use(cookieSession({
  name: "dd_session",
  keys: [SESSION_SECRET],
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
}));

// ---------- Auth ----------

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2) + "\n", { mode: 0o600 });
}

function requireAuth(req, res, next) {
  if (ALLOW_ANONYMOUS || req.session?.user) return next();
  res.status(401).json({ error: "Not signed in." });
}

function currentUser(req) {
  return ALLOW_ANONYMOUS && !req.session?.user ? "anonymous" : req.session?.user;
}

// ---------- Bring-your-own-API-key (encrypted at rest) ----------

function encryptionKey() {
  return crypto.createHash("sha256").update("apikey:" + SESSION_SECRET).digest();
}

function encryptSecret(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

function decryptSecret(b64) {
  try {
    const buf = Buffer.from(b64, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null; // wrong/rotated SESSION_SECRET — treat as no key stored
  }
}

/** Returns {client, byok} — the caller's own-key client when they stored one, else the app's. */
function clientFor(email) {
  const record = loadUsers()[email];
  if (record?.apiKeyEnc) {
    const key = decryptSecret(record.apiKeyEnc);
    if (key) return { client: new Anthropic({ apiKey: key }), byok: true };
  }
  return { client, byok: false };
}

// ---------- Usage metering & quotas ----------

function monthKey() {
  return new Date().toISOString().slice(0, 7); // "2026-07"
}

function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function usageFor(email) {
  const all = loadUsage();
  return all[email]?.[monthKey()] ?? { analyses: 0, followups: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 };
}

function recordUsage(email, kind, apiUsage) {
  const all = loadUsage();
  const month = monthKey();
  const entry = all[email]?.[month] ?? { analyses: 0, followups: 0, input_tokens: 0, output_tokens: 0, est_cost_usd: 0 };
  const inputTokens = (apiUsage?.input_tokens ?? 0) + (apiUsage?.cache_read_input_tokens ?? 0) + (apiUsage?.cache_creation_input_tokens ?? 0);
  const outputTokens = apiUsage?.output_tokens ?? 0;
  entry[kind === "analysis" ? "analyses" : "followups"] += 1;
  entry.input_tokens += inputTokens;
  entry.output_tokens += outputTokens;
  entry.est_cost_usd = +(entry.est_cost_usd + (inputTokens * PRICE_PER_MTOK.input + outputTokens * PRICE_PER_MTOK.output) / 1e6).toFixed(4);
  all[email] = { ...(all[email] ?? {}), [month]: entry };
  fs.writeFileSync(USAGE_FILE, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 });
}

function quotaFor(email) {
  const record = loadUsers()[email];
  if (Number.isInteger(record?.quota)) return record.quota; // explicit per-user override wins
  return record?.plan === "pro" ? PRO_MONTHLY_QUOTA : FREE_MONTHLY_QUOTA;
}

function planFor(email) {
  return loadUsers()[email]?.plan === "pro" ? "pro" : "free";
}

app.post("/api/register", (req, res) => {
  if (!ALLOW_SIGNUPS) {
    return res.status(503).json({ error: "Sign-ups are closed — contact the site owner for an account." });
  }
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const users = loadUsers();
  if (users[email]) {
    return res.status(409).json({ error: "An account with that email already exists — sign in instead." });
  }
  users[email] = { passwordHash: bcrypt.hashSync(password, 10), createdAt: new Date().toISOString(), plan: "free" };
  saveUsers(users);
  req.session.user = email;
  res.json({ user: email });
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body ?? {};
  const users = loadUsers();
  if (Object.keys(users).length === 0) {
    return res.status(503).json({
      error: "No accounts exist yet — on the server, run: node manage-users.js add you@example.com yourpassword",
    });
  }
  const record = users[String(email ?? "").trim().toLowerCase()];
  if (!record || !bcrypt.compareSync(String(password ?? ""), record.passwordHash)) {
    return res.status(401).json({ error: "Wrong email or password." });
  }
  req.session.user = String(email).trim().toLowerCase();
  res.json({ user: req.session.user });
});

app.post("/api/logout", (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const email = currentUser(req);
  if (!email) return res.status(401).json({ error: "Not signed in." });
  const { byok } = clientFor(email);
  const usage = usageFor(email);
  res.json({
    user: email,
    anonymous: email === "anonymous",
    byok,
    plan: planFor(email),
    billing: { enabled: BILLING_ENABLED, price: PLAN_PRICE_DISPLAY, pro_quota: PRO_MONTHLY_QUOTA },
    usage: { month: monthKey(), analyses: usage.analyses, quota: quotaFor(email) },
  });
});

app.post("/api/billing/checkout", requireAuth, async (req, res) => {
  if (!BILLING_ENABLED) {
    return res.status(503).json({ error: "Billing isn't configured on this server yet." });
  }
  const email = currentUser(req);
  if (email === "anonymous") return res.status(400).json({ error: "Sign in with an account to subscribe." });
  try {
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      client_reference_id: email,
      customer_email: email,
      success_url: `${appUrl}/?upgraded=1`,
      cancel_url: `${appUrl}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe checkout error:", err.message);
    res.status(502).json({ error: "Could not start checkout — try again shortly." });
  }
});

app.post("/api/billing/portal", requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "Billing isn't configured on this server yet." });
  const email = currentUser(req);
  const customerId = loadUsers()[email]?.stripeCustomerId;
  if (!customerId) return res.status(400).json({ error: "No subscription found for this account." });
  try {
    const appUrl = process.env.APP_URL || `${req.protocol}://${req.get("host")}`;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe portal error:", err.message);
    res.status(502).json({ error: "Could not open the billing portal — try again shortly." });
  }
});

app.post("/api/apikey", requireAuth, async (req, res) => {
  const email = currentUser(req);
  const apiKey = String(req.body?.apiKey ?? "").trim();
  if (!apiKey.startsWith("sk-ant-")) {
    return res.status(400).json({ error: "That doesn't look like an Anthropic API key (should start with sk-ant-)." });
  }
  try {
    // Cheap validation call before storing
    await new Anthropic({ apiKey }).messages.countTokens({
      model: MODEL,
      messages: [{ role: "user", content: "ping" }],
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return res.status(400).json({ error: "Anthropic rejected that API key — check it and try again." });
    }
    return res.status(502).json({ error: "Could not verify the key with the Claude API — try again shortly." });
  }
  const users = loadUsers();
  if (!users[email]) return res.status(400).json({ error: "No account record — sign in with a real account first." });
  users[email].apiKeyEnc = encryptSecret(apiKey);
  saveUsers(users);
  res.json({ byok: true });
});

app.delete("/api/apikey", requireAuth, (req, res) => {
  const email = currentUser(req);
  const users = loadUsers();
  if (users[email]) {
    delete users[email].apiKeyEnc;
    saveUsers(users);
  }
  res.json({ byok: false });
});

const SYSTEM_PROMPT = `You are an expert repair technician and salvage specialist with deep
knowledge across consumer electronics, appliances, power tools, vehicles, and machinery.

You are given photos (and/or frames extracted from a video) of a device, plus optional notes
from the owner describing symptoms. Your job:

1. Identify the device as precisely as the images allow (type, brand, model or model family).
2. Diagnose likely problems. Ground every finding in visible evidence from the images and the
   reported symptoms — cite what you can actually see (burn marks, bulged capacitors, corrosion,
   cracked solder joints, worn belts, leaks, physical damage, error codes on displays, etc.).
   When evidence is ambiguous, say so and give the most likely candidates with lower likelihood.
3. List the components on this device that are worth salvaging as donor parts — what they are,
   where they sit on the device, how hard they are to remove, and what other devices they
   commonly fit or are useful for.
4. Include any safety warnings relevant to opening or repairing this device (mains capacitors,
   lithium batteries, refrigerant, spring tension, etc.).

Be honest about uncertainty. If the images are too blurry, dark, or partial to assess something,
note it in image_quality_notes rather than guessing.`;

const ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["device", "diagnosis", "donor_parts", "safety_warnings", "image_quality_notes"],
  properties: {
    device: {
      type: "object",
      additionalProperties: false,
      required: ["type", "identification", "confidence", "description"],
      properties: {
        type: { type: "string", description: "Device category, e.g. 'laptop', 'washing machine', 'cordless drill'" },
        identification: { type: "string", description: "Brand and model or model family, as precise as the images allow" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        description: { type: "string", description: "Brief description of the device and its overall condition" }
      }
    },
    diagnosis: {
      type: "array",
      description: "Likely problems, most likely first",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["issue", "likelihood", "evidence", "severity", "repair_difficulty", "repair_steps", "tools_needed", "estimated_cost"],
        properties: {
          issue: { type: "string" },
          likelihood: { type: "string", enum: ["confirmed", "likely", "possible"] },
          evidence: { type: "string", description: "What in the images or reported symptoms supports this" },
          severity: { type: "string", enum: ["cosmetic", "minor", "major", "critical"] },
          repair_difficulty: { type: "string", enum: ["easy", "moderate", "hard", "professional-only"] },
          repair_steps: { type: "array", items: { type: "string" } },
          tools_needed: { type: "array", items: { type: "string" } },
          estimated_cost: { type: "string", description: "Rough parts cost range, e.g. '$5-15 for a replacement capacitor kit'" }
        }
      }
    },
    donor_parts: {
      type: "array",
      description: "Components on this device worth salvaging, most valuable first",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["component", "location", "condition", "salvage_difficulty", "compatible_uses", "removal_notes", "approximate_value"],
        properties: {
          component: { type: "string" },
          location: { type: "string", description: "Where it sits on/in the device" },
          condition: { type: "string", description: "Assessed condition based on the images, or 'unknown - not visible'" },
          salvage_difficulty: { type: "string", enum: ["easy", "moderate", "hard"] },
          compatible_uses: {
            type: "array",
            items: { type: "string" },
            description: "Other devices or projects this part commonly fits or is useful for"
          },
          removal_notes: { type: "string", description: "How to remove it without damaging it" },
          approximate_value: { type: "string", description: "Rough resale/reuse value, e.g. '$10-20 used'" }
        }
      }
    },
    safety_warnings: { type: "array", items: { type: "string" } },
    image_quality_notes: {
      type: "string",
      description: "Anything that could not be assessed from the provided images and what extra photos/angles would help. Empty string if nothing to note."
    }
  }
};

app.post("/api/diagnose", requireAuth, async (req, res) => {
  try {
    const email = currentUser(req);
    const { client: userClient, byok } = clientFor(email);
    if (!byok) {
      const used = usageFor(email).analyses;
      const quota = quotaFor(email);
      if (used >= quota) {
        const upgradeHint = BILLING_ENABLED && planFor(email) !== "pro"
          ? `Upgrade to Pro (${PRO_MONTHLY_QUOTA} analyses/month, ${PLAN_PRICE_DISPLAY}) in Account settings, or add`
          : "Add";
        return res.status(429).json({
          error: `Monthly limit reached (${used}/${quota} analyses). ${upgradeHint} your own Anthropic API key for unlimited use.`,
          quota_exceeded: true,
        });
      }
    }

    const { images, notes } = req.body ?? {};
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "Provide at least one image (photo or video frame)." });
    }
    if (images.length > MAX_IMAGES) {
      return res.status(400).json({ error: `Too many images — send at most ${MAX_IMAGES}.` });
    }

    const content = images.map((img) => ({
      type: "image",
      source: {
        type: "base64",
        media_type: img.media_type || "image/jpeg",
        data: img.data,
      },
    }));
    content.push({
      type: "text",
      text: notes?.trim()
        ? `Owner's notes / reported symptoms:\n${notes.trim()}`
        : "No notes provided — diagnose from the images alone.",
    });

    const stream = userClient.messages.stream({
      model: MODEL,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      system: SYSTEM_PROMPT,
      output_config: { format: { type: "json_schema", schema: ANALYSIS_SCHEMA } },
      messages: [{ role: "user", content }],
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to analyze this request." });
    }
    if (message.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "The analysis was cut off — try again with fewer images." });
    }

    const text = message.content.find((b) => b.type === "text")?.text;
    if (!text) {
      return res.status(502).json({ error: "The model returned no analysis." });
    }
    recordUsage(email, "analysis", message.usage);
    res.json({ analysis: JSON.parse(text) });
  } catch (err) {
    handleApiError(err, res);
  }
});

app.post("/api/followup", requireAuth, async (req, res) => {
  try {
    const email = currentUser(req);
    const { client: userClient } = clientFor(email);
    const { analysis, question, history } = req.body ?? {};
    if (!analysis || !question?.trim()) {
      return res.status(400).json({ error: "Provide the prior analysis and a question." });
    }

    const messages = [
      {
        role: "user",
        content:
          "Here is the diagnostic report you produced for my device:\n\n" +
          JSON.stringify(analysis, null, 2),
      },
      { role: "assistant", content: "Understood — I have the full diagnostic report. What would you like to know?" },
    ];
    for (const turn of Array.isArray(history) ? history.slice(-10) : []) {
      if ((turn.role === "user" || turn.role === "assistant") && typeof turn.content === "string") {
        messages.push({ role: turn.role, content: turn.content });
      }
    }
    messages.push({ role: "user", content: question.trim() });

    const stream = userClient.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system:
        "You are the same expert repair technician who produced the diagnostic report in this conversation. " +
        "Answer the owner's follow-up questions about the diagnosis, repairs, and donor parts. " +
        "Be practical and concise; use plain prose, not JSON.",
      messages,
    });
    const message = await stream.finalMessage();

    if (message.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to answer this question." });
    }
    const text = message.content.find((b) => b.type === "text")?.text ?? "";
    recordUsage(email, "followup", message.usage);
    res.json({ answer: text });
  } catch (err) {
    handleApiError(err, res);
  }
});

function handleApiError(err, res) {
  if (err instanceof Anthropic.AuthenticationError) {
    return res.status(500).json({ error: "Server is missing a valid ANTHROPIC_API_KEY." });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return res.status(429).json({ error: "Rate limited — wait a moment and try again." });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return res.status(400).json({ error: `The request was rejected: ${err.message}` });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return res.status(502).json({ error: "Could not reach the Claude API — check the server's network." });
  }
  if (err instanceof Anthropic.APIError) {
    return res.status(502).json({ error: `Claude API error (${err.status}): ${err.message}` });
  }
  console.error(err);
  res.status(500).json({ error: "Unexpected server error." });
}

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Device Diagnostics running at http://localhost:${port}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set — /api/diagnose will fail until it is.");
  }
});
