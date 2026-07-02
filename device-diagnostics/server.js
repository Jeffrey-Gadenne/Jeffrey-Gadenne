import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const client = new Anthropic();

const MODEL = "claude-opus-4-8";
const MAX_IMAGES = 12;

app.use(express.json({ limit: "60mb" }));
app.use(express.static(path.join(here, "public")));

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

app.post("/api/diagnose", async (req, res) => {
  try {
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

    const stream = client.messages.stream({
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
    res.json({ analysis: JSON.parse(text) });
  } catch (err) {
    handleApiError(err, res);
  }
});

app.post("/api/followup", async (req, res) => {
  try {
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

    const stream = client.messages.stream({
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
