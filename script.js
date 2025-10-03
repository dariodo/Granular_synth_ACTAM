// ============================
// script.js (MAIN THREAD)
// ============================
// Gestisce: AudioContext, caricamento file, UI, waveform con cursori A/B,
// invio buffer e parametri al processor AudioWorklet "granular-processor.js".
// Mantiene tutti i controlli/original features (LFO, filtro, pan, pitch, density, spread, volume, scan, freeze).

let audioCtx;
let masterGain;
let workletNode;        // AudioWorkletNode
let audioBuffer = null; // Per disegno waveform
let monoData = null;    // Float32Array mono da inviare al worklet
let isPlaying = false;

// Cursori A/B in [0..1]
let positions = [0.15, 0.65];
let activeCursor = 0; // 0 = A, 1 = B

const $ = (id) => document.getElementById(id);

// -----------------------------
// Inizializzazione AudioContext
// -----------------------------
async function ensureAudio() {
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Master Gain (Volume globale)
  masterGain = audioCtx.createGain();
  masterGain.gain.value = parseFloat($("volumeRange").value || "0.5");
  masterGain.connect(audioCtx.destination);

  // Carica il modulo Worklet
  await audioCtx.audioWorklet.addModule("worklet/granular-processor.js");

  // Crea il WorkletNode
  workletNode = new AudioWorkletNode(audioCtx, "granular-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      sampleRate: audioCtx.sampleRate
    }
  });
  workletNode.connect(masterGain);

  // Opzionale: log dal processor
  workletNode.port.onmessage = (e) => {
    if (e.data?.type === "log") {
      // console.log("[worklet]", e.data.msg);
    }
  };

  // Parametri iniziali → worklet
  syncAllParamsToWorklet();
  sendPositions();
}

// -----------------------------
// Caricamento file audio
// -----------------------------
$("audioFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await ensureAudio();

  const arrayBuffer = await file.arrayBuffer();
  audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  // Downmix a mono per la granular synthesis nel processor
  monoData = downmixToMono(audioBuffer);

  // Invia il buffer mono al worklet (transfer ownership per efficienza)
  workletNode.port.postMessage(
    {
      type: "setBuffer",
      sampleRate: audioBuffer.sampleRate,
      mono: monoData.buffer
    },
    [monoData.buffer]
  );

  // Dopo il transfer, monoData.buffer è "detached"; ricreiamo monoData per uso locale se servisse
  monoData = downmixToMono(audioBuffer);

  // Disegna waveform iniziale
  drawWaveform(audioBuffer);

  // Allinea slider Position al cursore attivo
  $("positionRange").value = positions[activeCursor];

  // Reinvia posizioni (già fatto in ensureAudio, ma ribadiamo)
  sendPositions();
});

// Downmix helper
function downmixToMono(buf) {
  const n = buf.length;
  const chs = buf.numberOfChannels;
  const out = new Float32Array(n);
  for (let ch = 0; ch < chs; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      out[i] += data[i] / chs;
    }
  }
  return out;
}

// -----------------------------
// Play / Stop / Freeze
// -----------------------------
$("playButton").addEventListener("click", async () => {
  await ensureAudio();
  if (!audioBuffer) return;
  if (audioCtx.state === "suspended") await audioCtx.resume();
  isPlaying = true;
  workletNode.port.postMessage({ type: "setPlaying", value: true });
});

$("stopButton").addEventListener("click", () => {
  isPlaying = false;
  workletNode.port.postMessage({ type: "setPlaying", value: false });
});

$("freezeCheckbox").addEventListener("change", (e) => {
  workletNode?.port.postMessage({ type: "setFreeze", value: e.target.checked });
});

// -----------------------------
// Sincronizzazione Parametri UI → Worklet
// -----------------------------
function syncAllParamsToWorklet() {
  if (!workletNode) return;

  const params = {
    attack: parseFloat($("attackRange").value),
    release: parseFloat($("releaseRange").value),
    density: parseFloat($("densityRange").value),
    spread: parseFloat($("spreadRange").value),
    pan: parseFloat($("panRange").value),
    pitch: parseFloat($("pitchRange").value),
    cutoff: parseFloat($("filterCutoffRange").value),
    lfoFreq: parseFloat($("lfoFreqRange").value),
    lfoDepth: parseFloat($("lfoDepthRange").value),
    scanSpeed: parseFloat($("scanSpeedRange").value)
  };

  workletNode.port.postMessage({ type: "setParams", params });
}

// Aggiorna parametri a ogni input
[
  "attackRange",
  "releaseRange",
  "densityRange",
  "spreadRange",
  "panRange",
  "pitchRange",
  "filterCutoffRange",
  "lfoFreqRange",
  "lfoDepthRange",
  "scanSpeedRange"
].forEach((id) => {
  $(id).addEventListener("input", () => {
    syncAllParamsToWorklet();
  });
});

// Volume master (sul main thread)
$("volumeRange").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  if (masterGain) masterGain.gain.value = v;
});

// -----------------------------
// Gestione posizioni cursori A/B
// -----------------------------
function sendPositions() {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: "setPositions", positions });
}

// Tendina A/B → cambia cursore attivo
$("positionTarget").addEventListener("change", (e) => {
  activeCursor = parseInt(e.target.value, 10) || 0;
  $("positionRange").value = positions[activeCursor];
});

// Slider Position → muove solo il cursore attivo
$("positionRange").addEventListener("input", (e) => {
  positions[activeCursor] = clamp01(parseFloat(e.target.value));
  drawWaveform(audioBuffer);
  sendPositions();
});

// Click sul canvas → sposta il cursore più vicino
$("waveformCanvas").addEventListener("click", (e) => {
  if (!audioBuffer) return;
  const canvas = $("waveformCanvas");
  const rect = canvas.getBoundingClientRect();
  const xNorm = (e.clientX - rect.left) / canvas.width;

  const dA = Math.abs(xNorm - positions[0]);
  const dB = Math.abs(xNorm - positions[1]);
  const chosen = dA <= dB ? 0 : 1;

  positions[chosen] = clamp01(xNorm);
  activeCursor = chosen;

  $("positionTarget").value = String(activeCursor);
  $("positionRange").value = positions[activeCursor];

  drawWaveform(audioBuffer);
  sendPositions();
});

// -----------------------------
// Disegno waveform + markers A/B
// -----------------------------
function drawWaveform(buffer) {
  if (!buffer) return;
  const canvas = $("waveformCanvas");
  const ctx = canvas.getContext("2d");
  const data = buffer.getChannelData(0);
  const step = Math.ceil(data.length / canvas.width);
  const amp = canvas.height / 2;

  // Sfondo
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Waveform (min/max)
  ctx.beginPath();
  ctx.moveTo(0, amp);
  for (let i = 0; i < canvas.width; i++) {
    const start = i * step;
    const end = Math.min((i + 1) * step, data.length);
    let min = 1, max = -1;
    for (let j = start; j < end; j++) {
      const v = data[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    ctx.lineTo(i, (1 + min) * amp);
    ctx.lineTo(i, (1 + max) * amp);
  }
  ctx.strokeStyle = "lime";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Marker A/B
  drawMarker(ctx, canvas, positions[0], "#e63946", "A"); // rosso
  drawMarker(ctx, canvas, positions[1], "#1d3557", "B"); // blu
}

function drawMarker(ctx, canvas, posNorm, color, label) {
  const x = posNorm * canvas.width;

  // linea verticale
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(label === "A" ? [] : [5, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // bandierina/etichetta
  ctx.fillStyle = color;
  ctx.fillRect(x - 10, 4, 20, 16);
  ctx.fillStyle = "#fff";
  ctx.font = "12px Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x, 12);
}

// -----------------------------
// Utils
// -----------------------------
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// -----------------------------
// Avvio lazy: prepara AudioContext al primo gesto
// -----------------------------
window.addEventListener("click", async () => {
  // Sblocca AudioContext su iOS/Safari se necessario
  if (audioCtx && audioCtx.state === "suspended") {
    try { await audioCtx.resume(); } catch {}
  }
}, { once: true });
