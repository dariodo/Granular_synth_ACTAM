// ============================
// script.js (MAIN THREAD)
// ============================
// - AudioContext, master volume
// - Caricamento file e invio buffer mono al Worklet
// - UI completa con parametri per-cursore (A/B)
// - Freeze come pulsante: imposta scanSpeed = 0 per il cursore selezionato
// - Waveform + markers A/B
// - Compatibile con worklet/granular-processor.js (versione per-cursore)

// Stato audio
let audioCtx;
let masterGain;
let workletNode;            // AudioWorkletNode (granular-processor)
let audioBuffer = null;     // Per waveform
let monoData = null;        // Float32Array mono (inviato al worklet)
let isPlaying = false;

// Cursori A/B (posizioni normalizzate 0..1)
let positions = [0.15, 0.65];
let activeCursor = 0;       // 0 = A, 1 = B

// Helper DOM
const $ = (id) => document.getElementById(id);

// ============================
// Parametri per-cursore (A/B)
// ============================
// Manteniamo un set completo di parametri per ciascun cursore.
// La UI mostra sempre i valori del cursore attivo; gli slider aggiornano SOLO quel cursore.
const defaultCursorParams = () => ({
  attack: parseFloat(($("attackRange") || {}).value) || 0.1,
  release: parseFloat(($("releaseRange") || {}).value) || 0.1,
  density: parseFloat(($("densityRange") || {}).value) || 10,
  spread: parseFloat(($("spreadRange") || {}).value) || 0.1,
  pan: parseFloat(($("panRange") || {}).value) || 0,
  pitch: parseFloat(($("pitchRange") || {}).value) || 1,
  cutoff: parseFloat(($("filterCutoffRange") || {}).value) || 5000,
  lfoFreq: parseFloat(($("lfoFreqRange") || {}).value) || 1,
  lfoDepth: parseFloat(($("lfoDepthRange") || {}).value) || 0.2,
  scanSpeed: parseFloat(($("scanSpeedRange") || {}).value) || 0.01,
});

let cursorParams = [ defaultCursorParams(), defaultCursorParams() ];

// ============================
// Bootstrap Audio + Worklet
// ============================
async function ensureAudio() {
  if (audioCtx) return;

  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  // Master gain (volume globale)
  masterGain = audioCtx.createGain();
  masterGain.gain.value = parseFloat(($("volumeRange") || {}).value) || 0.5;
  masterGain.connect(audioCtx.destination);

  // Carica il modulo del Worklet
  await audioCtx.audioWorklet.addModule("worklet/granular-processor.js");

  // Crea il WorkletNode (stereo)
  workletNode = new AudioWorkletNode(audioCtx, "granular-processor", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: {
      sampleRate: audioCtx.sampleRate
    }
  });

  workletNode.connect(masterGain);

  // Eventuali log dal processor (opzionale)
  workletNode.port.onmessage = (e) => {
    if (e.data?.type === "log") {
      // console.log("[worklet]", e.data.msg);
    }
  };

  // Invia parametri iniziali per entrambi i cursori e posizioni
  sendAllCursorParams();
  sendPositions();
}

// ============================
// Caricamento file audio
// ============================
$("audioFileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await ensureAudio();

  const arrayBuffer = await file.arrayBuffer();
  audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

  // Downmix a mono per la sintesi nel processor
  monoData = downmixToMono(audioBuffer);

  // Invia il buffer al worklet (transfer ownership)
  workletNode.port.postMessage(
    {
      type: "setBuffer",
      sampleRate: audioBuffer.sampleRate,
      mono: monoData.buffer
    },
    [monoData.buffer]
  );

  // Nota: dopo il transfer, monoData.buffer è "detached".
  // Se ti serve ancora una copia locale, la ricrei:
  monoData = downmixToMono(audioBuffer);

  // Disegna waveform
  drawWaveform(audioBuffer);

  // Allinea lo slider Position al cursore attivo
  $("positionRange").value = positions[activeCursor];

  // Reinvia parametri e posizioni (idempotente)
  sendAllCursorParams();
  sendPositions();
});

// Downmix helper (n-canali -> mono)
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

// ============================
// Play / Stop / Freeze button
// ============================
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

// Freeze come PULSANTE: imposta scanSpeed = 0 per il cursore selezionato
$("freezeBtn").addEventListener("click", () => {
  cursorParams[activeCursor].scanSpeed = 0;
  $("scanSpeedRange").value = "0";
  sendParamsForActiveCursor();
});

// ============================
// UI → parametri per-cursore
// ============================
const perCursorSliderIds = [
  "attackRange","releaseRange","densityRange","spreadRange","panRange",
  "pitchRange","filterCutoffRange","lfoFreqRange","lfoDepthRange","scanSpeedRange"
];

// Ogni slider aggiorna SOLO i params del cursore attivo e li invia al worklet
perCursorSliderIds.forEach((id) => {
  $(id).addEventListener("input", () => {
    cursorParams[activeCursor] = {
      ...cursorParams[activeCursor],
      attack: parseFloat($("attackRange").value),
      release: parseFloat($("releaseRange").value),
      density: parseFloat($("densityRange").value),
      spread: parseFloat($("spreadRange").value),
      pan: parseFloat($("panRange").value),
      pitch: parseFloat($("pitchRange").value),
      cutoff: parseFloat($("filterCutoffRange").value),
      lfoFreq: parseFloat($("lfoFreqRange").value),
      lfoDepth: parseFloat($("lfoDepthRange").value),
      scanSpeed: parseFloat($("scanSpeedRange").value),
    };
    sendParamsForActiveCursor();
  });
});

// Volume master (main thread)
$("volumeRange").addEventListener("input", (e) => {
  const v = parseFloat(e.target.value);
  if (masterGain) masterGain.gain.value = v;
});

// ============================
// Gestione cursori A/B
// ============================

// Invia posizioni A/B al worklet
function sendPositions() {
  if (!workletNode) return;
  workletNode.port.postMessage({ type: "setPositions", positions });
}

// Invia i parametri di ENTRAMBI i cursori
function sendAllCursorParams() {
  if (!workletNode) return;
  workletNode.port.postMessage({
    type: "setParamsAll",
    paramsA: cursorParams[0],
    paramsB: cursorParams[1]
  });
}

// Invia i parametri del cursore attivo
function sendParamsForActiveCursor() {
  if (!workletNode) return;
  workletNode.port.postMessage({
    type: "setParamsFor",
    cursor: activeCursor,
    params: cursorParams[activeCursor]
  });
}

// Cambio cursore dalla tendina: ricarica la UI con i suoi parametri
$("positionTarget").addEventListener("change", (e) => {
  activeCursor = parseInt(e.target.value, 10) || 0;
  const p = cursorParams[activeCursor];
  $("attackRange").value = p.attack;
  $("releaseRange").value = p.release;
  $("densityRange").value = p.density;
  $("spreadRange").value = p.spread;
  $("panRange").value = p.pan;
  $("pitchRange").value = p.pitch;
  $("filterCutoffRange").value = p.cutoff;
  $("lfoFreqRange").value = p.lfoFreq;
  $("lfoDepthRange").value = p.lfoDepth;
  $("scanSpeedRange").value = p.scanSpeed;

  $("positionRange").value = positions[activeCursor];
});

// Slider Position → muove SOLO il cursore selezionato
$("positionRange").addEventListener("input", (e) => {
  positions[activeCursor] = clamp01(parseFloat(e.target.value));
  drawWaveform(audioBuffer);
  sendPositions();
});

// Click sul canvas → sposta il cursore più vicino al click
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

// ============================
// Waveform + markers A/B
// ============================
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

  // Disegno waveform (min/max per colonna)
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

  // Marker A (rosso pieno) e B (blu tratteggiato)
  drawMarker(ctx, canvas, positions[0], "#e63946", "A");
  drawMarker(ctx, canvas, positions[1], "#1d3557", "B");
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

  // etichetta
  ctx.fillStyle = color;
  ctx.fillRect(x - 10, 4, 20, 16);
  ctx.fillStyle = "#fff";
  ctx.font = "12px Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x, 12);
}

// ============================
// Utils
// ============================
function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

// Sblocca AudioContext su primo gesto utente (Safari/iOS)
window.addEventListener("click", async () => {
  if (audioCtx && audioCtx.state === "suspended") {
    try { await audioCtx.resume(); } catch {}
  }
}, { once: true });
