const MAX_IMAGES = 12;
const MAX_DIMENSION = 1568;      // px, long edge — keeps token cost sane with no real accuracy loss
const FRAMES_PER_VIDEO = 6;
const JPEG_QUALITY = 0.85;

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("file-input");
const previews = document.getElementById("previews");
const notesEl = document.getElementById("notes");
const analyzeBtn = document.getElementById("analyze-btn");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

/** @type {{media_type: string, data: string, label: string}[]} */
let images = [];
let currentAnalysis = null;
let chatHistory = [];

// ---------- File intake ----------

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
dropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  dropzone.classList.add("dragover");
});
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  intakeFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => {
  intakeFiles(fileInput.files);
  fileInput.value = "";
});

const cameraInput = document.getElementById("camera-input");
document.getElementById("camera-btn").addEventListener("click", () => cameraInput.click());
cameraInput.addEventListener("change", () => {
  intakeFiles(cameraInput.files);
  cameraInput.value = "";
});

async function intakeFiles(fileList) {
  const files = Array.from(fileList);
  setStatus("Processing files…");
  try {
    for (const file of files) {
      if (images.length >= MAX_IMAGES) {
        setStatus(`Image limit reached (${MAX_IMAGES}) — extra files were skipped.`);
        break;
      }
      if (file.type.startsWith("video/")) {
        const frames = await extractVideoFrames(file, Math.min(FRAMES_PER_VIDEO, MAX_IMAGES - images.length));
        frames.forEach((f, i) => addImage(f, `${file.name} · frame ${i + 1}`));
      } else if (file.type.startsWith("image/")) {
        const resized = await resizeImageFile(file);
        addImage(resized, file.name);
      }
    }
    clearStatus();
  } catch (err) {
    setStatus(`Could not process a file: ${err.message}`, true);
  }
  renderPreviews();
}

function addImage(dataUrl, label) {
  const [, media_type, data] = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/s) || [];
  if (!data) return;
  images.push({ media_type, data, label });
}

function renderPreviews() {
  previews.innerHTML = "";
  images.forEach((img, i) => {
    const div = document.createElement("div");
    div.className = "thumb";
    const el = document.createElement("img");
    el.src = `data:${img.media_type};base64,${img.data}`;
    el.alt = img.label;
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = img.label.length > 18 ? img.label.slice(0, 17) + "…" : img.label;
    const rm = document.createElement("button");
    rm.textContent = "×";
    rm.title = "Remove";
    rm.addEventListener("click", () => {
      images.splice(i, 1);
      renderPreviews();
    });
    div.append(el, tag, rm);
    previews.appendChild(div);
  });
  analyzeBtn.disabled = images.length === 0;
}

// ---------- Image / video processing (all in-browser) ----------

function resizeImageFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(drawToJpeg(img, img.naturalWidth, img.naturalHeight));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`"${file.name}" is not a readable image (HEIC may not be supported by this browser).`));
    };
    img.src = url;
  });
}

function extractVideoFrames(file, count) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = url;

    const frames = [];
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`"${file.name}" could not be decoded as video.`));
    };
    video.onloadedmetadata = async () => {
      try {
        const duration = video.duration;
        // Sample evenly, skipping the very start/end which are often black or shaky
        const times = Array.from({ length: count }, (_, i) => duration * (i + 0.5) / count);
        for (const t of times) {
          await seekTo(video, Math.min(t, Math.max(0, duration - 0.1)));
          frames.push(drawToJpeg(video, video.videoWidth, video.videoHeight));
        }
        URL.revokeObjectURL(url);
        resolve(frames);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
  });
}

function seekTo(video, time) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out seeking in video.")), 10000);
    video.onseeked = () => {
      clearTimeout(timer);
      resolve();
    };
    video.currentTime = time;
  });
}

function drawToJpeg(source, srcW, srcH) {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(srcW * scale);
  canvas.height = Math.round(srcH * scale);
  canvas.getContext("2d").drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

// ---------- Analysis ----------

analyzeBtn.addEventListener("click", async () => {
  analyzeBtn.disabled = true;
  resultsEl.hidden = true;
  setStatus("Analyzing… a thorough diagnosis can take a minute or two.");
  try {
    const res = await fetch("/api/diagnose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        images: images.map(({ media_type, data }) => ({ media_type, data })),
        notes: notesEl.value,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    currentAnalysis = body.analysis;
    chatHistory = [];
    document.getElementById("chat-log").innerHTML = "";
    renderResults(body.analysis);
    clearStatus();
    resultsEl.hidden = false;
    resultsEl.scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    analyzeBtn.disabled = images.length === 0;
  }
});

const BADGE_COLORS = {
  high: "green", medium: "yellow", low: "red",
  confirmed: "green", likely: "yellow", possible: "gray",
  cosmetic: "gray", minor: "green", major: "yellow", critical: "red",
  easy: "green", moderate: "yellow", hard: "red", "professional-only": "red",
};

function badge(text) {
  const span = document.createElement("span");
  span.className = `badge ${BADGE_COLORS[text] || "gray"}`;
  span.textContent = text;
  return span;
}

function renderResults(a) {
  const deviceCard = document.getElementById("device-card");
  deviceCard.innerHTML = "";
  const h2 = document.createElement("h2");
  h2.textContent = `🔍 ${a.device.identification || a.device.type}`;
  const meta = document.createElement("p");
  meta.className = "meta";
  meta.append(badge(a.device.confidence), ` confidence · ${a.device.type}`);
  const desc = document.createElement("p");
  desc.textContent = a.device.description;
  deviceCard.append(h2, meta, desc);

  const diag = document.getElementById("diagnosis-list");
  diag.innerHTML = "";
  if (!a.diagnosis.length) {
    diag.textContent = "No faults identified from the provided images and notes.";
  }
  for (const d of a.diagnosis) {
    const item = document.createElement("div");
    item.className = "item";
    const h3 = document.createElement("h3");
    h3.textContent = d.issue;
    const badges = document.createElement("p");
    badges.append(badge(d.likelihood), badge(d.severity), badge(d.repair_difficulty));
    const ev = document.createElement("p");
    ev.innerHTML = `<strong>Evidence:</strong> `;
    ev.append(d.evidence);
    const cost = document.createElement("p");
    cost.className = "meta";
    cost.textContent = `Estimated cost: ${d.estimated_cost}`;
    item.append(h3, badges, ev, cost);
    if (d.repair_steps.length) {
      const det = document.createElement("details");
      const sum = document.createElement("summary");
      sum.textContent = "Repair steps";
      const ol = document.createElement("ol");
      d.repair_steps.forEach((s) => {
        const li = document.createElement("li");
        li.textContent = s;
        ol.appendChild(li);
      });
      det.append(sum, ol);
      if (d.tools_needed.length) {
        const tools = document.createElement("p");
        tools.className = "meta";
        tools.textContent = `Tools: ${d.tools_needed.join(", ")}`;
        det.appendChild(tools);
      }
      item.appendChild(det);
    }
    diag.appendChild(item);
  }

  const parts = document.getElementById("parts-list");
  parts.innerHTML = "";
  if (!a.donor_parts.length) {
    parts.textContent = "No notable donor parts identified.";
  }
  for (const p of a.donor_parts) {
    const item = document.createElement("div");
    item.className = "item";
    const h3 = document.createElement("h3");
    h3.textContent = p.component;
    const badges = document.createElement("p");
    badges.append(badge(p.salvage_difficulty), ` salvage · ${p.approximate_value}`);
    badges.className = "meta";
    const loc = document.createElement("p");
    loc.innerHTML = "<strong>Location:</strong> ";
    loc.append(p.location);
    const cond = document.createElement("p");
    cond.innerHTML = "<strong>Condition:</strong> ";
    cond.append(p.condition);
    item.append(h3, badges, loc, cond);
    if (p.compatible_uses.length) {
      const uses = document.createElement("p");
      uses.innerHTML = "<strong>Compatible with / useful for:</strong> ";
      uses.append(p.compatible_uses.join("; "));
      item.appendChild(uses);
    }
    const det = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent = "Removal notes";
    const notes = document.createElement("p");
    notes.textContent = p.removal_notes;
    det.append(sum, notes);
    item.appendChild(det);
    parts.appendChild(item);
  }

  const safetyCard = document.getElementById("safety-card");
  const safetyList = document.getElementById("safety-list");
  safetyList.innerHTML = "";
  safetyCard.hidden = !a.safety_warnings.length;
  a.safety_warnings.forEach((w) => {
    const li = document.createElement("li");
    li.textContent = w;
    safetyList.appendChild(li);
  });

  const qualityCard = document.getElementById("quality-card");
  qualityCard.hidden = !a.image_quality_notes;
  document.getElementById("quality-notes").textContent = a.image_quality_notes;
}

// ---------- Follow-up chat ----------

const followupInput = document.getElementById("followup-input");
const followupBtn = document.getElementById("followup-btn");
followupBtn.addEventListener("click", askFollowup);
followupInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") askFollowup();
});

async function askFollowup() {
  const question = followupInput.value.trim();
  if (!question || !currentAnalysis) return;
  followupInput.value = "";
  followupBtn.disabled = true;
  appendChat("user", question);
  const pending = appendChat("assistant", "Thinking…");
  try {
    const res = await fetch("/api/followup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ analysis: currentAnalysis, question, history: chatHistory }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    pending.textContent = body.answer;
    chatHistory.push({ role: "user", content: question }, { role: "assistant", content: body.answer });
  } catch (err) {
    pending.textContent = `Error: ${err.message}`;
  } finally {
    followupBtn.disabled = false;
  }
}

function appendChat(role, text) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.textContent = text;
  document.getElementById("chat-log").appendChild(div);
  div.scrollIntoView({ behavior: "smooth", block: "nearest" });
  return div;
}

// ---------- Status helpers ----------

function setStatus(text, isError = false) {
  statusEl.hidden = false;
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}
function clearStatus() {
  statusEl.hidden = true;
  statusEl.classList.remove("error");
}
