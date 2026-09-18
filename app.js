/* ============================================================
   J.A.R.V.I.S. UI -- main controller
   ------------------------------------------------------------
   Pipeline phases:
     CAPTURE  : mic recording          (state: listening)
     ASR      : audio uploaded         (state: thinking, before "question" event)
     LLM      : transformer generating (state: thinking, after  "question" event)
     TTS      : audio playing          (state: speaking)

   Latency measured: T_audio_send -> T_first_audio  (end-to-end perceived).

   This version:
     * removes the PCM queue + scheduler; schedules every chunk inline
     * cuts BUFFER_AHEAD 50ms -> 15ms
     * renders the AI bubble + streams text on `chunk_start` rather than
       waiting for the first audio chunk (often saves 500-1000 ms of
       perceived latency)
     * shows a thinking-orbit + animated dots while waiting
     * tracks per-response latency, live sparkline, avg/min/max
   ============================================================ */

// ============================================================
// BACKEND ENDPOINTS
// ------------------------------------------------------------
// Loaded from config.js (keep in sync with Common/Config/url_config.json).
// Vercel hosts only this UI; ASR/LLM/TTS stay on ngrok/Colab.
// ============================================================
const _auraCfg = window.AURA_CONFIG || {};
const ASR_URL =
  _auraCfg.asrUrl ||
  "https://cherelle-sandiest-voluminously.ngrok-free.dev/transcribe_stream";
const TTS_SOCKET_URL =
  _auraCfg.ttsSocketUrl ||
  "https://dizygotic-marlyn-disobediently.ngrok-free.dev";
const NGROK_SKIP = _auraCfg.ngrokSkipBrowserWarning || "69420";

// ============================================================
// SOCKET  (TTS → UI audio)
// ============================================================
const socket = io(TTS_SOCKET_URL, {
  transports: ["websocket", "polling"],
  extraHeaders: {
    "ngrok-skip-browser-warning": NGROK_SKIP,
  },
  transportOptions: {
    polling: {
      extraHeaders: {
        "ngrok-skip-browser-warning": NGROK_SKIP,
      },
    },
  },
});

// ============================================================
// CHAT / RENDER STATE
// ============================================================
const questionRenderedForId = new Set();
const currentAIMessageById  = {};       // id -> { root, body, latencyEl }
const pendingTextById       = {};
const firstAudioStampForId  = {};       // id -> performance.now() at first audio

// ============================================================
// DOM
// ============================================================
const recordBtn   = document.getElementById("recordBtn");
const pauseBtn    = document.getElementById("pauseBtn");
const clearBtn    = document.getElementById("clearBtn");

// ============================================================
// SPEAK <-> STOP toggle
// ------------------------------------------------------------
// Only one of these two buttons is visible at a time.  They live in
// the same slot in the control panel.  Default: SPEAK visible.
//   showStopButton()  -- called when recording starts.
//   showSpeakButton() -- called when TTS finishes, on hard-interrupt,
//                        or on CLEAR.
// ============================================================
function showStopButton() {
  recordBtn.style.display = "none";
  pauseBtn.style.display  = "";
}
function showSpeakButton() {
  pauseBtn.style.display  = "none";
  recordBtn.style.display = "";
  recordBtn.classList.remove("active");
}
const statusText  = document.getElementById("statusText");
const modePill    = document.getElementById("modePill");
const modeText    = document.getElementById("modeText");
const chatContainer    = document.getElementById("chatContainer");
const voiceBars   = Array.from(document.querySelectorAll("#voiceBars .vbar"));
const neuralBars  = Array.from(document.querySelectorAll("#neuralBars .mb"));
const transcriptCountEl = document.getElementById("transcriptCount");
const hudLatency  = document.getElementById("hudLatency");
const hudUptime   = document.getElementById("hudUptime");
const hudClock    = document.getElementById("hudClock");
const neuralPct   = document.getElementById("neuralPct");
const audioLevelTxt = document.getElementById("audioLevelTxt");
const outputTxt   = document.getElementById("outputTxt");
const sessQueries = document.getElementById("sessQueries");
const sessTokens  = document.getElementById("sessTokens");
const sessTtfb    = document.getElementById("sessTtfb");
const diagSocket  = document.getElementById("diagSocket");
const thinkingOrbit = document.getElementById("thinkingOrbit");

// pipeline phase dots
const pipelineEl  = document.getElementById("pipeline");
const phEls       = Array.from(pipelineEl.querySelectorAll(".ph"));
const phLines     = Array.from(pipelineEl.querySelectorAll(".ph-line"));

// language picker + emotion badge -- the orchestrator now needs a
// per-turn language hint (NLLB-200 code) so it knows which translation
// direction to run; emotion is the optional debug badge surfaced from
// the LLM phase events.
const langSelect    = document.getElementById("langSelect");
const emotionBadge  = document.getElementById("emotionBadge");

// Persist the last-selected language across reloads so users don't
// have to re-pick every session.
const STORED_LANG = localStorage.getItem("aura.lang") || "ben_Beng";
if (langSelect) {
  langSelect.value = STORED_LANG;
  langSelect.addEventListener("change", () => {
    localStorage.setItem("aura.lang", langSelect.value);
  });
}

function currentLang() {
  return (langSelect && langSelect.value) || "ben_Beng";
}

function setEmotionBadge(emotion) {
  if (!emotionBadge) return;
  if (!emotion || emotion === "neutral") {
    emotionBadge.style.display = "none";
    return;
  }
  emotionBadge.style.display = "inline-block";
  emotionBadge.textContent = emotion;
  emotionBadge.style.borderColor = (
    emotion === "sad"        ? "rgba(96,165,250,0.7)"  :
    emotion === "angry"      ? "rgba(248,113,113,0.7)" :
    emotion === "frustrated" ? "rgba(251,191,36,0.7)"  :
    emotion === "happy"      ? "rgba(74,222,128,0.7)"  :
                               "rgba(34,211,238,0.4)"
  );
  emotionBadge.style.color = (
    emotion === "sad"        ? "#60a5fa" :
    emotion === "angry"      ? "#f87171" :
    emotion === "frustrated" ? "#fbbf24" :
    emotion === "happy"      ? "#4ade80" :
                               "#22d3ee"
  );
}

// latency widget
const latLive   = document.getElementById("latLive");
const latAvg    = document.getElementById("latAvg");
const latMin    = document.getElementById("latMin");
const latMax    = document.getElementById("latMax");
const latSpark      = document.getElementById("latSpark");
const latSparkFill  = document.getElementById("latSparkFill");

// ============================================================
// PIPELINE PHASE TRACKER
// ------------------------------------------------------------
// Phases ordered: capture -> asr -> llm -> tts
// Calling setPhase(name) lights up `name` and marks earlier phases done.
// Calling resetPhases() clears everything.
// ============================================================
const PHASE_ORDER = ["capture", "asr", "llm", "tts"];

function setPhase(name) {
  const idx = PHASE_ORDER.indexOf(name);
  phEls.forEach((el, i) => {
    el.classList.remove("active", "done");
    if (i < idx) el.classList.add("done");
    if (i === idx) el.classList.add("active");
  });
  phLines.forEach((el, i) => {
    el.classList.toggle("lit", i < idx);
  });
}
function resetPhases() {
  phEls.forEach((el) => el.classList.remove("active", "done"));
  phLines.forEach((el) => el.classList.remove("lit"));
}

// ============================================================
// CHAT HELPERS
// ============================================================
function buildMessageEl(text, type) {
  const msg = document.createElement("div");
  msg.className = `message ${type}`;

  const who = document.createElement("span");
  who.className = "who";
  const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  who.innerHTML = `${type === "user" ? "You" : "AURA"}<span class="when">${stamp}</span>`;
  msg.appendChild(who);

  const body = document.createElement("span");
  body.className = "msg-body";
  body.textContent = text;
  msg.appendChild(body);

  return { root: msg, body };
}

function hideTranscriptEmpty() {
  const empty = document.getElementById("transcriptEmpty");
  if (empty) empty.remove();
}

function updateTranscriptCount() {
  const n = chatContainer.querySelectorAll(".message").length;
  transcriptCountEl.textContent = n === 0
    ? "No messages yet"
    : `${n} message${n === 1 ? "" : "s"}`;
}

// `beforeNode`: optional. If provided AND attached to chatContainer,
// the user message is inserted immediately before it -- this is what
// keeps DOM order USER -> AI even when the chunk_start event for a new
// generation races ahead of the question event (Flask-SocketIO's
// threading async_mode does NOT guarantee ordering of emits made from
// different worker threads, so chunk_start can land first and create
// an AI placeholder before we know what the user said).
function addUserMessage(text, beforeNode) {
  hideTranscriptEmpty();
  const { root } = buildMessageEl(text, "user");
  if (beforeNode && beforeNode.parentNode === chatContainer) {
    chatContainer.insertBefore(root, beforeNode);
  } else {
    chatContainer.appendChild(root);
  }
  chatContainer.scrollTop = chatContainer.scrollHeight;
  updateTranscriptCount();
  return root;
}

// Create a "thinking" AI placeholder right away so the user always
// sees motion in the chat. Text gets streamed into `body` as soon as
// chunk_start events arrive.
function addAIPlaceholder(genId) {
  hideTranscriptEmpty();
  const msg = document.createElement("div");
  msg.className = "message ai thinking live";

  const who = document.createElement("span");
  who.className = "who";
  const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  who.innerHTML = `AURA<span class="when">${stamp}</span>`;
  msg.appendChild(who);

  const body = document.createElement("span");
  body.className = "msg-body";
  msg.appendChild(body);

  // dots indicator -- replaced with actual text on first chunk
  const dots = document.createElement("span");
  dots.className = "think-dots";
  dots.innerHTML = "<span></span><span></span><span></span>";
  msg.appendChild(dots);

  // latency badge -- filled in when first audio arrives
  const lat = document.createElement("div");
  lat.className = "lat-badge";
  lat.innerHTML = `<span class="bolt"></span><span class="lat-val">preparing reply…</span>`;
  msg.appendChild(lat);

  chatContainer.appendChild(msg);
  chatContainer.scrollTop = chatContainer.scrollHeight;
  updateTranscriptCount();

  return { root: msg, body, dotsEl: dots, latencyEl: lat };
}

function settleLive() {
  chatContainer.querySelectorAll(".message.ai.live").forEach((el) => {
    el.classList.remove("live");
  });
}

// ============================================================
// LATENCY TRACKER (per-response, rolling)
// ============================================================
const latHistory = [];   // raw ms values, internal units
let latLiveValue = null;

// Single source of truth for how latency is rendered to the user.
// We track in ms internally (because performance.now() is ms) but the
// user is shown seconds with two decimals -- raw ms numbers become hard
// to read once they cross 1000.
function fmtLat(ms) {
  if (ms == null || !isFinite(ms)) return "— s";
  return `${(ms / 1000).toFixed(2)} s`;
}

function recordLatency(ms) {
  latHistory.push(ms);
  if (latHistory.length > 30) latHistory.shift();
  latLiveValue = ms;

  const avg = latHistory.reduce((a, b) => a + b, 0) / latHistory.length;
  const min = Math.min(...latHistory);
  const max = Math.max(...latHistory);

  latLive.textContent = fmtLat(ms);
  latAvg.textContent  = fmtLat(avg);
  latMin.textContent  = fmtLat(min);
  latMax.textContent  = fmtLat(max);
  hudLatency.textContent = fmtLat(ms);
  sessTtfb.textContent   = fmtLat(avg);

  // color-tint the live number based on quality
  latLive.classList.remove("green", "amber", "red");
  if (ms < 1200) latLive.classList.add("green");
  else if (ms < 2500) latLive.classList.add("amber");
  else latLive.classList.add("red");

  drawSparkline();
}

function drawSparkline() {
  if (latHistory.length === 0) return;
  const maxV = Math.max(800, Math.max(...latHistory) * 1.05);
  const w = 100, h = 36;
  const pts = latHistory.map((v, i) => {
    const x = (i / Math.max(1, latHistory.length - 1)) * w;
    const y = h - (v / maxV) * (h - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  latSpark.setAttribute("points", pts);
  latSparkFill.setAttribute(
    "points",
    `0,${h} ${pts} ${w},${h}`
  );
}

function latencyBadgeClass(ms) {
  if (ms < 1200) return "";
  if (ms < 2500) return "amber";
  return "red";
}

// ============================================================
// AUDIO CONTEXT  (TTS playback)
// ============================================================
const audioContext = new (window.AudioContext || window.webkitAudioContext)({
  latencyHint: "interactive",
  sampleRate: 24000,
});

const ttsAnalyser = audioContext.createAnalyser();
ttsAnalyser.fftSize = 512;
ttsAnalyser.smoothingTimeConstant = 0.6;

// Master gain sits between the analyser and the speakers.  Setting it
// to 0 is the only way to guarantee *instant* silence -- BufferSource
// .stop() can leave a few ms of already-scheduled audio in the graph.
const ttsMasterGain = audioContext.createGain();
ttsMasterGain.gain.value = 1;
ttsAnalyser.connect(ttsMasterGain);
ttsMasterGain.connect(audioContext.destination);
const ttsBins = new Uint8Array(ttsAnalyser.frequencyBinCount);

let currentGenerationId = null;
let audioSequence = 0;

// ------------------------------------------------------------
// Audio scheduling -- no queue, no async loop.
//
// We schedule each PCM chunk against an advancing `scheduledTime`
// playhead.
//
// Why a generous INITIAL_BUFFER matters:
//   The TTS server emits the first audio chunk after only
//   FIRST_CHUNK_SIZE = 10 GPT tokens (~200 ms of speech). The
//   second chunk is STREAM_CHUNK_SIZE = 30 tokens and the model
//   needs ~250-400 ms to produce it. If we start playing chunk 0
//   immediately, it ends BEFORE chunk 1 lands -> we resync with
//   RESYNC_GAP -> audible stutter at the start of every reply.
//
//   Bumping INITIAL_BUFFER to 200 ms means chunk 0 finishes around
//   the same moment chunk 1 arrives, so they queue tail-to-head and
//   playback is glitch-free for the rest of the sentence.
//
//   * INITIAL_BUFFER (200 ms): one-time head-start at the FIRST
//     chunk of each new audio sequence.
//   * RESYNC_GAP (40 ms): only used if we genuinely fell behind
//     (`scheduledTime < now`). Rare, long stall only.
//
// Net cost: ~200 ms once at the start of each spoken response.
// Net win: no initial jitter, smooth speech.
// ------------------------------------------------------------
const INITIAL_BUFFER = 0.20;
const RESYNC_GAP     = 0.04;
let scheduledTime    = 0;
let bufferedSeq      = -1;

// Tracks every BufferSource we've scheduled for the current turn.
// The hard-interrupt code path iterates this set and calls .stop() on
// each so playback halts immediately -- audioSequence++ only filters
// FUTURE chunks; live/queued sources keep firing until they finish.
const liveAudioSources = new Set();
let streamEndTimer = null;

function cancelStreamEndTimer() {
  if (streamEndTimer != null) {
    clearTimeout(streamEndTimer);
    streamEndTimer = null;
  }
}

function playPCMChunk(pcm, seq) {
  if (seq !== audioSequence) return;            // stale chunk
  if (!pcm || pcm.length === 0) return;

  // Restore output path after a barge-in mute.
  ttsMasterGain.gain.cancelScheduledValues(audioContext.currentTime);
  ttsMasterGain.gain.setValueAtTime(1, audioContext.currentTime);

  const buffer = audioContext.createBuffer(1, pcm.length, 24000);
  buffer.copyToChannel(pcm, 0);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(ttsAnalyser);
  liveAudioSources.add(source);
  source.onended = () => { liveAudioSources.delete(source); };

  const now = audioContext.currentTime;

  if (bufferedSeq !== seq) {
    // First chunk for this sequence -- give the network a head start.
    bufferedSeq = seq;
    scheduledTime = now + INITIAL_BUFFER;
  } else if (scheduledTime < now) {
    // We genuinely fell behind (long stall). Resync with a small gap
    // so the next chunk doesn't click against a still-decoding source.
    scheduledTime = now + RESYNC_GAP;
  }
  // Otherwise scheduledTime is already in the future -- queue the
  // new chunk tail-to-head with NO extra gap. This is what eliminates
  // the per-chunk micro-pauses.

  source.start(scheduledTime);
  scheduledTime += buffer.duration;
}

// Hard-cancel every audio buffer currently scheduled or playing.
// Safe to call at any time; missing/finished sources are ignored.
function killLocalAudio() {
  cancelStreamEndTimer();

  // Instant silence -- even for chunks scheduled far in the future.
  ttsMasterGain.gain.cancelScheduledValues(audioContext.currentTime);
  ttsMasterGain.gain.setValueAtTime(0, audioContext.currentTime);

  const stopAt = audioContext.currentTime;
  for (const src of liveAudioSources) {
    try {
      src.onended = null;
      src.stop(stopAt);
      src.disconnect();
    } catch (_) {}
  }
  liveAudioSources.clear();
  audioSequence++;               // filter any late-arriving chunks
  bufferedSeq = -1;
  scheduledTime = audioContext.currentTime;
}

window.addEventListener(
  "click",
  async () => {
    if (audioContext.state === "suspended") await audioContext.resume();
  },
  { once: true }
);

// ============================================================
// AI STATE MACHINE
// ============================================================
const STATES = {
  idle:      { color: 0x22d3ee, label: "Ready",       text: "Press Speak to start" },
  listening: { color: 0x34d399, label: "Listening",   text: "Speak now — tap Stop when done" },
  thinking:  { color: 0xfbbf24, label: "Thinking",    text: "Working on your reply…" },
  speaking:  { color: 0xf472b6, label: "Speaking",    text: "Speak anytime to interrupt" },
};
let aiState = "idle";
let auraFace = null;

function setState(next) {
  if (aiState === next) return;
  const prev = aiState;
  aiState = next;
  const conf = STATES[next];
  statusText.textContent = conf.label;
  modeText.textContent = next === "idle" ? "READY" : next.toUpperCase();
  modePill.classList.remove("listening", "thinking", "speaking");
  if (next !== "idle") modePill.classList.add(next);

  const liveTag = document.querySelector(".live-tag");
  if (liveTag) liveTag.textContent = conf.text;

  // thinking-orbit only while LLM/ASR are working
  if (next === "thinking") thinkingOrbit.classList.add("on");
  else                     thinkingOrbit.classList.remove("on");

  // Drive modular voxel face states
  if (auraFace) {
    if (next === "listening") {
      auraFace.onListeningStart();
    } else if (prev === "listening") {
      auraFace.onListeningEnd();
    }
    if (next === "thinking") {
      auraFace.onThinkingStart();
    } else if (prev === "thinking" && next !== "speaking") {
      auraFace.onThinkingEnd();
    }
    if (next === "speaking") {
      auraFace.onTTSStart(null, null);
    } else if (prev === "speaking") {
      auraFace.onTTSEnd();
    }
    if (next === "idle" && prev !== "speaking") {
      // ensure calm idle if we didn't come from TTS end
      if (prev === "listening") auraFace.onListeningEnd();
      if (prev === "thinking") auraFace.onThinkingEnd();
    }
  }

  // Continuous barge-in listen while AI is thinking/speaking.
  if (next === "speaking" || next === "thinking") {
    if (prev !== "speaking" && prev !== "thinking") {
      startBargeInMonitor({
        graceMs: next === "speaking" ? BARGE_IN_GRACE_MS : 400,
      });
    } else if (next === "speaking") {
      // Fresh grace window when TTS audio actually begins.
      bargeInGraceUntil = performance.now() + BARGE_IN_GRACE_MS;
    }
  } else if (next === "idle" && !recording) {
    stopBargeInMonitor({ keepMic: false });
  }
}

// ============================================================
// 3D VOXEL AI FACE (AuraFace module)
// ============================================================
const orbCanvas = document.getElementById("orbCanvas");
const center    = orbCanvas.parentElement;

try {
  auraFace = window.AuraFace.create(orbCanvas, { resX: 56, resY: 72 });
  // Lip-sync fallback: analyse the same TTS Web Audio graph
  auraFace.setAnalyser(ttsAnalyser);
  console.log(`[AuraFace] voxels=${auraFace.voxelCount}`);
} catch (err) {
  console.error("[AuraFace] failed to init", err);
}

function resizeRenderer() {
  if (auraFace) auraFace.resize(center.clientWidth, center.clientHeight);
}
window.addEventListener("resize", resizeRenderer);
resizeRenderer();

// Keep a no-op color target so any leftover references are safe.
const orbTargetColor = { setHex() {} };

// ============================================================
// 2D PARTICLE BACKDROP
// ============================================================
const particlesCanvas = document.getElementById("particlesCanvas");
const pctx = particlesCanvas.getContext("2d");
let particles = [];

function resizeParticles() {
  particlesCanvas.width  = window.innerWidth;
  particlesCanvas.height = window.innerHeight;
  particles = [];
  const count = Math.floor((window.innerWidth * window.innerHeight) / 22000);
  for (let i = 0; i < count; i++) {
    particles.push({
      x:  Math.random() * particlesCanvas.width,
      y:  Math.random() * particlesCanvas.height,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
      r:  Math.random() * 1.2 + 0.3,
      a:  Math.random() * 0.5 + 0.2,
    });
  }
}
window.addEventListener("resize", resizeParticles);
resizeParticles();

function drawParticles() {
  pctx.clearRect(0, 0, particlesCanvas.width, particlesCanvas.height);
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.x < 0) p.x = particlesCanvas.width;
    if (p.x > particlesCanvas.width) p.x = 0;
    if (p.y < 0) p.y = particlesCanvas.height;
    if (p.y > particlesCanvas.height) p.y = 0;

    pctx.beginPath();
    pctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    pctx.fillStyle = `rgba(34,211,238,${p.a})`;
    pctx.fill();
  }
}

// ============================================================
// MIC ANALYSER (only live while recording)
// ============================================================
let micAnalyser = null;
let micBins     = null;

// ============================================================
// ANIMATION LOOP
// ============================================================
let smoothAmp = 0;
let lastTime  = performance.now() / 1000;

function readAmplitude() {
  if (aiState === "listening" && micAnalyser) {
    micAnalyser.getByteFrequencyData(micBins);
    let sum = 0;
    for (let i = 0; i < micBins.length; i++) sum += micBins[i];
    return (sum / micBins.length) / 255;
  }
  if (aiState === "speaking") {
    ttsAnalyser.getByteFrequencyData(ttsBins);
    let sum = 0;
    for (let i = 0; i < ttsBins.length; i++) sum += ttsBins[i];
    return (sum / ttsBins.length) / 255;
  }
  if (aiState === "thinking") {
    return 0.20 + 0.15 * Math.sin(performance.now() * 0.006);
  }
  return 0.08 + 0.05 * Math.sin(performance.now() * 0.001);
}

function readSpectrum() {
  if (aiState === "listening" && micAnalyser) {
    micAnalyser.getByteFrequencyData(micBins);
    return micBins;
  }
  ttsAnalyser.getByteFrequencyData(ttsBins);
  return ttsBins;
}

function tick() {
  const now = performance.now() / 1000;
  const dt  = Math.min(0.05, now - lastTime);
  lastTime  = now;

  const rawAmp = readAmplitude();
  smoothAmp = smoothAmp * 0.82 + rawAmp * 0.18;

  if (auraFace) {
    if (aiState === "speaking") {
      auraFace.onTTSProgress(performance.now());
    }
    auraFace.update(dt, now);
  }

  const spec = readSpectrum();
  const N = voiceBars.length;
  const step = Math.max(1, Math.floor(spec.length / N));
  for (let i = 0; i < N; i++) {
    let v = spec[i * step] / 255;
    v = Math.max(v, 0.05 + smoothAmp * 0.25);
    voiceBars[i].style.height = `${4 + v * 56}px`;
  }

  for (let i = 0; i < neuralBars.length; i++) {
    const v = 0.2 + Math.abs(Math.sin(now * 1.7 + i * 0.6)) * (0.35 + smoothAmp * 1.2);
    neuralBars[i].style.height = `${Math.min(100, v * 100)}%`;
  }
  neuralPct.textContent = `${Math.round(smoothAmp * 100)}%`;

  if (aiState === "speaking") {
    outputTxt.textContent = `${Math.round(smoothAmp * 100)}%`;
  } else if (aiState === "listening") {
    outputTxt.textContent = "—";
  }

  if (aiState === "listening" && smoothAmp > 0.005) {
    const db = 20 * Math.log10(smoothAmp);
    audioLevelTxt.textContent = `${db.toFixed(1)} dB`;
  } else if (aiState !== "listening") {
    audioLevelTxt.textContent = "−∞ dB";
  }

  if (aiState === "thinking") {
    let activeStart = pendingQueryStartAt;
    if (!activeStart && currentGenerationId != null) {
      activeStart = queryStartByGenId[currentGenerationId] || 0;
    }
    if (activeStart) {
      const elapsed = performance.now() - activeStart;
      hudLatency.textContent = fmtLat(elapsed);
      latLive.textContent = fmtLat(elapsed);
      latLive.classList.remove("green", "amber", "red");
      if (elapsed > 4000)      latLive.classList.add("red");
      else if (elapsed > 2000) latLive.classList.add("amber");
    }
  }

  drawParticles();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ============================================================
// HUD CLOCK + UPTIME
// ============================================================
const sessionStart = Date.now();
function updateHud() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  hudClock.textContent =
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  const up = Math.floor((Date.now() - sessionStart) / 1000);
  hudUptime.textContent = `${pad(Math.floor(up / 60))}:${pad(up % 60)}`;
}
setInterval(updateHud, 1000);
updateHud();

// ============================================================
// SOCKET EVENTS
// ============================================================
socket.on("connect", () => {
  diagSocket.textContent = "CONNECTED";
  diagSocket.classList.remove("warn");
  diagSocket.classList.add("ok");
});

socket.on("disconnect", () => {
  diagSocket.textContent = "OFFLINE";
  diagSocket.classList.remove("ok");
  diagSocket.classList.add("warn");
});

// ------------------------------------------------------------
// Per-generation latency tracking.
//   `pendingQueryStartAt` is set the moment the user clicks Stop --
//   we don't yet know the gen_id (the server assigns it). The first
//   server event that DOES carry a gen_id (question / chunk_start)
//   claims that pending value into `queryStartByGenId`.
//
//   This replaces the older single-global `lastQuerySentAt`, which
//   broke whenever audio_stream raced the question event (the bubble
//   was created with a different gen_id than the one currentGenerationId
//   pointed at, so the badge never got stamped and stayed stuck on
//   "measuring…").
// ------------------------------------------------------------
let pendingQueryStartAt = 0;
const queryStartByGenId = {};

function claimGenStart(genId) {
  if (genId == null) return;
  if (pendingQueryStartAt && !queryStartByGenId[genId]) {
    queryStartByGenId[genId] = pendingQueryStartAt;
    pendingQueryStartAt = 0;
  }
}

function stampLatencyForGen(genId) {
  if (firstAudioStampForId[genId]) return;            // already stamped
  firstAudioStampForId[genId] = performance.now();

  const startTs = queryStartByGenId[genId];
  if (!startTs) return;                               // nothing to stamp against

  const tt = performance.now() - startTs;
  recordLatency(tt);
  delete queryStartByGenId[genId];

  const ref = currentAIMessageById[genId];
  if (ref && ref.latencyEl) {
    ref.latencyEl.classList.remove("amber", "red");
    const cls = latencyBadgeClass(tt);
    if (cls) ref.latencyEl.classList.add(cls);
    const valEl = ref.latencyEl.querySelector(".lat-val");
    if (valEl) valEl.textContent = fmtLat(tt);
  }
}

// Centralised user-bubble renderer. Safe to call from BOTH the
// `question` event and the `chunk_start` fallback path -- the
// questionRenderedForId set guarantees idempotency.
function renderUserBubbleOnce(genId, questionText) {
  if (genId == null || !questionText) return;
  if (questionRenderedForId.has(genId)) return;
  const existingAI = currentAIMessageById[genId];
  addUserMessage(questionText, existingAI ? existingAI.root : null);
  questionRenderedForId.add(genId);
  sessQueries.textContent = String(parseInt(sessQueries.textContent, 10) + 1);
}

// The server pushes "question" the moment LLM accepts the ASR result.
// We use that as our cue to render the user bubble + an AI placeholder,
// then advance the pipeline from ASR -> LLM.
socket.on("question", (data) => {
  console.log("[socket] question", data);
  currentGenerationId = data.generation_id;
  claimGenStart(data.generation_id);

  // Reset the per-turn emotion badge -- whatever we showed last turn
  // is now stale.  chunk_start will repopulate it if Phase 1 fires.
  setEmotionBadge("neutral");

  // stop any audio left from a previous turn
  killLocalAudio();
  settleLive();

  renderUserBubbleOnce(data.generation_id, data.question);

  // pre-build the AI placeholder so chunk_start can stream into it
  // immediately. This is what makes the response feel instant -- text
  // starts appearing as soon as the LLM produces its first token,
  // long before the TTS audio is ready.
  if (!currentAIMessageById[currentGenerationId]) {
    currentAIMessageById[currentGenerationId] =
      addAIPlaceholder(currentGenerationId);
  }

  setState("thinking");
  setPhase("llm");
});

// chunk_start = LLM produced a partial text chunk. Stream it into
// the live AI bubble RIGHT NOW. This is the perceived-latency fix.
socket.on("chunk_start", (data) => {
  console.log("[socket] chunk_start", data);

  // The orchestrator now tags every chunk with an `emotion` directly
  // (and a `phase` for debug):
  //   phase = "empathy-sad"|"empathy-angry"|"factual"|"factual-fallback"
  //   emotion = "sad"|"angry"|"neutral"|...
  //
  // Phase 1 (empathy) sets emotion to the actual detected emotion.
  // Phase 2 (factual) always sends emotion="neutral", which makes the
  // badge auto-clear when the LLM transitions from empathy -> facts.
  if (data && typeof data.emotion === "string" && data.emotion) {
    setEmotionBadge(data.emotion);
  } else if (data && data.phase && typeof data.phase === "string") {
    const m = data.phase.match(/^empathy-(.+)$/);
    if (m) setEmotionBadge(m[1]);
    else if (data.phase.startsWith("factual")) setEmotionBadge("neutral");
  }

  // chunk_start carries a reliable gen_id and ALWAYS arrives before
  // the audio_stream bytes for that segment (server emits it first).
  // Pin currentGenerationId here too so a "question" event that races
  // chunk_start doesn't leave us with a stale gen pointer when audio
  // arrives.
  if (data && data.generation_id != null) {
    currentGenerationId = data.generation_id;
    claimGenStart(data.generation_id);
  }

  const id = data.generation_id;

  // Fallback path: if `question` event was lost / reordered, the TTS
  // server attaches the cached question to the FIRST chunk_start of
  // each gen. Render the user bubble FIRST so DOM order stays
  // USER -> AI even if we end up creating the AI placeholder below.
  if (data.question) {
    renderUserBubbleOnce(id, data.question);
  }

  if (!pendingTextById[id]) pendingTextById[id] = "";
  pendingTextById[id] += (data.text || "");

  // ensure the AI bubble exists (in case audio races chunk_start)
  if (!currentAIMessageById[id]) {
    currentAIMessageById[id] = addAIPlaceholder(id);
  }
  const ref = currentAIMessageById[id];

  // remove the placeholder dots on first real text
  if (ref.root.classList.contains("thinking")) {
    ref.root.classList.remove("thinking");
    if (ref.dotsEl) ref.dotsEl.remove();
  }
  ref.body.textContent = pendingTextById[id];
  chatContainer.scrollTop = chatContainer.scrollHeight;

  // token counter
  const tok = (data.text || "").split(/\s+/).filter(Boolean).length;
  sessTokens.textContent = String(parseInt(sessTokens.textContent, 10) + tok);
});

socket.on("audio_stream", (data) => {
  try {
    if (!data) return;

    let uint8;
    if (data instanceof ArrayBuffer)          uint8 = new Uint8Array(data);
    else if (data instanceof Uint8Array)       uint8 = data;
    else if (data && data.data && Array.isArray(data.data))
                                              uint8 = new Uint8Array(data.data);
    else { console.error("unknown audio payload", data); return; }

    const float32 = new Float32Array(
      uint8.buffer, uint8.byteOffset, uint8.byteLength / 4
    );
    if (float32.length === 0) return;

    // First audio chunk for this generation -> record latency, switch
    // state. The audio_stream payload doesn't carry a gen_id (it's
    // raw bytes), so we use whatever currentGenerationId resolved to
    // by the time chunk_start ran. Because chunk_start is always
    // emitted server-side BEFORE the matching audio bytes, this is
    // reliable -- and we now also defensively claim any unclaimed
    // pendingQueryStartAt for that gen below.
    const genId = currentGenerationId;
    if (genId != null && !firstAudioStampForId[genId]) {
      setState("speaking");
      setPhase("tts");

      // Final safety net: if for some reason chunk_start never fired
      // (or fired without claiming), pull the pending start in now.
      claimGenStart(genId);

      // Make sure there's an AI bubble to stamp.
      if (!currentAIMessageById[genId]) {
        currentAIMessageById[genId] = addAIPlaceholder(genId);
      }
      stampLatencyForGen(genId);
    }

    playPCMChunk(float32, audioSequence);

  } catch (err) {
    console.error("audio_stream error", err);
  }
});

socket.on("stream_end", () => {
  settleLive();
  // schedule the state-down once audio has actually drained.  The
  // Speak button also returns at that moment so the user can only
  // fire off the NEXT turn once the current one is truly finished.
  cancelStreamEndTimer();
  const remaining = Math.max(0, (scheduledTime - audioContext.currentTime) * 1000);
  streamEndTimer = setTimeout(() => {
    streamEndTimer = null;
    setState("idle");
    resetPhases();
    showSpeakButton();
  }, remaining + 50);
});

// ============================================================
// MIC RECORDING + BARGE-IN
// ------------------------------------------------------------
// Speak → manual capture until Stop (unchanged).
// While AI is thinking/speaking, the mic stays open in *monitor*
// mode. Sustained speech (RMS, same idea as R&D/audio_pause.html)
// immediately kills TTS + backend turn and switches into capture.
// Barge-in captures auto-end after trailing silence; Speak captures
// still require an explicit Stop.
// ============================================================
let mediaStream;
let processor;
let audioContextInput;
let recording = false;

const SILENCE_THRESHOLD = 0.012;

// Barge-in: matches audio_pause.html threshold, plus a short hold and
// post-TTS grace so speaker echo does not false-trigger.
const BARGE_IN_SPEECH_THRESHOLD = 0.04;
const BARGE_IN_HOLD_MS          = 140;
const BARGE_IN_GRACE_MS         = 700;
const BARGE_IN_END_SILENCE_MS   = 900;

let bargeInActive          = false;
let bargeInGraceUntil      = 0;
let bargeInSpeechStartedAt = 0;
let captureViaBargeIn      = false;
let lastSpeechAt           = 0;
let micOpenPromise         = null;
let stopRecordingQueued    = false;

let micChunks          = [];
let everSpoke          = false;
let recordingStartedAt = 0;
let capturedSampleRate = 48000;

function closeMic() {
  try { if (processor) processor.disconnect(); } catch (_) {}
  processor = null;
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
  micAnalyser = null;
  micBins = null;
  if (audioContextInput) {
    try { audioContextInput.close(); } catch (_) {}
    audioContextInput = null;
  }
  micOpenPromise = null;
}

function micFrameEnergy(input) {
  let energy = 0;
  for (let i = 0; i < input.length; i++) energy += input[i] * input[i];
  return Math.sqrt(energy / input.length);
}

function onMicProcess(e) {
  const input = e.inputBuffer.getChannelData(0);
  const energy = micFrameEnergy(input);

  if (recording) {
    micChunks.push(new Float32Array(input));

    if (energy > SILENCE_THRESHOLD) {
      everSpoke = true;
      lastSpeechAt = performance.now();
    }

    // ChatGPT-style: after a barge-in utterance, end on silence.
    // Defer so we don't tear down ScriptProcessor inside its own callback.
    if (
      captureViaBargeIn &&
      !stopRecordingQueued &&
      everSpoke &&
      lastSpeechAt > 0 &&
      performance.now() - lastSpeechAt >= BARGE_IN_END_SILENCE_MS
    ) {
      stopRecordingQueued = true;
      queuePromise.resolve().then(() => {
        stopRecordingQueued = false;
        stopRecording();
      });
    }
    return;
  }

  if (!bargeInActive) return;
  if (aiState !== "speaking" && aiState !== "thinking") return;
  if (performance.now() < bargeInGraceUntil) {
    bargeInSpeechStartedAt = 0;
    micChunks = [];
    return;
  }

  if (energy > BARGE_IN_SPEECH_THRESHOLD) {
    if (!bargeInSpeechStartedAt) {
      bargeInSpeechStartedAt = performance.now();
      micChunks = [];
    }
    // Tentatively capture so the trigger syllables are not lost.
    micChunks.push(new Float32Array(input));
    if (performance.now() - bargeInSpeechStartedAt >= BARGE_IN_HOLD_MS) {
      triggerBargeIn();
    }
  } else {
    bargeInSpeechStartedAt = 0;
    micChunks = [];
  }
}

async function ensureMicOpen() {
  if (mediaStream && audioContextInput && processor) return;
  if (micOpenPromise) return micOpenPromise;

  micOpenPromise = (async () => {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
      },
    });

    audioContextInput = new AudioContext();
    const source = audioContextInput.createMediaStreamSource(mediaStream);

    micAnalyser = audioContextInput.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyser.smoothingTimeConstant = 0.5;
    micBins = new Uint8Array(micAnalyser.frequencyBinCount);
    source.connect(micAnalyser);

    processor = audioContextInput.createScriptProcessor(4096, 1, 1);
    source.connect(processor);

    const silence = audioContextInput.createGain();
    silence.gain.value = 0;
    processor.connect(silence);
    silence.connect(audioContextInput.destination);

    processor.onaudioprocess = onMicProcess;
  })();

  try {
    await micOpenPromise;
  } catch (err) {
    micOpenPromise = null;
    closeMic();
    throw err;
  }
}

async function startBargeInMonitor({ graceMs } = {}) {
  bargeInActive = true;
  bargeInGraceUntil = performance.now() + (graceMs ?? BARGE_IN_GRACE_MS);
  bargeInSpeechStartedAt = 0;
  if (recording) return;

  try {
    await ensureMicOpen();
  } catch (err) {
    console.warn("[ui] barge-in mic unavailable", err);
    bargeInActive = false;
  }
}

function stopBargeInMonitor({ keepMic = false } = {}) {
  bargeInActive = false;
  bargeInSpeechStartedAt = 0;
  if (!keepMic && !recording) closeMic();
}

// User spoke over TTS/thinking: kill old turn, start capturing now.
function triggerBargeIn() {
  if (recording) return;
  if (aiState !== "speaking" && aiState !== "thinking") return;

  console.log("[ui] BARGE-IN");
  bargeInActive = false;
  bargeInSpeechStartedAt = 0;

  // Stop local TTS + tell backend to drop the in-flight generation.
  killLocalAudio();
  settleLive();
  try { socket.emit("interrupt", { reason: "barge_in" }); } catch (_) {}

  // micChunks already holds the tentative pre-trigger audio from monitor.
  if (!micChunks.length) micChunks = [];
  everSpoke = true;
  lastSpeechAt = performance.now();
  recordingStartedAt = Date.now();
  pendingQueryStartAt = 0;
  captureViaBargeIn = true;
  capturedSampleRate = audioContextInput ? audioContextInput.sampleRate : 48000;
  recording = true;

  showStopButton();
  recordBtn.classList.add("active");
  setState("listening");
  setPhase("capture");

  const liveTag = document.querySelector(".live-tag");
  if (liveTag) liveTag.textContent = "Interrupted — keep speaking, then pause";
}

recordBtn.onclick = async () => {
  if (recording) return;
  if (aiState === "thinking" || aiState === "speaking") {
    // Speak while AI is live → same path as voice barge-in.
    triggerBargeIn();
    return;
  }

  try {
    if (audioContext.state === "suspended") {
      try { await audioContext.resume(); } catch (_) {}
    }

    showStopButton();
    recordBtn.classList.add("active");
    setState("listening");
    setPhase("capture");

    micChunks = [];
    everSpoke = false;
    lastSpeechAt = 0;
    captureViaBargeIn = false;
    recordingStartedAt = Date.now();
    pendingQueryStartAt = 0;

    await ensureMicOpen();
    capturedSampleRate = audioContextInput.sampleRate;
    recording = true;
  } catch (err) {
    console.error(err);
    recording = false;
    captureViaBargeIn = false;
    closeMic();
    setState("idle");
    statusText.textContent = "MIC ERROR";
    recordBtn.classList.remove("active");
    showSpeakButton();
  }
};

// ------------------------------------------------------------
// STOP button
// ------------------------------------------------------------
//   1) Still recording → finalise buffer and send to ASR.
//   2) Thinking/speaking with no capture → cancel turn (hard interrupt).
// Voice barge-in is handled by triggerBargeIn() above; Stop during a
// barge-in capture still means "I'm done, send it."
// ------------------------------------------------------------
function hardInterrupt(reason) {
  console.log("[ui] HARD INTERRUPT", reason || "");
  recording = false;
  captureViaBargeIn = false;
  killLocalAudio();
  settleLive();
  stopBargeInMonitor({ keepMic: false });
  setState("idle");
  resetPhases();
  showSpeakButton();
  try { socket.emit("interrupt", { reason: reason || "user_stop" }); } catch (_) {}
}

pauseBtn.onclick = () => {
  if (recording) {
    stopRecording();
  } else {
    hardInterrupt("stop_button");
  }
};

async function stopRecording() {
  if (!recording) return;
  recording = false;
  const viaBarge = captureViaBargeIn;
  captureViaBargeIn = false;

  recordBtn.classList.remove("active");

  const sr0 = audioContextInput ? audioContextInput.sampleRate : capturedSampleRate;
  const chunks = micChunks;
  const spoke = everSpoke;
  micChunks = [];

  // Release the capture mic; thinking/speaking will reopen for monitor.
  closeMic();

  if (!spoke || chunks.length === 0) {
    setState("idle");
    resetPhases();
    showSpeakButton();
    return;
  }

  setState("thinking");
  setPhase("asr");

  let flat = flatten(chunks);
  flat = trimLeadingSilence(flat,  sr0, 0.012, 100);
  flat = trimTrailingSilence(flat, sr0, 0.012, viaBarge ? 200 : 150);

  const resampled  = await resampleTo16k(flat, sr0);
  const normalized = normalize(resampled);
  const int16 = float32ToInt16(normalized);

  pendingQueryStartAt = performance.now();
  hudLatency.textContent = fmtLat(0);
  latLive.textContent    = fmtLat(0);

  sendToASR(int16);
}

// ============================================================
// AUDIO UTILS
// ============================================================
function trimLeadingSilence(audio, sampleRate, threshold, preRollMs) {
  const windowSize = Math.floor(sampleRate * 0.020);
  const preRollSamples = Math.floor((sampleRate * preRollMs) / 1000);

  let firstVoicedAt = -1;
  for (let i = 0; i + windowSize < audio.length; i += windowSize) {
    let e = 0;
    for (let j = 0; j < windowSize; j++) e += audio[i + j] * audio[i + j];
    e = Math.sqrt(e / windowSize);
    if (e > threshold) { firstVoicedAt = i; break; }
  }
  if (firstVoicedAt < 0) return audio;
  const start = Math.max(0, firstVoicedAt - preRollSamples);
  return start === 0 ? audio : audio.slice(start);
}

function trimTrailingSilence(audio, sampleRate, threshold, postRollMs) {
  const windowSize = Math.floor(sampleRate * 0.020);
  const postRollSamples = Math.floor((sampleRate * postRollMs) / 1000);

  let lastVoicedAt = -1;
  for (let i = audio.length - windowSize; i >= 0; i -= windowSize) {
    let e = 0;
    for (let j = 0; j < windowSize; j++) e += audio[i + j] * audio[i + j];
    e = Math.sqrt(e / windowSize);
    if (e > threshold) { lastVoicedAt = i + windowSize; break; }
  }
  if (lastVoicedAt < 0) return audio;
  const end = Math.min(audio.length, lastVoicedAt + postRollSamples);
  return end >= audio.length ? audio : audio.slice(0, end);
}

function float32ToInt16(audio) {
  const out = new Int16Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    let s = audio[i];
    if (s > 1)  s = 1;
    if (s < -1) s = -1;
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
  }
  return out;
}

function sendToASR(int16Audio) {
  const lang = currentLang();
  fetch(ASR_URL, {
    method: "POST",
    headers: {
      "Content-Type":   "application/octet-stream",
      "X-Audio-Format": "int16-le",
      "X-Sample-Rate":  "16000",
      "X-Language":     lang,
      "ngrok-skip-browser-warning": NGROK_SKIP,
    },
    body: int16Audio.buffer,
    keepalive: false,
  }).catch((err) => {
    console.error(err);
    setState("idle");
    resetPhases();
    statusText.textContent = "NETWORK ERROR";
    showSpeakButton();
  });
}

function flatten(chunks) {
  let length = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Float32Array(length);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

async function resampleTo16k(float32Arr, inputRate) {
  const ctx = new OfflineAudioContext(
    1, Math.ceil((float32Arr.length * 16000) / inputRate), 16000
  );
  const buf = ctx.createBuffer(1, float32Arr.length, inputRate);
  buf.copyToChannel(float32Arr, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0);
}

function normalize(audio, targetPeak = 0.95, maxGain = 4.0) {
  let max = 0;
  for (let i = 0; i < audio.length; i++) {
    const a = Math.abs(audio[i]);
    if (a > max) max = a;
  }
  if (max <= 0 || max >= targetPeak) return audio;
  const gain = Math.min(targetPeak / max, maxGain);
  for (let i = 0; i < audio.length; i++) audio[i] *= gain;
  return audio;
}

// ============================================================
// CLEAR
// ============================================================
clearBtn.onclick = () => {
  // If a turn is currently live (recording, generating, or speaking),
  // treat CLEAR like a hard interrupt too -- otherwise the backend
  // keeps generating audio into a chat the user just wiped.
  const isLive =
    recording ||
    pauseBtn.style.display !== "none" ||
    aiState === "thinking" ||
    aiState === "speaking";
  if (isLive) {
    if (recording) {
      recording = false;
      captureViaBargeIn = false;
      closeMic();
    }
    hardInterrupt("clear_button");
  }

  chatContainer.innerHTML = `
    <div class="transcript-empty" id="transcriptEmpty">
      <strong>Start a voice chat</strong>
      Tap <em>Speak</em>, talk naturally, then tap <em>Stop</em>. While AURA is answering, just start talking to interrupt.
    </div>`;
  killLocalAudio();
  setState("idle");
  resetPhases();
  setEmotionBadge("neutral");
  updateTranscriptCount();
  sessQueries.textContent = "0";
  sessTokens.textContent  = "0";
  showSpeakButton();
  // keep latency history for trend context; user can reload to wipe
};

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
window.addEventListener("keydown", (e) => {
  if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
  if (e.code === "Space") {
    e.preventDefault();
    // SPACE mirrors whichever button is currently on screen so the
    // hotkey and the click do exactly the same thing.
    if (pauseBtn.style.display !== "none") pauseBtn.click();
    else                                   recordBtn.click();
  } else if (e.code === "Escape") {
    e.preventDefault();
    const productMenu = document.getElementById("productMenu");
    const productToggle = document.getElementById("productToggle");
    if (productMenu && productMenu.classList.contains("open")) {
      productMenu.classList.remove("open");
      if (productToggle) productToggle.setAttribute("aria-expanded", "false");
      return;
    }
    // ESC always kills the turn (including mid-recording) and returns
    // to SPEAK. Voice barge-in (talk-over) is separate from this cancel.
    if (recording) {
      recording = false;
      captureViaBargeIn = false;
      closeMic();
    }
    hardInterrupt("escape_key");
  } else if (e.key.toLowerCase() === "c") {
    clearBtn.click();
  }
});

// ============================================================
// PRODUCT SWITCHER
// ------------------------------------------------------------
// Matches Meetly / Conversation AI switchers so AURA can jump
// back into the platform without going through login again.
// ============================================================
const PRODUCT_URLS = {
  meetly:            "http://localhost:5175/",
  conversation_ai:   "http://localhost:5173/",
  user_interaction:  window.location.origin + "/",
};

function readThemeHint() {
  const q = new URLSearchParams(window.location.search).get("theme");
  if (q === "light" || q === "dark") return q;
  try {
    const stored = localStorage.getItem("platform_theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch (_) {}
  return "dark";
}

function themedProductUrl(rawUrl, theme) {
  try {
    const url = new URL(rawUrl, window.location.href);
    url.searchParams.set("theme", theme || readThemeHint());
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function initProductSwitcher() {
  const toggle = document.getElementById("productToggle");
  const menu = document.getElementById("productMenu");
  const wrap = document.getElementById("productWrap");
  if (!toggle || !menu || !wrap) return;

  const setOpen = (open) => {
    menu.classList.toggle("open", open);
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  };

  toggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(!menu.classList.contains("open"));
  });

  document.addEventListener("click", (e) => {
    if (!wrap.contains(e.target)) setOpen(false);
  });

  menu.querySelectorAll("button[data-product]").forEach((btn) => {
    const key = btn.dataset.product;
    if (key === "user_interaction") {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        setOpen(false);
      });
      return;
    }

    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dest = PRODUCT_URLS[key];
      if (!dest) return;
      window.location.assign(themedProductUrl(dest, readThemeHint()));
    });
  });
}

initProductSwitcher();

// ============================================================
// BOOT
// ============================================================
setState("idle");
resetPhases();
showSpeakButton();
console.log(
  "%cAURA UI online.",
  "color:#22d3ee;font-family:monospace;font-size:13px;text-shadow:0 0 6px #22d3ee;"
);
